import { randomUUID } from "node:crypto";
import type { Task, TaskStatus } from "../models/task.js";
import { InMemoryStore, type Page } from "./store.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface ListTasksQuery {
  status?: TaskStatus;
  assigneeId?: string;
  cursor?: string | null;
  limit?: number;
  includeDeleted?: boolean;
}

export class TaskRepository {
  private store = new InMemoryStore<Task>("Task");

  create(input: Pick<Task, "title" | "description" | "status" | "assigneeId">): Task {
    const now = new Date().toISOString();
    return this.store.insert({ ...input, id: randomUUID(), createdAt: now, updatedAt: now, deletedAt: null });
  }

  get(id: string): Task {
    return this.store.get(id);
  }

  update(id: string, expectedVersion: number, patch: Partial<Omit<Task, "id" | "version" | "createdAt">>): Task {
    return this.store.update(id, expectedVersion, { ...patch, updatedAt: new Date().toISOString() });
  }

  /** Lists tasks (sorted by id) one page at a time. `limit` defaults to 20 and is clamped to MAX_PAGE_SIZE. */
  listTasks(q: ListTasksQuery = {}): Page<Task> {
    const limit = Math.min(Math.max(1, q.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    return this.store.list(
      (t) =>
        (q.includeDeleted || t.deletedAt === null) &&
        (!q.status || t.status === q.status) &&
        (!q.assigneeId || t.assigneeId === q.assigneeId),
      { cursor: q.cursor, limit },
    );
  }

  /** Soft delete: the row stays but is hidden from listTasks unless includeDeleted is set. */
  softDelete(id: string, expectedVersion: number): Task {
    return this.update(id, expectedVersion, { deletedAt: new Date().toISOString() });
  }
}
