export type Level = "debug" | "info" | "warn" | "error";

/** Keys whose values are replaced with "[redacted]" before a log line is written. */
const REDACTED_KEYS = new Set(["password", "token", "authorization", "refreshToken"]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED_KEYS.has(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

/** Writes one JSON object per line to stdout. */
export function createLogger(scope: string, write: (line: string) => void = (l) => process.stdout.write(l + "\n")) {
  const log = (level: Level, msg: string, fields: Record<string, unknown> = {}) =>
    write(JSON.stringify({ time: new Date().toISOString(), level, scope, msg, ...(redact(fields) as object) }));
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
  };
}

export type Logger = ReturnType<typeof createLogger>;
