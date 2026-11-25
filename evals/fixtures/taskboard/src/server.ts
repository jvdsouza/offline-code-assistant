import http from "node:http";
import { config } from "./config.js";
import { TaskRepository } from "./db/taskRepo.js";
import { RateLimitedError, ValidationError } from "./errors.js";
import { Router, toErrorResponse, type HandlerResult } from "./http/router.js";
import { registerRoutes } from "./http/routes.js";
import { createLogger } from "./lib/logger.js";
import { TokenBucket } from "./lib/rateLimiter.js";
import { WebhookNotifier } from "./services/notifier.js";
import { TaskService } from "./services/taskService.js";

const log = createLogger("server");

/** Reads and parses a JSON request body, rejecting bodies over config.maxBodyBytes (1 MB). */
export async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > config.maxBodyBytes) throw new ValidationError("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("Body must be valid JSON");
  }
}

export function createServer(deps: { findUserByEmail: Parameters<typeof registerRoutes>[1]["findUserByEmail"] }) {
  const repo = new TaskRepository();
  const tasks = new TaskService(repo, new WebhookNotifier());
  const router = new Router();
  registerRoutes(router, { tasks, repo, findUserByEmail: deps.findUserByEmail });

  const limiter = new TokenBucket(config.rateLimit.capacity, config.rateLimit.refillPerSecond);
  setInterval(() => limiter.sweep(), 60_000).unref();

  return http.createServer(async (req, res) => {
    const started = Date.now();
    let result: HandlerResult;
    try {
      // Rate limit by client IP before doing any other work.
      const wait = limiter.take(req.socket.remoteAddress ?? "unknown");
      if (wait > 0) throw new RateLimitedError(wait);

      const url = new URL(req.url ?? "/", "http://localhost");
      result = await router.dispatch({
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: await readJsonBody(req),
      });
    } catch (err) {
      result = toErrorResponse(err);
    }

    res.writeHead(result.status, { "content-type": "application/json", ...result.headers });
    res.end(result.body === undefined ? undefined : JSON.stringify(result.body));
    log.info("request", { method: req.method, path: req.url, status: result.status, ms: Date.now() - started });
  });
}
