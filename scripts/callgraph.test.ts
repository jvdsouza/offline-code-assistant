import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractCallGraph, type CallGraph } from "./callgraph.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let g: CallGraph;
const edge = (from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);

describe("extractCallGraph (on this repo)", () => {
  beforeAll(() => {
    g = extractCallGraph(path.join(root, "tsconfig.json"));
  }, 60_000);

  it.each([
    ["Agent.run", "Retriever.retrieve"],
    ["Retriever.retrieve", "RepoIndex.search"],
    ["RepoIndex.search", "VectorStore.search"],
    ["RepoIndex.embedAndStore", "chunkFile"],
    ["RepoIndex.embedAndStore", "embeddingText"], // passed by reference to .map()
    ["cli chat", "runTurn"],
    ["makeAgent", "Agent.constructor"], // new Agent(...)
    ["LLM.chat", "ollama"],
    ["VectorStore.search", "@lancedb/lancedb"],
    ["propose_edit", "RepoIndex.updateFiles"], // via ctx.index
  ])("resolves %s → %s", (from, to) => {
    expect(edge(from, to)).toBeDefined();
  });

  it("marks agent → tool calls as dynamic dispatch", () => {
    for (const tool of ["search_code", "grep", "read_file", "list_files", "propose_edit"]) {
      expect(edge("Agent.run", tool)?.dynamic).toBe(true);
    }
  });

  it("excludes test files and the JS standard library", () => {
    expect(g.nodes.some((n) => n.file?.endsWith(".test.ts"))).toBe(false);
    expect(g.nodes.some((n) => n.id === "typescript" && n.kind === "external")).toBe(true);
    expect(g.nodes.map((n) => n.id)).not.toContain("lib");
  });

  it("only has edges between known nodes", () => {
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.from), e.from).toBe(true);
      expect(ids.has(e.to), e.to).toBe(true);
    }
  });
});
