import type { Handler, RequestContext } from "../http/router.js";
import { TokenError, verifyToken } from "./tokens.js";

/**
 * Wraps a handler so it only runs for authenticated requests.
 * Reads `Authorization: Bearer <token>`, verifies it and sets `ctx.user`.
 */
export function requireAuth(handler: Handler): Handler {
  return async (ctx: RequestContext) => {
    const header = ctx.headers["authorization"];
    const match = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header) : null;
    if (!match) throw new TokenError("malformed");
    const claims = verifyToken(match[1]);
    ctx.user = { id: claims.sub, role: claims.role };
    return handler(ctx);
  };
}

/** Like requireAuth, but also requires the admin role. */
export function requireAdmin(handler: Handler): Handler {
  return requireAuth(async (ctx) => {
    if (ctx.user?.role !== "admin") return { status: 403, body: { error: "forbidden" } };
    return handler(ctx);
  });
}
