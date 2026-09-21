/**
 * Lớp truy cập DB mỏng, chạy trên cả `pg` (production) và PGlite (Postgres nhúng dùng cho test / demo một tiến trình).
 * Cả hai đều là PostgreSQL thật, nên cùng một bộ SQL và migration.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  readonly kind: "pg" | "pglite";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Chạy script nhiều câu lệnh, không tham số (migration). */
  exec(sql: string): Promise<void>;
  /** Chạy trong một transaction; tự ROLLBACK khi lỗi. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgDb implements Db {
  readonly kind = "pg" as const;
  constructor(private readonly runner: pg.Pool | pg.PoolClient, private readonly pool?: pg.Pool) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.runner.query(sql, params as unknown[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.runner.query(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.pool) return fn(this); // đã ở trong transaction: dùng lại
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(new PgDb(client));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool?.end();
  }
}

// PGlite được nạp động để bản production không phải tải nó.
type PGliteLike = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: PGliteLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

class PgliteDb implements Db {
  readonly kind = "pglite" as const;
  constructor(private readonly p: PGliteLike, private readonly inTx = false) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.p.query(sql, params);
    return { rows: r.rows as T[], rowCount: Math.max(r.rows.length, r.affectedRows ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    await this.p.exec(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return this.p.transaction((tx) => fn(new PgliteDb(tx, true)));
  }

  async close() {
    if (!this.inTx) await this.p.close();
  }
}

/**
 * url:
 *   postgres://user:pass@host:5432/db   -> pg
 *   pglite:memory                       -> PGlite trong RAM (test)
 *   pglite:./data/pgdata                -> PGlite lưu đĩa (demo một tiến trình)
 */
export async function openDb(url: string): Promise<Db> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const dir = url.slice("pglite:".length);
    if (dir !== "memory" && dir !== "") mkdirSync(dirname(dir), { recursive: true }); // PGlite chỉ tạo thư mục cuối, không tạo thư mục cha (lần chạy đầu chưa có data/)
    const p = new PGlite({ ...(dir === "memory" || dir === "" ? {} : { dataDir: dir }), extensions: { vector } });
    await p.waitReady;
    return new PgliteDb(p as unknown as PGliteLike);
  }
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) });
  return new PgDb(pool, pool);
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    await db.tx(async (t) => {
      // PGlite/pg đều chạy được nhiều câu lệnh trong một lần nếu không có tham số.
      await t.exec(sql);
      await t.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    });
    applied.push(f);
  }
  return applied;
}

/** Chuẩn hoá kiểu số nguyên lớn (pg trả bigint dạng chuỗi, PGlite trả number/bigint). */
export const num = (v: unknown): number => (v === null || v === undefined ? NaN : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const iso = (d: Date) => d.toISOString();
