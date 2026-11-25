import { Ollama, type Message, type Tool, type ToolCall } from "ollama";
import { config } from "../config.js";

export type { Message, Tool, ToolCall };

/**
 * Thin wrapper around the Ollama client. Everything that talks to the LLM goes
 * through here, so swapping models/hosts (or the provider) is a one-file change.
 */
export class LLM {
  readonly client: Ollama;

  constructor(
    readonly chatModel = config.chatModel,
    readonly embedModel = config.embedModel,
    host = config.ollamaHost,
  ) {
    this.client = new Ollama({ host });
  }

  /**
   * Embed documents (code chunks). nomic-embed-text is trained with task
   * prefixes; using them noticeably improves retrieval quality.
   */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts.map((t) => this.prefix("document") + t));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [v] = await this.embed([this.prefix("query") + text]);
    return v;
  }

  private prefix(kind: "document" | "query"): string {
    if (!this.embedModel.startsWith("nomic-embed-text")) return "";
    return kind === "document" ? "search_document: " : "search_query: ";
  }

  private async embed(input: string[]): Promise<number[][]> {
    const res = await this.client.embed({ model: this.embedModel, input, truncate: true });
    return res.embeddings;
  }

  /**
   * Streaming chat with optional tools. Calls `onToken` for visible content and
   * returns the fully assembled assistant message (including any tool calls).
   */
  async chat(
    messages: Message[],
    opts: { tools?: Tool[]; onToken?: (t: string) => void } = {},
  ): Promise<Message> {
    const stream = await this.client.chat({
      model: this.chatModel,
      messages,
      tools: opts.tools,
      stream: true,
      options: { num_ctx: config.numCtx, temperature: config.temperature },
    });

    let content = "";
    const toolCalls: ToolCall[] = [];
    // Some local models emit tool calls as raw JSON in `content` instead of the
    // structured field. Hold back output that looks like JSON so we can parse it.
    let holdBack: boolean | undefined;

    for await (const part of stream) {
      const m = part.message;
      if (m.tool_calls?.length) toolCalls.push(...m.tool_calls);
      if (m.content) {
        content += m.content;
        if (holdBack === undefined && content.trim().length > 0) {
          // Streams often deliver "```" and "json" as separate tokens, so hold back any fence.
          holdBack = /^\s*(\{|```|<tool_call>)/.test(content);
        }
        if (holdBack === false) opts.onToken?.(m.content);
      }
    }

    if (toolCalls.length === 0 && opts.tools?.length) {
      const parsed = parseInlineToolCalls(content, opts.tools);
      if (parsed.length) return { role: "assistant", content: "", tool_calls: parsed };
    }
    if (holdBack) opts.onToken?.(content);
    return { role: "assistant", content, tool_calls: toolCalls.length ? toolCalls : undefined };
  }

  /** Returns names of locally available models (used by `oca doctor`). */
  async listModels(): Promise<string[]> {
    const res = await this.client.list();
    return res.models.map((m) => m.name);
  }
}

/**
 * Fallback parser for models (e.g. qwen2.5-coder) that write tool calls as text:
 * a bare JSON object, a ```json fenced block (often after some prose), or
 * <tool_call>…</tool_call> tags. Only calls naming a known tool are accepted.
 */
export function parseInlineToolCalls(content: string, tools: Tool[]): ToolCall[] {
  const known = new Set(tools.map((t) => t.function.name));

  const blocks: string[] = [];
  for (const m of content.matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)) blocks.push(m[1]);
  for (const m of content.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) blocks.push(m[1]);
  if (!blocks.length) blocks.push(content);

  const candidates: unknown[] = [];
  for (const raw of blocks) {
    const body = raw.replace(/```(?:json)?/g, "").trim();
    if (!body.startsWith("{") && !body.startsWith("[")) continue;
    try {
      const v = JSON.parse(body);
      candidates.push(...(Array.isArray(v) ? v : [v]));
    } catch {
      // Possibly several JSON objects separated by newlines.
      for (const line of body.split(/\n(?=\s*\{)/)) {
        try {
          candidates.push(JSON.parse(line));
        } catch {
          /* ignore */
        }
      }
    }
  }

  const calls: ToolCall[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const name = (o.name ?? (o.function as Record<string, unknown> | undefined)?.name) as string | undefined;
    let args = o.arguments ?? o.parameters ?? (o.function as Record<string, unknown> | undefined)?.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (name && known.has(name)) calls.push({ function: { name, arguments: args as Record<string, unknown> } });
  }
  return calls;
}
