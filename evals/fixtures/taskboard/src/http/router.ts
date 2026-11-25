import { AppError, RateLimitedError } from "../errors.js";
import { createLogger } from "../lib/logger.js";

export interface RequestContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  user?: { id: string; role: "member" | "admin" };
}

export interface HandlerResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (ctx: RequestContext) => Promise<HandlerResult>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const log = createLogger("router");

/** Minimal router: `/tasks/:id/status` style patterns, first match wins. */
export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/:([a-zA-Z]+)/g, (_, k: string) => (keys.push(k), "([^/]+)")) + "/?$",
    );
    this.routes.push({ method: method.toUpperCase(), pattern, keys, handler });
    return this;
  }

  async dispatch(ctx: Omit<RequestContext, "params">): Promise<HandlerResult> {
    for (const r of this.routes) {
      const m = r.method === ctx.method ? r.pattern.exec(ctx.path) : null;
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try {
        return await r.handler({ ...ctx, params });
      } catch (err) {
        return toErrorResponse(err);
      }
    }
    return { status: 404, body: { error: "not_found" } };
  }
}

/**
 * Maps thrown errors to HTTP responses. AppError subclasses carry their own
 * status (404, 409, 422, 401, 429, …); anything else is a 500 and is logged.
 */
export function toErrorResponse(err: unknown): HandlerResult {
  if (err instanceof RateLimitedError) {
    return { status: 429, body: { error: err.code }, headers: { "retry-after": String(err.retryAfterSeconds) } };
  }
  if (err instanceof AppError) return { status: err.status, body: { error: err.code, message: err.message } };
  log.error("unhandled error", { error: String(err) });
  return { status: 500, body: { error: "internal" } };
}
