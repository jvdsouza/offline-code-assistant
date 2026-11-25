import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { verifyPassword } from "../auth/password.js";
import { issueTokenPair } from "../auth/tokens.js";
import type { TaskRepository } from "../db/taskRepo.js";
import { AppError, ValidationError } from "../errors.js";
import { isTaskStatus } from "../models/task.js";
import type { TaskService } from "../services/taskService.js";
import type { Router } from "./router.js";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: "member" | "admin";
}

export interface Deps {
  tasks: TaskService;
  repo: TaskRepository;
  findUserByEmail(email: string): Promise<UserRecord | null>;
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
}

export function registerRoutes(router: Router, deps: Deps): void {
  // Login: verifies the password and returns an access + refresh token pair.
  router.add("POST", "/auth/login", async (ctx) => {
    const email = field(ctx.body, "email");
    const password = field(ctx.body, "password");
    if (typeof email !== "string" || typeof password !== "string") throw new ValidationError("email and password are required");
    const user = await deps.findUserByEmail(email.toLowerCase());
    // Same error for unknown email and wrong password, so attackers can't probe for accounts.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new AppError("Invalid email or password", 401, "invalid_credentials");
    }
    return { status: 200, body: issueTokenPair({ sub: user.id, role: user.role }) };
  });

  router.add("POST", "/tasks", requireAuth(async (ctx) => {
    const title = field(ctx.body, "title");
    if (typeof title !== "string") throw new ValidationError("title is required");
    const description = field(ctx.body, "description");
    return { status: 201, body: deps.tasks.create(title, typeof description === "string" ? description : "") };
  }));

  router.add("GET", "/tasks", requireAuth(async (ctx) => {
    const status = ctx.query.get("status");
    if (status && !isTaskStatus(status)) throw new ValidationError(`Unknown status "${status}"`);
    const page = deps.repo.listTasks({
      status: status && isTaskStatus(status) ? status : undefined,
      assigneeId: ctx.query.get("assignee") ?? undefined,
      cursor: ctx.query.get("cursor"),
      limit: ctx.query.has("limit") ? Number(ctx.query.get("limit")) : undefined,
    });
    return { status: 200, body: page };
  }));

  router.add("PATCH", "/tasks/:id/status", requireAuth(async (ctx) => {
    const status = field(ctx.body, "status");
    const version = field(ctx.body, "version");
    if (!isTaskStatus(status)) throw new ValidationError("status must be one of todo, in_progress, done, archived");
    if (typeof version !== "number") throw new ValidationError("version is required");
    return { status: 200, body: await deps.tasks.updateStatus(ctx.params.id, status, version) };
  }));

  router.add("DELETE", "/tasks/:id", requireAdmin(async (ctx) => {
    const version = Number(ctx.query.get("version"));
    deps.repo.softDelete(ctx.params.id, version);
    return { status: 204 };
  }));
}
