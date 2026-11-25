import { ConflictError, NotFoundError } from "../errors.js";

export interface Versioned {
  id: string;
  version: number;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` to get the next page; null when there are no more items. */
  nextCursor: string | null;
}

/**
 * In-memory table with optimistic locking: every update must say which version
 * it was based on, and fails with ConflictError if someone else wrote first.
 */
export class InMemoryStore<T extends Versioned> {
  private rows = new Map<string, T>();

  constructor(private entity: string) {}

  insert(row: Omit<T, "version">): T {
    const created = { ...row, version: 1 } as T;
    this.rows.set(created.id, created);
    return created;
  }

  get(id: string): T {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError(this.entity, id);
    return row;
  }

  update(id: string, expectedVersion: number, patch: Partial<Omit<T, "id" | "version">>): T {
    const current = this.get(id);
    if (current.version !== expectedVersion) throw new ConflictError(id, expectedVersion, current.version);
    const next = { ...current, ...patch, version: current.version + 1 };
    this.rows.set(id, next);
    return next;
  }

  delete(id: string): void {
    if (!this.rows.delete(id)) throw new NotFoundError(this.entity, id);
  }

  /**
   * Cursor pagination over rows sorted by id. The cursor is the base64url-encoded
   * id of the last item on the previous page.
   */
  list(filter: (row: T) => boolean, opts: { cursor?: string | null; limit: number }): Page<T> {
    const after = opts.cursor ? Buffer.from(opts.cursor, "base64url").toString("utf8") : null;
    const sorted = [...this.rows.values()].filter(filter).sort((a, b) => a.id.localeCompare(b.id));
    const start = after ? sorted.findIndex((r) => r.id > after) : 0;
    const items = start === -1 ? [] : sorted.slice(start, start + opts.limit);
    const last = items.at(-1);
    const hasMore = start !== -1 && start + opts.limit < sorted.length;
    return { items, nextCursor: hasMore && last ? Buffer.from(last.id).toString("base64url") : null };
  }
}
