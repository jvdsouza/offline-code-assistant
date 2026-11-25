/**
 * oca eval suite. Runs against the pinned fixture in evals/fixtures/taskboard.
 *
 *   npx tsx evals/run.ts retrieval [-k 8]                 # embeddings only, ~1 min
 *   npx tsx evals/run.ts answers [--runs 3] [--judge]     # full agent, slower
 *   npx tsx evals/run.ts agent [--runs 2]                 # tool use + edits (sandboxed)
 *   npx tsx evals/run.ts all [--judge]
 *
 * Common options: --filter <id-substring>, --fail-under <0..1> (exit 1 if the main metric is lower).
 * Every run writes a JSON report to evals/results/.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import { Agent } from "../src/agent/agent.js";
import { config } from "../src/config.js";
import { RepoIndex } from "../src/ingest/indexer.js";
import { LLM } from "../src/llm/ollama.js";
import { DEFAULT_MIN_SCORE } from "../src/retrieval/retriever.js";
import { agentCases } from "./cases/agent.js";
import { answerCases } from "./cases/answers.js";
import { retrievalCases } from "./cases/retrieval.js";
import { judgeAnswer } from "./lib/judge.js";
import { checkAgentRun, checkAnswer, firstRelevantRank, summarizeRetrieval, type JudgeVerdict, type RetrievalResult } from "./lib/scoring.js";
import type { Check } from "./lib/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "taskboard");
const INDEX_DIR = path.join(HERE, ".index", "taskboard");
const RESULTS_DIR = path.join(HERE, "results");

// ---------------------------------------------------------------- helpers

const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const pick = <T extends { id: string }>(cases: T[], filter?: string) => (filter ? cases.filter((c) => c.id.includes(filter)) : cases);
const header = (title: string) => console.log("\n" + pc.bold(title));

async function preflight(llm: LLM, opts: { chat: boolean; judgeModel?: string }): Promise<void> {
  let models: string[];
  try {
    models = await llm.listModels();
  } catch (e) {
    throw new Error(`Cannot reach Ollama at ${config.ollamaHost} (${(e as Error).message}). Is it running?`);
  }
  const need = [llm.embedModel, opts.chat ? llm.chatModel : null, opts.judgeModel ?? null].filter((m): m is string => !!m);
  const missing = need.filter((m) => !models.some((x) => x === m || x === `${m}:latest`));
  if (missing.length) throw new Error(`Missing Ollama models: ${missing.join(", ")}. Run: ollama pull <model>`);
}

async function openFixtureIndex(llm: LLM): Promise<RepoIndex> {
  const index = await RepoIndex.open(FIXTURE, llm, { indexDir: INDEX_DIR });
  const s = await index.sync();
  console.log(pc.dim(`fixture index: ${s.scanned} files, ${await index.chunkCount()} chunks (${s.updated} files re-embedded)`));
  return index;
}

async function saveReport(suite: string, report: object): Promise<void> {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(RESULTS_DIR, `${stamp}-${suite}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2) + "\n");
  console.log(pc.dim(`report: ${path.relative(process.cwd(), file)}`));
}

function gate(name: string, metric: number, failUnder?: string): void {
  if (failUnder === undefined) return;
  const min = Number(failUnder);
  if (metric < min) {
    console.log(pc.red(`✗ ${name} ${pct(metric)} is below --fail-under ${pct(min)}`));
    process.exitCode = 1;
  }
}

const models = (llm: LLM) => ({ chat: llm.chatModel, embed: llm.embedModel, numCtx: config.numCtx, temperature: config.temperature });

// ---------------------------------------------------------------- retrieval

export async function runRetrieval(opts: { k: number; filter?: string }): Promise<number> {
  const llm = new LLM();
  await preflight(llm, { chat: false });
  const index = await openFixtureIndex(llm);
  const cases = pick(retrievalCases, opts.filter);
  const k = opts.k;
  header(`Retrieval · ${cases.length} cases · top-${k} · ${llm.embedModel}`);

  const results: RetrievalResult[] = [];
  const details: object[] = [];
  for (const c of cases) {
    const hits = await index.search(c.query, k);
    const rank = firstRelevantRank(hits, c.expect);
    const score = rank ? hits[rank - 1].score : null;
    const belowCutoff = score !== null && score < DEFAULT_MIN_SCORE;
    results.push({ id: c.id, category: c.category, rank, score });
    details.push({ ...c, rank, score, belowCutoff, top: hits.map((h) => ({ path: h.path, symbol: h.symbol, line: h.start_line, score: +h.score.toFixed(3) })) });

    const mark = rank === null ? pc.red("✗ miss") : rank === 1 ? pc.green("✓ #1  ") : pc.yellow(`✓ #${rank}`.padEnd(6));
    console.log(`  ${mark} ${c.id.padEnd(28)} ${score !== null ? score.toFixed(2) : "  - "}${belowCutoff ? pc.red(" (below cut-off)") : ""}  ${pc.dim(c.query)}`);
    if (rank === null || rank > 3) {
      console.log(pc.dim(`         got: ${hits.slice(0, 3).map((h) => `${h.path}${h.symbol ? " " + h.symbol : ""} ${h.score.toFixed(2)}`).join(" | ")}`));
    }
  }

  const ks = [...new Set([1, 3, k])].sort((a, b) => a - b);
  const s = summarizeRetrieval(results, ks);
  const below = details.filter((d) => (d as { belowCutoff: boolean }).belowCutoff).length;
  console.log("\n  " + ks.map((x) => `recall@${x} ${pc.bold(pct(s.recallAt[x]))}`).join("   ") + `   MRR ${pc.bold(s.mrr.toFixed(2))}`);
  for (const [cat, v] of Object.entries(s.byCategory)) {
    console.log(pc.dim(`  ${cat.padEnd(11)} n=${String(v.n).padEnd(3)} recall@${k} ${pct(v.recallAtK).padStart(4)}   MRR ${v.mrr.toFixed(2)}`));
  }
  if (below) console.log(pc.yellow(`  ${below} relevant hit(s) scored below the ${DEFAULT_MIN_SCORE} cut-off, so the agent would not see them automatically.`));

  await saveReport("retrieval", { suite: "retrieval", at: new Date().toISOString(), models: models(llm), k, cutoff: DEFAULT_MIN_SCORE, summary: s, cases: details });
  return s.recallAt[k];
}

// ---------------------------------------------------------------- answers

export async function runAnswers(opts: { runs: number; judge: boolean; judgeModel: string; filter?: string }): Promise<number> {
  const llm = new LLM();
  await preflight(llm, { chat: true, judgeModel: opts.judge ? opts.judgeModel : undefined });
  const index = await openFixtureIndex(llm);
  const cases = pick(answerCases, opts.filter);
  header(`Answers · ${cases.length} cases × ${opts.runs} runs · ${llm.chatModel}${opts.judge ? ` · judge ${opts.judgeModel}` : ""}`);
  if (opts.judge && opts.judgeModel === llm.chatModel) {
    console.log(pc.yellow("  note: the judge is the model under test, so judge scores will be optimistic. Use --judge-model to pick another."));
  }

  const report: object[] = [];
  let passed = 0, total = 0;
  const scores: number[] = [], times: number[] = [];

  for (const c of cases) {
    const runs: { pass: boolean; check: Check; verdict: JudgeVerdict | null; tools: string[]; ms: number; answer: string }[] = [];
    for (let r = 0; r < opts.runs; r++) {
      const tools: string[] = [];
      const agent = new Agent(index, { confirm: async () => false, print: () => {} }, llm);
      const t0 = Date.now();
      let answer = "";
      let check: Check;
      try {
        answer = await agent.run(c.question, { onToolCall: (name) => tools.push(name) });
        check = checkAnswer(answer, c.rules);
      } catch (e) {
        check = { pass: false, failures: [`error: ${(e as Error).message}`] };
      }
      const ms = Date.now() - t0;
      let verdict: JudgeVerdict | null = null;
      if (opts.judge && answer) {
        verdict = await judgeAnswer(llm.client, opts.judgeModel, { question: c.question, reference: c.reference, answer }).catch(() => null);
        if (!verdict) check = { pass: false, failures: [...check.failures, "judge reply unreadable"] };
        else {
          scores.push(verdict.score);
          if (verdict.score < 4) check = { pass: false, failures: [...check.failures, `judge ${verdict.score}/5: ${verdict.reason}`] };
        }
      }
      runs.push({ pass: check.pass, check, verdict, tools, ms, answer });
      times.push(ms);
    }

    const ok = runs.filter((r) => r.pass).length;
    passed += ok;
    total += runs.length;
    const mark = ok === runs.length ? pc.green("✓") : ok === 0 ? pc.red("✗") : pc.yellow("~");
    const judged = runs.filter((r) => r.verdict);
    const judgeTxt = judged.length ? `  judge ${(judged.reduce((s, r) => s + r.verdict!.score, 0) / judged.length).toFixed(1)}` : "";
    console.log(`  ${mark} ${`${ok}/${runs.length}`.padEnd(4)} ${c.id.padEnd(30)} ${secs(runs.reduce((s, r) => s + r.ms, 0) / runs.length).padStart(6)}${judgeTxt}`);
    const failures = [...new Set(runs.flatMap((r) => r.check.failures))];
    if (failures.length) console.log(pc.dim(`         ${failures.join("; ")}`));
    report.push({ ...c, passRate: ok / runs.length, runs });
  }

  const rate = total ? passed / total : 0;
  const meanJudge = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  console.log(
    `\n  pass rate ${pc.bold(pct(rate))} (${passed}/${total} runs)` +
      (meanJudge !== null ? `   mean judge ${pc.bold(meanJudge.toFixed(2))}/5` : "") +
      `   mean time ${secs(times.reduce((a, b) => a + b, 0) / Math.max(1, times.length))}`,
  );
  await saveReport("answers", {
    suite: "answers", at: new Date().toISOString(), models: models(llm), runs: opts.runs,
    judge: opts.judge ? opts.judgeModel : null, summary: { passRate: rate, passed, total, meanJudge }, cases: report,
  });
  return rate;
}

// ---------------------------------------------------------------- agent

export async function runAgentSuite(opts: { runs: number; filter?: string }): Promise<number> {
  const llm = new LLM();
  await preflight(llm, { chat: true });
  const baseIndex = await openFixtureIndex(llm);
  const cases = pick(agentCases, opts.filter);
  header(`Agent behaviour · ${cases.length} cases × ${opts.runs} runs · ${llm.chatModel}`);

  const report: object[] = [];
  let passed = 0, total = 0;

  for (const c of cases) {
    const runs: { pass: boolean; failures: string[]; tools: string[]; ms: number; answer: string }[] = [];
    for (let r = 0; r < opts.runs; r++) {
      let index = baseIndex;
      let sandbox: string | null = null;
      let originalFile: string | null = null;
      const tools: string[] = [];
      const t0 = Date.now();
      let answer = "";
      let failures: string[];
      try {
        if (c.edit) {
          // Edits run against a throwaway copy of the fixture and its index, with approval automatic.
          sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "oca-eval-"));
          await fs.cp(FIXTURE, path.join(sandbox, "repo"), { recursive: true });
          await fs.cp(INDEX_DIR, path.join(sandbox, "index"), { recursive: true });
          index = await RepoIndex.open(path.join(sandbox, "repo"), llm, { indexDir: path.join(sandbox, "index") });
          originalFile = await fs.readFile(path.join(FIXTURE, c.edit.path), "utf8");
        }
        // Outside the sandbox every write is rejected, so the shared fixture never changes.
        const agent = new Agent(index, { confirm: async () => !!c.edit, print: () => {} }, llm);
        answer = await agent.run(c.task, { onToolCall: (name) => tools.push(name) });
        const editedFile = c.edit ? await fs.readFile(path.join(index.root, c.edit.path), "utf8").catch(() => null) : undefined;
        failures = checkAgentRun({ toolCalls: tools, answer, stopped: answer.startsWith("(Stopped:"), editedFile, originalFile }, c).failures;
      } catch (e) {
        failures = [`error: ${(e as Error).message}`];
      } finally {
        if (sandbox) await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
      }
      runs.push({ pass: failures.length === 0, failures, tools, ms: Date.now() - t0, answer });
    }

    const ok = runs.filter((r) => r.pass).length;
    passed += ok;
    total += runs.length;
    const mark = ok === runs.length ? pc.green("✓") : ok === 0 ? pc.red("✗") : pc.yellow("~");
    const toolsTxt = runs.map((r) => r.tools.join("→") || "(no tools)").join("  |  ");
    console.log(`  ${mark} ${`${ok}/${runs.length}`.padEnd(4)} ${c.id.padEnd(30)} ${pc.dim(toolsTxt)}`);
    const failures = [...new Set(runs.flatMap((r) => r.failures))];
    if (failures.length) console.log(pc.dim(`         ${failures.join("; ")}`));
    report.push({ ...c, passRate: ok / runs.length, runs });
  }

  const rate = total ? passed / total : 0;
  console.log(`\n  pass rate ${pc.bold(pct(rate))} (${passed}/${total} runs)`);
  await saveReport("agent", { suite: "agent", at: new Date().toISOString(), models: models(llm), runs: opts.runs, summary: { passRate: rate, passed, total }, cases: report });
  return rate;
}

// ---------------------------------------------------------------- CLI

const program = new Command().name("oca-eval").description("Eval suite for the offline code assistant (fixture: evals/fixtures/taskboard).");
const common = (cmd: Command) => cmd.option("--filter <text>", "only run cases whose id contains this").option("--fail-under <rate>", "exit 1 if the main metric is below this (0-1)");
const judgeDefault = process.env.OCA_JUDGE_MODEL ?? config.chatModel;

common(program.command("retrieval").description("Recall@k and MRR of the RAG index (no chat model needed)."))
  .option("-k, --k <n>", "number of chunks to retrieve", String(config.topK))
  .action(async (o: { k: string; filter?: string; failUnder?: string }) => gate("recall", await runRetrieval({ k: Number(o.k), filter: o.filter }), o.failUnder));

common(program.command("answers").description("End-to-end answers graded by rules, optionally by a local judge model."))
  .option("--runs <n>", "runs per case (answers vary between runs)", "3")
  .option("--judge", "also grade with an LLM judge against the reference answer")
  .option("--judge-model <model>", "Ollama model used as judge (env OCA_JUDGE_MODEL)", judgeDefault)
  .action(async (o: { runs: string; judge?: boolean; judgeModel: string; filter?: string; failUnder?: string }) =>
    gate("pass rate", await runAnswers({ runs: Number(o.runs), judge: !!o.judge, judgeModel: o.judgeModel, filter: o.filter }), o.failUnder));

common(program.command("agent").description("Tool choice, efficiency and sandboxed edits."))
  .option("--runs <n>", "runs per case", "2")
  .action(async (o: { runs: string; filter?: string; failUnder?: string }) => gate("pass rate", await runAgentSuite({ runs: Number(o.runs), filter: o.filter }), o.failUnder));

common(program.command("all").description("Run all three suites."))
  .option("--runs <n>", "runs per case for answers and agent", "2")
  .option("--judge", "use the LLM judge for answers")
  .option("--judge-model <model>", "Ollama model used as judge", judgeDefault)
  .action(async (o: { runs: string; judge?: boolean; judgeModel: string; filter?: string; failUnder?: string }) => {
    const t0 = Date.now();
    const r = await runRetrieval({ k: config.topK, filter: o.filter });
    const a = await runAnswers({ runs: Number(o.runs), judge: !!o.judge, judgeModel: o.judgeModel, filter: o.filter });
    const g = await runAgentSuite({ runs: Number(o.runs), filter: o.filter });
    header(`Summary (${secs(Date.now() - t0)})`);
    console.log(`  retrieval recall@${config.topK} ${pct(r)}   answers ${pct(a)}   agent ${pct(g)}`);
    gate("lowest suite score", Math.min(r, a, g), o.failUnder);
  });

program.parseAsync().catch((e) => {
  console.error(pc.red((e as Error).message));
  process.exit(1);
});
