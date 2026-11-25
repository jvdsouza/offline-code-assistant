import type { Ollama } from "ollama";
import { parseJudgeReply, type JudgeVerdict } from "./scoring.js";

const RUBRIC = `You grade answers to questions about a codebase.
Compare the CANDIDATE answer with the REFERENCE answer, which is correct.
Judge factual correctness and completeness only. Ignore style, length and formatting.

Score:
5 = correct and complete
4 = correct, misses a minor detail
3 = partly correct, or correct but padded with a wrong claim
2 = mostly wrong
1 = wrong, irrelevant or no answer

Reply with JSON only: {"score": <1-5>, "reason": "<one sentence>"}`;

/** Asks a local Ollama model to grade an answer against a reference. Deterministic (temperature 0). */
export async function judgeAnswer(
  client: Ollama,
  model: string,
  input: { question: string; reference: string; answer: string },
): Promise<JudgeVerdict | null> {
  const res = await client.chat({
    model,
    format: "json",
    options: { temperature: 0, num_ctx: 8192 },
    messages: [
      { role: "system", content: RUBRIC },
      {
        role: "user",
        content: `QUESTION:\n${input.question}\n\nREFERENCE:\n${input.reference}\n\nCANDIDATE:\n${input.answer.slice(0, 6000)}`,
      },
    ],
  });
  return parseJudgeReply(res.message.content);
}
