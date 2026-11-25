import type { RetrievalCase } from "../lib/types.js";

/**
 * Retrieval cases over evals/fixtures/taskboard. Each query lists the chunks that
 * would let the model answer it; ANY of them in the top-k counts as a hit.
 */
export const retrievalCases: RetrievalCase[] = [
  // ---- semantic: describes behaviour, shares few words with the code
  { id: "r01-hash-password", category: "semantic", query: "How are user passwords hashed before they are stored?",
    expect: [{ path: "src/auth/password.ts", symbol: "hashPassword" }] },
  { id: "r02-verify-password", category: "semantic", query: "How is a login password checked against the stored hash?",
    expect: [{ path: "src/auth/password.ts", symbol: "verifyPassword" }] },
  { id: "r03-rate-limit", category: "semantic", query: "How does the API decide that a client has sent too many requests?",
    expect: [{ path: "src/lib/rateLimiter.ts", symbol: "TokenBucket.take" }] },
  { id: "r04-backoff", category: "semantic", query: "How long does it wait between retry attempts?",
    expect: [{ path: "src/lib/retry.ts", symbol: "backoffDelay" }, { path: "src/lib/retry.ts", symbol: "retry" }] },
  { id: "r05-concurrent-update", category: "semantic", query: "What happens when two clients update the same record at the same time?",
    expect: [{ path: "src/db/store.ts", symbol: "InMemoryStore.update" }, { path: "src/errors.ts", symbol: "ConflictError" }] },
  { id: "r06-workflow-code", category: "semantic", query: "Which task status changes are allowed?",
    expect: [{ path: "src/models/task.ts", symbol: "ALLOWED_TRANSITIONS" }, { path: "src/models/task.ts", symbol: "canTransition" }] },
  { id: "r07-webhook-signing", category: "semantic", query: "How can a webhook receiver verify that a request really came from us?",
    expect: [{ path: "src/services/notifier.ts", symbol: "signPayload" }, { path: "src/services/notifier.ts", symbol: "WebhookNotifier.notify" }] },
  { id: "r08-error-mapping", category: "semantic", query: "How are thrown errors turned into HTTP status codes?",
    expect: [{ path: "src/http/router.ts", symbol: "toErrorResponse" }] },
  { id: "r09-log-secrets", category: "semantic", query: "Where are secrets removed from log output?",
    expect: [{ path: "src/lib/logger.ts", symbol: "redact" }, { path: "src/lib/logger.ts", contains: "REDACTED_KEYS" }] },
  { id: "r10-pagination", category: "semantic", query: "How does paging through a long list of tasks work?",
    expect: [{ path: "src/db/store.ts", symbol: "InMemoryStore.list" }, { path: "src/db/taskRepo.ts", symbol: "TaskRepository.listTasks" }] },
  { id: "r11-token-checks", category: "semantic", query: "What is checked when an access token is validated?",
    expect: [{ path: "src/auth/tokens.ts", symbol: "verifyToken" }] },
  { id: "r12-authn", category: "semantic", query: "How does a request get authenticated before it reaches a handler?",
    expect: [{ path: "src/auth/middleware.ts", symbol: "requireAuth" }] },
  { id: "r13-body-size", category: "semantic", query: "How big can an incoming request body be?",
    expect: [{ path: "src/server.ts", symbol: "readJsonBody" }, { path: "src/config.ts", contains: "maxBodyBytes" }] },

  // ---- identifier: exact names; vector search is expected to be weaker here
  { id: "r14-TOKEN_ISSUER", category: "identifier", query: "TOKEN_ISSUER",
    expect: [{ path: "src/config.ts", contains: "TOKEN_ISSUER" }, { path: "src/auth/tokens.ts", contains: "TOKEN_ISSUER" }] },
  { id: "r15-isRetryable", category: "identifier", query: "isRetryable",
    expect: [{ path: "src/lib/retry.ts", symbol: "isRetryable" }] },
  { id: "r16-InvalidTransitionError", category: "identifier", query: "InvalidTransitionError",
    expect: [{ path: "src/errors.ts", symbol: "InvalidTransitionError" }, { path: "src/services/taskService.ts", contains: "InvalidTransitionError" }] },
  { id: "r17-signature-header", category: "identifier", query: "x-taskboard-signature",
    // signPayload computes the header (its comment spells it X-Taskboard-Signature); notify() sets it.
    expect: [{ path: "src/services/notifier.ts", symbol: "signPayload" }, { path: "src/services/notifier.ts", contains: "x-taskboard-signature" }] },
  { id: "r18-MAX_PAGE_SIZE", category: "identifier", query: "MAX_PAGE_SIZE",
    expect: [{ path: "src/db/taskRepo.ts", contains: "MAX_PAGE_SIZE" }] },

  // ---- docs
  { id: "r19-readme-workflow", category: "docs", query: "What does the documentation say about the task workflow?",
    expect: [{ path: "README.md", contains: "Task workflow" }] },

  // ---- cross-file: the answer lives where several modules meet
  { id: "r20-task-done", category: "cross-file", query: "What happens when a task is marked as done?",
    expect: [{ path: "src/services/taskService.ts", symbol: "TaskService.updateStatus" }] },
  { id: "r21-login-endpoint", category: "cross-file", query: "Where is the login endpoint implemented?",
    expect: [{ path: "src/http/routes.ts", symbol: "registerRoutes", contains: "/auth/login" }] },
];
