import { describe, expect, it } from "vitest";
import { checkAgentRun, checkAnswer, chunkMatches, firstRelevantRank, parseJudgeReply, summarizeRetrieval, symbolMatches } from "./scoring.js";

const hit = (path: string, symbol: string, text = "") => ({ path, symbol, text });

describe("retrieval scoring", () => {
  it("matches class and method symbols in both directions", () => {
    expect(symbolMatches("TokenBucket", "TokenBucket.take")).toBe(true); // whole-class chunk
    expect(symbolMatches("TokenBucket.take", "TokenBucket")).toBe(true);
    expect(symbolMatches("TokenBucket.sweep", "TokenBucket.take")).toBe(false);
    expect(symbolMatches("retryDelay", "retry")).toBe(false);
    expect(symbolMatches("a, b", "b")).toBe(true);
  });

  it("requires path, symbol and contains together", () => {
    const h = hit("src/http/routes.ts", "registerRoutes", 'router.add("POST", "/auth/login"');
    expect(chunkMatches(h, { path: "src/http/routes.ts", symbol: "registerRoutes", contains: "/auth/login" })).toBe(true);
    expect(chunkMatches(h, { path: "src/http/routes.ts", symbol: "registerRoutes", contains: "/tasks" })).toBe(false);
    expect(chunkMatches(h, { path: "src/http/router.ts", symbol: "registerRoutes" })).toBe(false);
  });

  it("ranks the first relevant hit and summarizes recall and MRR", () => {
    const hits = [hit("a.ts", "x"), hit("b.ts", "y"), hit("c.ts", "z")];
    expect(firstRelevantRank(hits, [{ path: "b.ts" }, { path: "c.ts" }])).toBe(2);
    expect(firstRelevantRank(hits, [{ path: "d.ts" }])).toBeNull();

    const s = summarizeRetrieval(
      [
        { id: "1", category: "semantic", rank: 1, score: 0.8 },
        { id: "2", category: "semantic", rank: 4, score: 0.5 },
        { id: "3", category: "identifier", rank: null, score: null },
      ],
      [1, 3, 8],
    );
    expect(s.recallAt[1]).toBeCloseTo(1 / 3);
    expect(s.recallAt[3]).toBeCloseTo(1 / 3);
    expect(s.recallAt[8]).toBeCloseTo(2 / 3);
    expect(s.mrr).toBeCloseTo((1 + 0.25 + 0) / 3);
    expect(s.byCategory.identifier).toEqual({ n: 1, recallAtK: 0, mrr: 0 });
  });
});

describe("answer rules", () => {
  it("checks includes, excludes and citations (file name is enough)", () => {
    const ans = "Tokens last **15 minutes** (see `config.ts:7`).";
    expect(checkAnswer(ans, { mustInclude: ["\\b15\\b"], citeAnyOf: ["src/config.ts"] }).pass).toBe(true);
    const r = checkAnswer(ans, { mustInclude: ["scrypt"], mustNotInclude: ["minutes"], citeAnyOf: ["src/auth/tokens.ts"] });
    expect(r.pass).toBe(false);
    expect(r.failures).toHaveLength(3);
  });
});

describe("parseJudgeReply", () => {
  it("parses, clamps and tolerates wrapping", () => {
    expect(parseJudgeReply('{"score": 4, "reason": "ok"}')).toEqual({ score: 4, reason: "ok" });
    expect(parseJudgeReply('```json\n{"score": "9"}\n```')).toEqual({ score: 5, reason: "" });
    expect(parseJudgeReply("no json here")).toBeNull();
    expect(parseJudgeReply('{"score": "high"}')).toBeNull();
  });
});

describe("checkAgentRun", () => {
  it("checks tools, step limit, answer and edited file", () => {
    const c = {
      id: "t", task: "", mustCall: ["propose_edit"], mustNotCall: ["grep"], maxToolCalls: 2,
      edit: { path: "x.ts", mustMatch: ["MAX = 50;"], mustNotMatch: ["MAX = 100"] },
    };
    const good = checkAgentRun({ toolCalls: ["read_file", "propose_edit"], answer: "done", stopped: false, originalFile: "MAX = 100;", editedFile: "MAX = 50;" }, c);
    expect(good).toEqual({ pass: true, failures: [] });

    const bad = checkAgentRun({ toolCalls: ["grep", "grep", "read_file"], answer: "", stopped: true, originalFile: "MAX = 100;", editedFile: "MAX = 100;" }, c);
    expect(bad.failures).toEqual([
      "did not call propose_edit",
      "called forbidden grep",
      "3 tool calls (max 2)",
      "hit the step limit",
      "x.ts was not changed",
      "edited file missing /MAX = 50;/",
      "edited file still matches /MAX = 100/",
    ]);
  });
});
