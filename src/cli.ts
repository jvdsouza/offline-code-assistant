#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline/promises";
import { Command } from "commander";
import pc from "picocolors";
import { Agent } from "./agent/agent.js";
import { config } from "./config.js";
import { RepoIndex } from "./ingest/indexer.js";
import { LLM } from "./llm/ollama.js";

const program = new Command()
  .name("oca")
  .description("Offline code assistant — RAG + tool-calling agent over your repo, powered by Ollama.");

program
  .command("index")
  .description("Index (or incrementally re-index) a repository.")
  .argument("[repo]", "path to the repository", ".")
  .option("--full", "drop the existing index and rebuild from scratch")
  .action(async (repo: string, opts: { full?: boolean }) => {
    const index = await RepoIndex.open(repo);
    await syncWithProgress(index, opts.full);
    console.log(pc.dim(`Index stored in ${index.dir}`));
  });

program
  .command("chat")
  .description("Interactive chat with the agent about a repository.")
  .argument("[repo]", "path to the repository", ".")
  .option("--no-sync", "skip the incremental re-index on start")
  .action(async (repo: string, opts: { sync: boolean }) => {
    const index = await RepoIndex.open(repo);
    if (opts.sync) await syncWithProgress(index);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const agent = makeAgent(index, rl);

    console.log(pc.bold(`\noca · ${path.basename(index.root)} · ${config.chatModel}`));
    console.log(pc.dim("Commands: /reset (clear conversation), /reindex, /exit\n"));

    for (;;) {
      let input: string;
      try {
        input = (await rl.question(pc.cyan("you › "))).trim();
      } catch {
        break; // Ctrl+C / Ctrl+D
      }
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      if (input === "/reset") {
        agent.reset();
        console.log(pc.dim("Conversation cleared."));
        continue;
      }
      if (input === "/reindex") {
        await syncWithProgress(index);
        continue;
      }
      await runTurn(agent, input);
    }
    rl.close();
  });

program
  .command("ask")
  .description("Ask a single question (non-interactive).")
  .argument("<question>", "your question")
  .option("-r, --repo <path>", "path to the repository", ".")
  .action(async (question: string, opts: { repo: string }) => {
    const index = await RepoIndex.open(opts.repo);
    await syncWithProgress(index);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await runTurn(makeAgent(index, rl), question);
    rl.close();
  });

program
  .command("doctor")
  .description("Check that Ollama is reachable and the configured models are installed.")
  .action(async () => {
    const llm = new LLM();
    console.log(`Ollama host:  ${config.ollamaHost}`);
    let models: string[];
    try {
      models = await llm.listModels();
    } catch (e) {
      console.log(pc.red(`✗ Cannot reach Ollama: ${(e as Error).message}. Is 'ollama serve' running?`));
      process.exitCode = 1;
      return;
    }
    for (const [label, name] of [["Chat model", config.chatModel], ["Embed model", config.embedModel]] as const) {
      const ok = models.some((m) => m === name || m === `${name}:latest`);
      console.log(`${label}:  ${name}  ${ok ? pc.green("✓ installed") : pc.red(`✗ missing — run: ollama pull ${name}`)}`);
      if (!ok) process.exitCode = 1;
    }
    console.log(`Data dir:     ${config.dataDir}`);
  });

function makeAgent(index: RepoIndex, rl: readline.Interface): Agent {
  return new Agent(index, {
    print: (t) => console.log(t),
    confirm: async (q) => /^y(es)?$/i.test((await rl.question(pc.yellow(`${q} [y/N] `))).trim()),
  });
}

async function runTurn(agent: Agent, input: string): Promise<void> {
  let started = false;
  try {
    await agent.run(input, {
      onToken: (t) => {
        if (!started) process.stdout.write(pc.green("oca › "));
        started = true;
        process.stdout.write(t);
      },
      onToolCall: (name, args) => {
        if (started) process.stdout.write("\n");
        started = false;
        const shown = JSON.stringify(args);
        console.log(pc.dim(`  ⚙ ${name}(${shown.length > 160 ? shown.slice(0, 160) + "…" : shown})`));
      },
    });
    process.stdout.write("\n\n");
  } catch (e) {
    console.error(pc.red(`\nError: ${(e as Error).message}`));
  }
}

async function syncWithProgress(index: RepoIndex, full = false): Promise<void> {
  const t0 = Date.now();
  const stats = await index.sync((msg) => process.stderr.write(pc.dim(`\r  indexing: ${msg}`.padEnd(70))), { full });
  process.stderr.write("\r".padEnd(72) + "\r");
  console.log(
    pc.dim(
      `Index up to date: ${stats.scanned} files (${stats.updated} updated, ${stats.removed} removed, ` +
        `${stats.chunks} chunks embedded) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    ),
  );
}

program.parseAsync().catch((e) => {
  console.error(pc.red((e as Error).message));
  process.exit(1);
});
