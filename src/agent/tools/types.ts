import type { Tool } from "../../llm/ollama.js";
import type { RepoIndex } from "../../ingest/indexer.js";
import type { Retriever } from "../../retrieval/retriever.js";

export interface ToolContext {
  root: string;
  index: RepoIndex;
  retriever: Retriever;
  /** Ask the human a yes/no question (used before any write). */
  confirm(question: string): Promise<boolean>;
  /** Print something for the human (not sent to the model). */
  print(text: string): void;
}

export interface AgentTool {
  definition: Tool;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** Helper so tool definitions stay terse. */
export function defineTool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string; enum?: string[] }>,
  required: string[],
  run: AgentTool["run"],
): AgentTool {
  return {
    definition: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } },
    run,
  };
}

export const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : v == null ? fallback : String(v));
export const int = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : parseInt(str(v), 10);
  return Number.isFinite(n) ? n : fallback;
};
