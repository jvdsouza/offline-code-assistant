import * as lancedb from "@lancedb/lancedb";

export interface ChunkRow {
  id: string;
  path: string;
  language: string;
  kind: string;
  symbol: string;
  start_line: number;
  end_line: number;
  text: string;
  vector: number[];
  [key: string]: unknown;
}

export interface SearchHit extends Omit<ChunkRow, "vector"> {
  score: number; // cosine similarity, higher = better
}

const TABLE = "chunks";

/** Small LanceDB wrapper: one table of code chunks per indexed repo. */
export class VectorStore {
  private constructor(
    private db: lancedb.Connection,
    private table: lancedb.Table | null,
  ) {}

  static async open(dir: string): Promise<VectorStore> {
    const db = await lancedb.connect(dir);
    const names = await db.tableNames();
    const table = names.includes(TABLE) ? await db.openTable(TABLE) : null;
    return new VectorStore(db, table);
  }

  async add(rows: ChunkRow[]): Promise<void> {
    if (!rows.length) return;
    if (!this.table) {
      // Schema is inferred from the first batch; a column named `vector` becomes the vector column.
      this.table = await this.db.createTable(TABLE, rows);
    } else {
      await this.table.add(rows);
    }
  }

  async deleteByPaths(paths: string[]): Promise<void> {
    if (!this.table || !paths.length) return;
    for (let i = 0; i < paths.length; i += 200) {
      const list = paths.slice(i, i + 200).map(sqlString).join(", ");
      await this.table.delete(`path IN (${list})`);
    }
  }

  async reset(): Promise<void> {
    if (this.table) await this.db.dropTable(TABLE);
    this.table = null;
  }

  async count(): Promise<number> {
    return this.table ? this.table.countRows() : 0;
  }

  async search(vector: number[], k: number, pathPrefix?: string): Promise<SearchHit[]> {
    if (!this.table) return [];
    let q = this.table.vectorSearch(vector).distanceType("cosine").limit(k);
    if (pathPrefix) q = q.where(`path LIKE ${sqlString(pathPrefix.replace(/[%_]/g, "") + "%")}`);
    const rows = (await q.toArray()) as (ChunkRow & { _distance: number })[];
    return rows.map(({ vector: _v, _distance, ...rest }) => ({ ...rest, score: 1 - _distance }));
  }
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
