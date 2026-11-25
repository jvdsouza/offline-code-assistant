import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import { HttpStatusError, retry } from "../lib/retry.js";

export interface WebhookEvent {
  type: "task.completed" | "task.assigned";
  taskId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

const log = createLogger("notifier");

/** Hex HMAC-SHA256 of the raw body, sent as X-Taskboard-Signature. */
export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Delivers webhook events to the configured URL. Failed deliveries are retried
 * with exponential backoff (see lib/retry.ts) up to `config.webhook.maxAttempts` times.
 */
export class WebhookNotifier {
  constructor(
    private url = config.webhook.url,
    private secret = config.webhook.secret,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async notify(event: WebhookEvent): Promise<void> {
    if (!this.url) return; // webhooks disabled
    const body = JSON.stringify(event);
    const { maxAttempts, baseDelayMs, maxDelayMs } = config.webhook;
    try {
      await retry(
        async (attempt) => {
          const res = await this.fetchImpl(this.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-taskboard-signature": signPayload(body, this.secret),
              "x-taskboard-attempt": String(attempt),
            },
            body,
          });
          if (!res.ok) throw new HttpStatusError(res.status);
        },
        { maxAttempts, baseDelayMs, maxDelayMs },
      );
    } catch (err) {
      // Delivery is best-effort: log and move on rather than failing the user's request.
      log.error("webhook delivery failed", { type: event.type, taskId: event.taskId, error: String(err) });
    }
  }
}
