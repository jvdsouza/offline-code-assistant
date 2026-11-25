import type { RepoIndex } from "../ingest/indexer.js";
import type { SearchHit } from "../store/vectorStore.js";

/** Chunks scoring below this (cosine similarity) are not shown to the model. */
export const DEFAULT_MIN_SCORE = 0.3;

/**
 * Retrieval step of RAG. Kept separate from the index so it is the obvious place
 * to add reranking, hybrid (keyword + vector) search, MMR de-duplication, etc.
 */
export class Retriever {
  constructor(private index: RepoIndex) {}

  async retrieve(query: string, opts: { k?: number; pathPrefix?: string; minScore?: number } = {}): Promise<SearchHit[]> {
    const hits = await this.index.search(query, opts.k, opts.pathPrefix);
    const min = opts.minScore ?? DEFAULT_MIN_SCORE;
    return hits.filter((h) => h.score >= min);
  }

  /** Render hits as a compact context block for the LLM. */
  static format(hits: SearchHit[]): string {
    if (!hits.length) return "No relevant code found in the index.";
    return hits
      .map((h) => {
        const label = h.symbol ? ` (${h.kind} ${h.symbol})` : "";
        const fence = h.language === "markdown" ? "md" : h.language === "json" ? "json" : "ts";
        return `### ${h.path}:${h.start_line}-${h.end_line}${label}  [score ${h.score.toFixed(2)}]\n\`\`\`${fence}\n${h.text}\n\`\`\``;
      })
      .join("\n\n");
  }
}
