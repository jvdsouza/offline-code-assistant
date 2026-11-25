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

## Evals

The eval suite measures the assistant against a pinned fixture project, `evals/fixtures/taskboard/`: a small TypeScript task API with auth, retries, rate limiting and webhooks. The fixture's answers never change, so scores stay comparable between runs. It needs Ollama running with the configured models.

```bash
npx tsx evals/run.ts retrieval            # recall@1/3/k + MRR of the RAG index (~1 min, no chat model)
npx tsx evals/run.ts answers --runs 3     # full agent; answers graded by rule checks
npx tsx evals/run.ts answers --judge --judge-model <other-model>   # + LLM judge vs. reference answers
npx tsx evals/run.ts agent --runs 2       # tool choice, efficiency, edits in a throwaway copy
npx tsx evals/run.ts all --fail-under 0.8 # everything; exit 1 if any suite scores below 80%
```

| Suite | Cases | Measures | Main metric |
|---|---|---|---|
| `retrieval` | `evals/cases/retrieval.ts` | Whether a relevant chunk is in the top-k, by question type (semantic / identifier / docs / cross-file). It also flags relevant hits that score below the retriever's 0.3 cut-off | recall@k |
| `answers` | `evals/cases/answers.ts` | Final answers: required facts (regex), citations, and optionally a 1–5 judge score (pass = 4 or more) | pass rate over N runs |
| `agent` | `evals/cases/agent.ts` | Required and forbidden tools, a tool-call budget, the step limit. Edit tasks run in a temp copy with approval set to automatic; the resulting file is then checked | pass rate over N runs |

- Each run writes a JSON report to `evals/results/` (gitignored), with every answer, tool sequence and top-k list, so runs can be compared after changing models, chunking or prompts.
- `--filter <text>` runs only matching case ids.
- Use `npx tsx` rather than `npm run eval -- …` in Windows PowerShell (see the note above).
- The judge defaults to the chat model, which scores its own answers too kindly. Pass a different model with `--judge-model`, or set `OCA_JUDGE_MODEL`.
- **Adding a case:** add an object to the relevant file in `evals/cases/`. Retrieval expectations name a path plus an optional `symbol` (as the chunker names it, e.g. `TokenBucket.take`) and/or `contains`. Any listed expectation in the top-k counts as a hit.
- The scoring logic is unit-tested (`evals/lib/scoring.test.ts`) and runs with `npm test`. The eval runs themselves don't, because they need Ollama.

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
