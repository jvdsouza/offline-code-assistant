/** Base class for errors that map to an HTTP response. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`, 404, "not_found");
  }
}

/** Thrown when an update is based on a stale version of a record. */
export class ConflictError extends AppError {
  constructor(id: string, expected: number, actual: number) {
    super(`Record ${id} was modified (expected version ${expected}, found ${actual})`, 409, "conflict");
  }
}

/** Thrown when a task status change is not allowed by the workflow. */
export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string) {
    super(`Cannot move a task from ${from} to ${to}`, 422, "invalid_transition");
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "validation_failed");
  }
}

export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many requests", 429, "rate_limited");
  }
}
