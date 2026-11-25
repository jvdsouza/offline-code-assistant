import fs from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { config } from "../config.js";
import { toPosix } from "../util/paths.js";

/**
 * Recursively lists indexable files under `root`, honouring .gitignore files
 * (root and nested) plus the built-in ignore list. Returns repo-relative POSIX paths.
 */
export async function walkRepo(root: string): Promise<string[]> {
  const out: string[] = [];
  const base = ignore().add(config.ingest.alwaysIgnore as unknown as string[]);
  await walk(root, "", [{ dir: "", ig: base }]);
  return out.sort();

  async function walk(abs: string, rel: string, scopes: { dir: string; ig: Ignore }[]): Promise<void> {
    // Pick up a .gitignore in this directory, scoped to it.
    const gi = await fs.readFile(path.join(abs, ".gitignore"), "utf8").catch(() => null);
    if (gi) scopes = [...scopes, { dir: rel, ig: ignore().add(gi) }];

    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      if (isIgnored(scopes, childRel, isDir)) continue;

      if (isDir) {
        await walk(path.join(abs, e.name), childRel, scopes);
      } else if (e.isFile() && config.ingest.extensions.some((x) => e.name.endsWith(x))) {
        out.push(toPosix(childRel));
      }
    }
  }
}

function isIgnored(scopes: { dir: string; ig: Ignore }[], rel: string, isDir: boolean): boolean {
  for (const { dir, ig } of scopes) {
    const sub = dir ? rel.slice(dir.length + 1) : rel;
    if (!sub) continue;
    if (ig.ignores(isDir ? `${sub}/` : sub)) return true;
  }
  return false;
}
