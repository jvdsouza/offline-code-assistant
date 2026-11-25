import fs from "node:fs/promises";
import { walkRepo } from "../../ingest/walker.js";
import { resolveInRepo } from "../../util/paths.js";
import { defineTool, int, str } from "./types.js";

const MAX_READ_LINES = 400;

export const readFile = defineTool(
  "read_file",
  "Read a file from the repository, with line numbers. Use start_line/end_line for large files.",
  {
    path: { type: "string", description: "Repo-relative path, e.g. 'src/index.ts'." },
    start_line: { type: "integer", description: "1-based first line (default 1)." },
    end_line: { type: "integer", description: `Last line, inclusive (default start_line + ${MAX_READ_LINES - 1}).` },
  },
  ["path"],
  async (args, ctx) => {
    const { abs, rel } = resolveInRepo(ctx.root, str(args.path));
    const lines = (await fs.readFile(abs, "utf8")).split(/\r?\n/);
    const start = Math.max(1, int(args.start_line, 1));
    const end = Math.min(lines.length, int(args.end_line, start + MAX_READ_LINES - 1), start + MAX_READ_LINES - 1);
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(5)}  ${l}`)
      .join("\n");
    const more = end < lines.length ? `\n... (${lines.length - end} more lines; call again with start_line=${end + 1})` : "";
    return `${rel} (lines ${start}-${end} of ${lines.length})\n${body}${more}`;
  },
);

export const listFiles = defineTool(
  "list_files",
  "List indexable source files in the repository (respects .gitignore).",
  {
    dir: { type: "string", description: "Optional directory prefix, e.g. 'src/'." },
    contains: { type: "string", description: "Optional substring the path must contain, e.g. '.test.' or 'auth'." },
  },
  [],
  async (args, ctx) => {
    const dir = str(args.dir).replace(/^\.?\/?/, "");
    const needle = str(args.contains);
    const files = (await walkRepo(ctx.root)).filter((f) => f.startsWith(dir) && (!needle || f.includes(needle)));
    const shown = files.slice(0, 300);
    return files.length ? shown.join("\n") + (files.length > shown.length ? `\n... and ${files.length - shown.length} more` : "") : "No files matched.";
  },
);

export const grep = defineTool(
  "grep",
  "Exact text / regex search across repository files. Best for finding a known identifier, string or import. " +
    "Complements search_code, which is semantic.",
  {
    pattern: { type: "string", description: "JavaScript regular expression (case-sensitive)." },
    path_contains: { type: "string", description: "Optional substring to filter file paths, e.g. 'src/' or '.tsx'." },
  },
  ["pattern"],
  async (args, ctx) => {
    let re: RegExp;
    try {
      re = new RegExp(str(args.pattern));
    } catch (e) {
      return `Invalid regex: ${(e as Error).message}`;
    }
    const filter = str(args.path_contains);
    const results: string[] = [];
    for (const rel of await walkRepo(ctx.root)) {
      if (filter && !rel.includes(filter)) continue;
      const text = await fs.readFile(resolveInRepo(ctx.root, rel).abs, "utf8").catch(() => "");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (results.length >= 60) return results.join("\n") + "\n... (truncated at 60 matches)";
        }
      }
    }
    return results.length ? results.join("\n") : "No matches.";
  },
);
