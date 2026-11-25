import { describe, expect, it } from "vitest";
import { chunkByLines, chunkFile } from "./chunker.js";

const src = `import { a } from "./a";
import b from "b";

/** Adds numbers. */
export function add(x: number, y: number): number {
  return x + y;
}

export interface User {
  id: string;
}

export type Id = string;

export const handler = async (req: Request) => {
  return new Response("ok");
};

const VERSION = "1.0";
`;

describe("chunkFile (TypeScript)", () => {
  const chunks = chunkFile("src/sample.ts", src, 2000);

  it("creates one chunk per top-level declaration", () => {
    const named = chunks.filter((c) => c.symbol).map((c) => `${c.kind}:${c.symbol}`);
    expect(named).toEqual(["function:add", "interface:User", "type:Id", "function:handler"]);
  });

  it("groups imports and small statements into module chunks", () => {
    const modules = chunks.filter((c) => c.kind === "module");
    expect(modules[0].text).toContain('import b from "b"');
    expect(modules.at(-1)!.text).toContain("VERSION");
  });

  it("keeps leading JSDoc with its declaration and tracks lines", () => {
    const add = chunks.find((c) => c.symbol === "add")!;
    expect(add.text.startsWith("/** Adds numbers. */")).toBe(true);
    expect(add.startLine).toBe(4);
    expect(add.endLine).toBe(7);
  });

  it("splits large classes per member, keeping the class header", () => {
    const body = Array.from({ length: 6 }, (_, i) => `  m${i}() {\n${"    doWork();\n".repeat(10)}  }`).join("\n");
    const cls = chunkFile("big.ts", `export class Big extends Base {\n${body}\n}\n`, 300);
    expect(cls.map((c) => c.symbol)).toEqual(["Big.m0", "Big.m1", "Big.m2", "Big.m3", "Big.m4", "Big.m5"]);
    expect(cls[0].text).toContain("export class Big extends Base");
  });
});

describe("chunkByLines", () => {
  it("windows text and never exceeds the limit for normal lines", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkByLines("notes.md", text, 120);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(120);
    expect(chunks[0].startLine).toBe(1);
  });
});
