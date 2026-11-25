import path from "node:path";

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Resolves a model-supplied path against the repo root and refuses anything that
 * escapes it. Every tool that touches the filesystem must go through this.
 */
export function resolveInRepo(root: string, userPath: string): { abs: string; rel: string } {
  const abs = path.resolve(root, userPath.replace(/^[/\\]+/, ""));
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${userPath}" is outside the repository.`);
  }
  return { abs, rel: toPosix(rel) };
}
