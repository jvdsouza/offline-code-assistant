import os from "node:os";
import path from "node:path";

// Load .env from the current working directory if present (Node >= 20.12).
try {
  process.loadEnvFile();
} catch {
  /* no .env — fine */
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  ollamaHost: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
  chatModel: process.env.OCA_CHAT_MODEL ?? "qwen2.5-coder:7b",
  embedModel: process.env.OCA_EMBED_MODEL ?? "nomic-embed-text",
  numCtx: num("OCA_NUM_CTX", 16384),
  temperature: num("OCA_TEMPERATURE", 0.2),
  dataDir: expandHome(process.env.OCA_DATA_DIR ?? "~/.offline-code-assistant"),
  topK: num("OCA_TOP_K", 8),
  maxAgentSteps: num("OCA_MAX_AGENT_STEPS", 12),

  ingest: {
    /** File extensions that get indexed. TypeScript-first; others use line-window chunking. */
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md"],
    /** Soft cap on chunk size in characters (~4 chars/token). */
    maxChunkChars: 2400,
    /** Files larger than this are skipped (generated/bundled code). */
    maxFileBytes: 512 * 1024,
    /** Always ignored, in addition to .gitignore. */
    alwaysIgnore: [
      "node_modules/",
      "dist/",
      "build/",
      "out/",
      "coverage/",
      ".git/",
      ".next/",
      ".turbo/",
      ".oca/",
      "*.min.js",
      "*.map",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ],
    embedBatchSize: 32,
  },
} as const;

export type Config = typeof config;
