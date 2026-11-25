import type { AgentCase } from "../lib/types.js";

/** Agent behaviour: tool choice, efficiency, and edits (edit cases run in a throwaway copy). */
export const agentCases: AgentCase[] = [
  { id: "t01-grep-identifier", task: "Find every place where the identifier `isRetryable` is defined or used.",
    mustCall: ["grep"], answer: { mustInclude: ["retry\\.ts"] } },
  { id: "t02-read-named-file", task: "Open src/lib/retry.ts and explain what maxDelayMs controls.",
    mustCall: ["read_file"], answer: { mustInclude: ["cap|upper bound|maximum|ceiling|limit|at most"] } },
  { id: "t03-no-edit-for-question", task: "Without changing any code: can an archived task be moved back to another status?",
    mustNotCall: ["propose_edit"], answer: { mustInclude: ["\\b(no|not|cannot|can't)\\b"] } },
  { id: "t04-efficient-lookup", task: "What port does the server listen on by default?",
    maxToolCalls: 4, mustNotCall: ["propose_edit"], answer: { mustInclude: ["8080"] } },
  { id: "t05-edit-constant", task: "Change the maximum page size for listing tasks from 100 to 50.",
    mustCall: ["propose_edit"],
    edit: { path: "src/db/taskRepo.ts", mustMatch: ["MAX_PAGE_SIZE = 50;", "DEFAULT_PAGE_SIZE = 20;"], mustNotMatch: ["MAX_PAGE_SIZE = 100"] } },
  { id: "t06-edit-redaction", task: "Make the logger also redact a field called `apiKey`.",
    mustCall: ["propose_edit"],
    edit: { path: "src/lib/logger.ts", mustMatch: ["\"apiKey\"", "\"password\"", "\"authorization\"", "export function redact"] } },
];
