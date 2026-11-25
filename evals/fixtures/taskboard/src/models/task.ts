export enum TaskStatus {
  Todo = "todo",
  InProgress = "in_progress",
  Done = "done",
  Archived = "archived",
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Incremented on every write; used for optimistic locking. */
  version: number;
}

/** The task workflow: which status each status may move to. */
export const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.Todo]: [TaskStatus.InProgress, TaskStatus.Archived],
  [TaskStatus.InProgress]: [TaskStatus.Done, TaskStatus.Todo],
  [TaskStatus.Done]: [TaskStatus.Archived, TaskStatus.InProgress],
  [TaskStatus.Archived]: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (Object.values(TaskStatus) as string[]).includes(value);
}
