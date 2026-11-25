# offline-code-assistant (`oca`)

A small, fully local coding agent for TypeScript/JavaScript repos.
It uses **RAG** over your codebase (LanceDB + Ollama embeddings) and an **agent loop** with Ollama tool calling.

## Quick start

```bash
# 1. Models (once)
ollama pull qwen2.5-coder:7b
ollama pull nomic-embed-text

# 2. Install
npm install

# 3. Check setup
npm run oca -- doctor

# 4. Index a repo, then chat with it
npm run oca -- index ../some-ts-project
npm run oca -- chat  ../some-ts-project

# One-shot question
npm run oca -- ask "where is authentication handled?" --repo ../some-ts-project
```

In chat you can use `/reset`, `/reindex` and `/exit`.

> **Windows PowerShell 5.1:** PowerShell drops the `--` in `npm run oca -- …`, so npm grabs options like `--repo`.
> Run the CLI directly instead: `npx tsx src/cli.ts ask "…" --repo ../some-ts-project`.
`npm run build` compiles to `dist/`. After `npm link`, the `oca` command is available globally.

## Architecture

```
                ┌──────────────── ingest (oca index) ────────────────┐
 repo files ──► walker.ts ──► chunker.ts ──► LLM.embedDocuments ──► LanceDB
 (.gitignore    (TS AST: one chunk per      (nomic-embed-text)     (~/.offline-code-assistant/<repo>-<hash>/)
  aware)         function/class/interface…)                            ▲
                                                                       │ vector search (cosine)
 ┌──────────────────────── agent loop (oca chat) ──────────────────────┴──────┐
 │ user msg ──► Retriever (top-k chunks) ──► prompt + <retrieved_context>     │
 │          ──► LLM.chat(tools) ──► tool calls? ──► run tool ──► feed back ─┐ │
 │                     ▲                                                    │ │
 │                     └────────────────────────────────────────────────────┘ │
 │          ──► final answer (streamed)                                       │
 └────────────────────────────────────────────────────────────────────────────┘
```

| Path | Responsibility |
|---|---|
| `src/config.ts` | All settings (env / `.env` overrides, see `.env.example`) |
| `src/llm/ollama.ts` | The only module that talks to Ollama: chat (streaming + tools), embeddings, and a fallback parser for models that print tool calls as JSON text |
| `src/ingest/walker.ts` | Lists indexable files, honouring nested `.gitignore` files |
| `src/ingest/chunker.ts` | TypeScript-aware chunking with the TS compiler API. Large classes are split per method; other files use line windows |
| `src/ingest/indexer.ts` | `RepoIndex`: incremental indexing (sha1 manifest), search, and re-indexing after edits |
| `src/store/vectorStore.ts` | LanceDB wrapper |
| `src/retrieval/retriever.ts` | Retrieval and context formatting. This is where to add reranking or hybrid search |
| `src/agent/agent.ts` | Agent loop with automatic RAG per turn, tool execution and history trimming |
| `src/agent/tools/*` | Tools: `search_code`, `grep`, `read_file`, `list_files`, `propose_edit` |
| `src/cli.ts` | `oca index / chat / ask / doctor` |

`npm run callgraph` regenerates the call graph: `docs/callgraph.md` lists every function and method with what it calls and what calls it, and `docs/callgraph.html` is the interactive diagram (open it in a browser).

### Safety
- All tool file paths are resolved inside the repo root (`util/paths.ts`). Paths outside it are refused.
- `propose_edit` shows a coloured diff and writes **only after you answer `y`**. Edited files are re-indexed immediately.

### Adding a tool
Create one with `defineTool(name, description, jsonSchemaProps, required, run)` in `src/agent/tools/` and add it to `allTools` in `src/agent/tools/index.ts`.

## Notes
- **TypeScript pin:** the project uses TypeScript **6.x** on purpose. TypeScript 7 (the native Go port) doesn't expose the JS compiler API (`ts.createSourceFile`) that the chunker relies on.
- **Context window:** Ollama's default `num_ctx` is small. This project sends `OCA_NUM_CTX` (default 16384) with every request. Lower it if you run out of VRAM.
- **Switching embed models:** a different embedding model triggers a full re-index automatically.

## Ideas for next steps
- Hybrid search: LanceDB full-text index + vector search, merged with reciprocal-rank fusion.
- Reranking retrieved chunks with a small local reranker model.
- Symbol graph: use the TS type checker to resolve imports and references (e.g. a "find usages" tool).
- `run_command` tool (e.g. `tsc --noEmit`, `npm test`) with confirmation, so the agent can check its own edits.
- File watcher for live re-indexing, an HTTP/SSE server, or a VS Code extension front-end.
