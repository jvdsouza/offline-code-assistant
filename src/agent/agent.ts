import path from "node:path";
import { config } from "../config.js";
import type { RepoIndex } from "../ingest/indexer.js";
import { LLM, type Message } from "../llm/ollama.js";
import { Retriever } from "../retrieval/retriever.js";
import { systemPrompt, withRetrievedContext } from "./prompts.js";
import { allTools, type AgentTool, type ToolContext } from "./tools/index.js";

export interface AgentEvents {
  onToken?(text: string): void;
  onToolCall?(name: string, args: Record<string, unknown>): void;
  onToolResult?(name: string, result: string): void;
}

const MAX_TOOL_RESULT_CHARS = 8000;

/**
 * The agent loop:
 *   1. RAG: retrieve chunks relevant to the user's message and attach them.
 *   2. Ask the model; if it calls tools, run them and feed results back.
 *   3. Repeat until the model answers without tool calls (or the step limit).
 */
export class Agent {
  private messages: Message[];
  private retriever: Retriever;
  private tools: Map<string, AgentTool>;

  constructor(
    private index: RepoIndex,
    private io: Pick<ToolContext, "confirm" | "print">,
    private llm = new LLM(),
    tools: AgentTool[] = allTools,
  ) {
    this.retriever = new Retriever(index);
    this.tools = new Map(tools.map((t) => [t.definition.function.name!, t]));
    this.messages = [{ role: "system", content: systemPrompt(path.basename(index.root)) }];
  }

  reset(): void {
    this.messages = this.messages.slice(0, 1);
  }

  async run(userInput: string, ev: AgentEvents = {}): Promise<string> {
    const hits = await this.retriever.retrieve(userInput, { k: config.topK });
    const userMsg: Message = { role: "user", content: withRetrievedContext(userInput, Retriever.format(hits)) };
    this.messages.push(userMsg);

    const ctx: ToolContext = { root: this.index.root, index: this.index, retriever: this.retriever, ...this.io };
    const toolDefs = [...this.tools.values()].map((t) => t.definition);

    try {
      for (let step = 0; step < config.maxAgentSteps; step++) {
        const reply = await this.llm.chat(this.trimmedHistory(), { tools: toolDefs, onToken: ev.onToken });
        this.messages.push(reply);
        if (!reply.tool_calls?.length) return reply.content;

        for (const call of reply.tool_calls) {
          const { name, arguments: args } = call.function;
          ev.onToolCall?.(name, args);
          const tool = this.tools.get(name);
          let result: string;
          try {
            result = tool ? await tool.run(args ?? {}, ctx) : `Error: unknown tool "${name}".`;
          } catch (e) {
            result = `Error: ${(e as Error).message}`;
          }
          if (result.length > MAX_TOOL_RESULT_CHARS) result = result.slice(0, MAX_TOOL_RESULT_CHARS) + "\n... (truncated)";
          ev.onToolResult?.(name, result);
          this.messages.push({ role: "tool", tool_name: name, content: result });
        }
      }
      return "(Stopped: reached the maximum number of agent steps. Ask me to continue if needed.)";
    } finally {
      // Keep history lean: the retrieved context was only needed for this turn.
      userMsg.content = userInput;
    }
  }

  /**
   * Very simple context management: if the conversation is getting too long for
   * num_ctx, drop the oldest turns (never the system prompt or the current turn).
   */
  private trimmedHistory(): Message[] {
    const budget = config.numCtx * 3; // ~3 chars per token, leaves room for the reply
    const size = (m: Message) => m.content.length + JSON.stringify(m.tool_calls ?? "").length;
    const [system, ...rest] = this.messages;
    let total = rest.reduce((n, m) => n + size(m), size(system));
    let start = 0;
    const lastUser = rest.findLastIndex((m) => m.role === "user");
    while (total > budget && start < lastUser) {
      total -= size(rest[start]);
      start++;
    }
    // Don't start on an orphaned tool result.
    while (start < rest.length && rest[start].role === "tool") start++;
    return [system, ...rest.slice(start)];
  }
}
