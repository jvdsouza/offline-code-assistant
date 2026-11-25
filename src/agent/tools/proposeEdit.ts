import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import pc from "picocolors";
import { resolveInRepo } from "../../util/paths.js";
import { defineTool, str } from "./types.js";

export const proposeEdit = defineTool(
  "propose_edit",
  "Propose a change to a file. The user sees a diff and must approve it before anything is written. " +
    "Replace exactly one occurrence of old_string with new_string. To create a new file, pass an empty old_string. " +
    "Always read the file first so old_string matches exactly (including indentation).",
  {
    path: { type: "string", description: "Repo-relative path of the file to change or create." },
    old_string: { type: "string", description: "Exact existing text to replace (must be unique in the file). Empty to create a file." },
    new_string: { type: "string", description: "Replacement text." },
    reason: { type: "string", description: "One sentence explaining the change, shown to the user." },
  },
  ["path", "old_string", "new_string"],
  async (args, ctx) => {
    const { abs, rel } = resolveInRepo(ctx.root, str(args.path));
    const oldStr = str(args.old_string);
    const newStr = str(args.new_string);
    const current = await fs.readFile(abs, "utf8").catch(() => null);

    let next: string;
    if (current === null) {
      if (oldStr) return `Error: ${rel} does not exist. Pass an empty old_string to create it.`;
      next = newStr;
    } else if (!oldStr) {
      return `Error: ${rel} already exists. Provide old_string to edit it.`;
    } else {
      // Tolerate CRLF files when the model sends LF text.
      const eol = current.includes("\r\n") ? "\r\n" : "\n";
      const find = oldStr.replace(/\r?\n/g, eol);
      const occurrences = current.split(find).length - 1;
      if (occurrences === 0) return `Error: old_string not found in ${rel}. Re-read the file and copy the text exactly.`;
      if (occurrences > 1) return `Error: old_string occurs ${occurrences} times in ${rel}. Include more surrounding context.`;
      next = current.replace(find, () => newStr.replace(/\r?\n/g, eol));
    }

    const patch = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, current ?? "", next, "", "", { context: 3 });
    ctx.print(pc.bold(`\nProposed edit to ${rel}`) + (args.reason ? pc.dim(` — ${str(args.reason)}`) : ""));
    ctx.print(colorize(patch));

    if (!(await ctx.confirm(`Apply this change to ${rel}?`))) {
      return "The user REJECTED this edit. Do not retry the same change; ask what they would like instead.";
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, next, "utf8");
    await ctx.index.updateFiles([rel]);
    return `Applied edit to ${rel}.`;
  },
);

function colorize(patch: string): string {
  return patch
    .split("\n")
    .slice(2) // drop the "Index:"/"====" header lines
    .map((l) =>
      l.startsWith("+") && !l.startsWith("+++") ? pc.green(l)
      : l.startsWith("-") && !l.startsWith("---") ? pc.red(l)
      : l.startsWith("@@") ? pc.cyan(l)
      : l,
    )
    .join("\n");
}
