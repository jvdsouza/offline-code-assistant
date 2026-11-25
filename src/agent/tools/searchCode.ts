import { Retriever } from "../../retrieval/retriever.js";
import { defineTool, int, str } from "./types.js";

export const searchCode = defineTool(
  "search_code",
  "Semantic search over the indexed repository. Use natural language describing behaviour or concepts " +
    "(e.g. 'where are HTTP requests retried'). Returns the most relevant code chunks with file paths and line numbers.",
  {
    query: { type: "string", description: "What you are looking for, in natural language." },
    k: { type: "integer", description: "Number of results (default 8, max 20)." },
    path_prefix: { type: "string", description: "Optional: only search under this directory, e.g. 'src/api/'." },
  },
  ["query"],
  async (args, ctx) => {
    const hits = await ctx.retriever.retrieve(str(args.query), {
      k: Math.min(int(args.k, 8), 20),
      pathPrefix: str(args.path_prefix) || undefined,
      minScore: 0,
    });
    return Retriever.format(hits);
  },
);
