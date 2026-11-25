import path from "node:path";
import type { AgentCase, AgentRun, AnswerRules, Check, ChunkExpectation, RetrievalCategory } from "./types.js";

// ---------------------------------------------------------------- retrieval

export interface HitLike {
  path: string;
  symbol: string;
  text: string;
}

export function symbolMatches(chunkSymbol: string, expected: string): boolean {
  if (!chunkSymbol) return false;
  return (
    chunkSymbol === expected ||
    chunkSymbol.startsWith(expected + ".") || // expected "Cls", chunk "Cls.method"
    expected.startsWith(chunkSymbol + ".") || // expected "Cls.method", chunk is the whole class
    chunkSymbol.split(", ").includes(expected) // multi-declaration chunks: "a, b"
  );
}

export function chunkMatches(hit: HitLike, e: ChunkExpectation): boolean {
  if (hit.path !== e.path) return false;
  if (e.symbol && !symbolMatches(hit.symbol, e.symbol)) return false;
  if (e.contains && !hit.text.includes(e.contains)) return false;
  return true;
}

/** 1-based rank of the first relevant hit, or null if none is relevant. */
export function firstRelevantRank(hits: HitLike[], expect: ChunkExpectation[]): number | null {
  const i = hits.findIndex((h) => expect.some((e) => chunkMatches(h, e)));
  return i === -1 ? null : i + 1;
}

export interface RetrievalResult {
  id: string;
  category: RetrievalCategory;
  rank: number | null;
  /** Similarity score of the first relevant hit. */
  score: number | null;
}

export interface RetrievalSummary {
  n: number;
  recallAt: Record<number, number>;
  mrr: number;
  byCategory: Record<string, { n: number; recallAtK: number; mrr: number }>;
}

export function summarizeRetrieval(results: RetrievalResult[], ks: number[]): RetrievalSummary {
  const maxK = Math.max(...ks);
  const recall = (rs: RetrievalResult[], k: number) => (rs.length ? rs.filter((r) => r.rank !== null && r.rank <= k).length / rs.length : 0);
  const mrr = (rs: RetrievalResult[]) => (rs.length ? rs.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rs.length : 0);

  const byCategory: RetrievalSummary["byCategory"] = {};
  for (const cat of [...new Set(results.map((r) => r.category))]) {
    const rs = results.filter((r) => r.category === cat);
    byCategory[cat] = { n: rs.length, recallAtK: recall(rs, maxK), mrr: mrr(rs) };
  }
  return {
    n: results.length,
    recallAt: Object.fromEntries(ks.map((k) => [k, recall(results, k)])),
    mrr: mrr(results),
    byCategory,
  };
}

// ---------------------------------------------------------------- answers

export function checkAnswer(answer: string, rules: AnswerRules): Check {
  const failures: string[] = [];
  for (const p of rules.mustInclude ?? []) {
    if (!new RegExp(p, "i").test(answer)) failures.push(`missing /${p}/`);
  }
  for (const p of rules.mustNotInclude ?? []) {
    if (new RegExp(p, "i").test(answer)) failures.push(`should not contain /${p}/`);
  }
  if (rules.citeAnyOf?.length) {
    const lower = answer.toLowerCase();
    const cited = rules.citeAnyOf.some((p) => lower.includes(p.toLowerCase()) || lower.includes(path.posix.basename(p).toLowerCase()));
    if (!cited) failures.push(`no citation of ${rules.citeAnyOf.join(" | ")}`);
  }
  return { pass: failures.length === 0, failures };
}

export interface JudgeVerdict {
  score: number; // 1-5
  reason: string;
}

/** Parses the judge model's JSON reply; tolerant of code fences and stray text. */
export function parseJudgeReply(text: string): JudgeVerdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { score?: unknown; reason?: unknown };
    const score = Number(o.score);
    if (!Number.isFinite(score)) return null;
    return { score: Math.min(5, Math.max(1, Math.round(score))), reason: typeof o.reason === "string" ? o.reason : "" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- agent

export function checkAgentRun(run: AgentRun, c: AgentCase): Check {
  const failures: string[] = [];
  const called = new Set(run.toolCalls);
  for (const t of c.mustCall ?? []) if (!called.has(t)) failures.push(`did not call ${t}`);
  for (const t of c.mustNotCall ?? []) if (called.has(t)) failures.push(`called forbidden ${t}`);
  if (c.maxToolCalls !== undefined && run.toolCalls.length > c.maxToolCalls) {
    failures.push(`${run.toolCalls.length} tool calls (max ${c.maxToolCalls})`);
  }
  if (run.stopped) failures.push("hit the step limit");
  if (c.answer) failures.push(...checkAnswer(run.answer, c.answer).failures);

  if (c.edit) {
    const file = run.editedFile;
    if (file == null) failures.push(`${c.edit.path} is missing after the run`);
    else {
      if (file === run.originalFile) failures.push(`${c.edit.path} was not changed`);
      for (const p of c.edit.mustMatch) if (!new RegExp(p).test(file)) failures.push(`edited file missing /${p}/`);
      for (const p of c.edit.mustNotMatch ?? []) if (new RegExp(p).test(file)) failures.push(`edited file still matches /${p}/`);
    }
  }
  return { pass: failures.length === 0, failures };
}
