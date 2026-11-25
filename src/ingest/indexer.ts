import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { LLM } from "../llm/ollama.js";
import { VectorStore, type ChunkRow, type SearchHit } from "../store/vectorStore.js";
import { chunkFile, embeddingText, type Chunk } from "./chunker.js";
import { walkRepo } from "./walker.js";

interface Manifest {
  embedModel: string;
  files: Record<string, string>; // relPath -> sha1
}

export interface IndexStats {
  scanned: number;
  updated: number;
  removed: number;
  chunks: number;
}

export type ProgressFn = (msg: string) => void;

/**
 * The RAG index for one repository. Indexing is incremental: files are hashed
 * and only new/changed files are re-chunked and re-embedded.
 */
export class RepoIndex {
  private constructor(
    readonly root: string,
    readonly dir: string,
    private store: VectorStore,
    private manifest: Manifest,
    private llm: LLM,
  ) {}

  static async open(root: string, llm = new LLM()): Promise<RepoIndex> {
    const abs = path.resolve(root);
    const id = crypto.createHash("sha1").update(abs.toLowerCase()).digest("hex").slice(0, 10);
    const dir = path.join(config.dataDir, `${path.basename(abs)}-${id}`);
    await fs.mkdir(dir, { recursive: true });

    const manifest: Manifest = await fs
      .readFile(path.join(dir, "manifest.json"), "utf8")
      .then((s) => JSON.parse(s) as Manifest)
      .catch(() => ({ embedModel: llm.embedModel, files: {} }));

    const store = await VectorStore.open(path.join(dir, "lancedb"));
    const index = new RepoIndex(abs, dir, store, manifest, llm);

    // Vectors from different embedding models are not comparable — start over.
    if (manifest.embedModel !== llm.embedModel) {
      await store.reset();
      index.manifest = { embedModel: llm.embedModel, files: {} };
    }
    return index;
  }

  /** Bring the index in line with the working tree. */
  async sync(onProgress: ProgressFn = () => {}, opts: { full?: boolean } = {}): Promise<IndexStats> {
    if (opts.full) {
      await this.store.reset();
      this.manifest.files = {};
    }
    const files = await walkRepo(this.root);
    const seen = new Set(files);
    const removed = Object.keys(this.manifest.files).filter((f) => !seen.has(f));

    const changed: { rel: string; text: string; hash: string }[] = [];
    for (const rel of files) {
      const abs = path.join(this.root, rel);
      const stat = await fs.stat(abs);
      if (stat.size > config.ingest.maxFileBytes) continue;
      const text = await fs.readFile(abs, "utf8");
      const hash = sha1(text);
      if (this.manifest.files[rel] !== hash) changed.push({ rel, text, hash });
    }

    onProgress(`${files.length} files scanned, ${changed.length} changed, ${removed.length} removed`);
    await this.store.deleteByPaths([...removed, ...changed.map((c) => c.rel)]);
    for (const r of removed) delete this.manifest.files[r];

    const chunks = await this.embedAndStore(changed, onProgress);
    for (const c of changed) this.manifest.files[c.rel] = c.hash;
    await this.saveManifest();

    return { scanned: files.length, updated: changed.length, removed: removed.length, chunks };
  }

  /** Re-index specific files (e.g. right after the agent edits them). */
  async updateFiles(relPaths: string[]): Promise<void> {
    const items: { rel: string; text: string; hash: string }[] = [];
    const gone: string[] = [];
    for (const rel of relPaths) {
      const text = await fs.readFile(path.join(this.root, rel), "utf8").catch(() => null);
      if (text === null) gone.push(rel);
      else items.push({ rel, text, hash: sha1(text) });
    }
    await this.store.deleteByPaths(relPaths);
    await this.embedAndStore(items, () => {});
    for (const g of gone) delete this.manifest.files[g];
    for (const i of items) this.manifest.files[i.rel] = i.hash;
    await this.saveManifest();
  }

  async search(query: string, k = config.topK, pathPrefix?: string): Promise<SearchHit[]> {
    const vector = await this.llm.embedQuery(query);
    return this.store.search(vector, k, pathPrefix);
  }

  async chunkCount(): Promise<number> {
    return this.store.count();
  }

  private async embedAndStore(files: { rel: string; text: string }[], onProgress: ProgressFn): Promise<number> {
    const all: Chunk[] = files.flatMap((f) => chunkFile(f.rel, f.text));
    const batch = config.ingest.embedBatchSize;
    for (let i = 0; i < all.length; i += batch) {
      const slice = all.slice(i, i + batch);
      const vectors = await this.llm.embedDocuments(slice.map(embeddingText));
      const rows: ChunkRow[] = slice.map((c, j) => ({
        id: `${c.path}#L${c.startLine}-${c.endLine}`,
        path: c.path,
        language: c.language,
        kind: c.kind,
        symbol: c.symbol,
        start_line: c.startLine,
        end_line: c.endLine,
        text: c.text,
        vector: vectors[j],
      }));
      await this.store.add(rows);
      onProgress(`embedded ${Math.min(i + batch, all.length)}/${all.length} chunks`);
    }
    return all.length;
  }

  private async saveManifest(): Promise<void> {
    await fs.writeFile(path.join(this.dir, "manifest.json"), JSON.stringify(this.manifest, null, 2));
  }
}

function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}
