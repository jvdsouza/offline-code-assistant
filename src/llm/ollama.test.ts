import { describe, expect, it } from "vitest";
import { parseInlineToolCalls, type Tool } from "./ollama.js";

const tools: Tool[] = [{ type: "function", function: { name: "read_file", description: "", parameters: { type: "object" } } }];

describe("parseInlineToolCalls", () => {
  it("parses a raw JSON tool call", () => {
    const calls = parseInlineToolCalls('{"name": "read_file", "arguments": {"path": "a.ts"}}', tools);
    expect(calls).toEqual([{ function: { name: "read_file", arguments: { path: "a.ts" } } }]);
  });

  it("parses fenced / tagged JSON", () => {
    const calls = parseInlineToolCalls('<tool_call>\n```json\n{"name":"read_file","arguments":"{\\"path\\":\\"b.ts\\"}"}\n```\n</tool_call>', tools);
    expect(calls[0].function.arguments).toEqual({ path: "b.ts" });
  });

  it("parses a fenced call that follows prose (qwen2.5-coder style)", () => {
    const text = 'I\'ll read the file.\n\n```json\n{"name": "read_file", "arguments": {"path": "c.ts"}}\n```';
    expect(parseInlineToolCalls(text, tools)[0].function.arguments).toEqual({ path: "c.ts" });
  });

  it("does not treat ordinary JSON code samples as tool calls", () => {
    expect(parseInlineToolCalls('Example config:\n```json\n{"compilerOptions": {}}\n```', tools)).toEqual([]);
  });

  it("ignores unknown tools and prose", () => {
    expect(parseInlineToolCalls('{"name":"rm_rf","arguments":{}}', tools)).toEqual([]);
    expect(parseInlineToolCalls("The answer is 42.", tools)).toEqual([]);
  });
});
