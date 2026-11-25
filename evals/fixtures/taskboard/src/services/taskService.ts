import type { TaskRepository } from "../db/taskRepo.js";
import { InvalidTransitionError, ValidationError } from "../errors.js";
import { canTransition, TaskStatus, type Task } from "../models/task.js";
import type { WebhookNotifier } from "./notifier.js";

export class TaskService {
  constructor(
    private repo: TaskRepository,
    private notifier: WebhookNotifier,
  ) {}

  create(title: string, description = "", assigneeId: string | null = null): Task {
    const trimmed = title.trim();
    if (!trimmed) throw new ValidationError("Title is required");
    if (trimmed.length > 200) throw new ValidationError("Title must be at most 200 characters");
    return this.repo.create({ title: trimmed, description, status: TaskStatus.Todo, assigneeId });
  }

  /**
   * Moves a task to a new status if the workflow allows it. Completing a task
   * (moving it to done) sends a task.completed webhook.
   */
  async updateStatus(id: string, to: TaskStatus, expectedVersion: number): Promise<Task> {
    const task = this.repo.get(id);
    if (!canTransition(task.status, to)) throw new InvalidTransitionError(task.status, to);
    const updated = this.repo.update(id, expectedVersion, { status: to });
    if (to === TaskStatus.Done) {
      await this.notifier.notify({
        type: "task.completed",
        taskId: id,
        occurredAt: updated.updatedAt,
        data: { title: updated.title, assigneeId: updated.assigneeId },
      });
    }
    return updated;
  }

  async assign(id: string, assigneeId: string, expectedVersion: number): Promise<Task> {
    const updated = this.repo.update(id, expectedVersion, { assigneeId });
    await this.notifier.notify({ type: "task.assigned", taskId: id, occurredAt: updated.updatedAt, data: { assigneeId } });
    return updated;
  }
}
