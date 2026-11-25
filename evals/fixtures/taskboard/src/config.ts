export const TOKEN_ISSUER = "taskboard";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  /** HMAC secret for access tokens. */
  tokenSecret: process.env.TOKEN_SECRET ?? "dev-only-secret",
  /** Access tokens are short-lived: 15 minutes. */
  tokenTtlSeconds: 15 * 60,
  /** Refresh tokens last 7 days. */
  refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
  passwordMinLength: 10,
  maxBodyBytes: 1024 * 1024,
  rateLimit: {
    capacity: 60,
    refillPerSecond: 1,
  },
  webhook: {
    url: process.env.WEBHOOK_URL ?? "",
    secret: process.env.WEBHOOK_SECRET ?? "",
    maxAttempts: 5,
    baseDelayMs: 250,
    maxDelayMs: 8000,
  },
};
