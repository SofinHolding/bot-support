import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDb, type Db } from "../src/db/db";

let db: Db;
beforeAll(async () => {
  db = await openDb("pglite:memory");
});
afterAll(async () => db.close());

describe("PGlite + migration", () => {
  it("chạy migration, có pgvector và tsvector", async () => {
    const applied = await migrate(db);
    expect(applied).toEqual(["001_init.sql"]);
    expect(await migrate(db)).toEqual([]); // idempotent

    await db.query("INSERT INTO kb_documents (slug, title, kind) VALUES ('d', 'D', 'knowledge')");
    const v = await db.query<{ id: string }>("INSERT INTO kb_document_versions (slug, version, source_md, status) VALUES ('d', 1, 'x', 'published') RETURNING id");
    await db.query(
      "INSERT INTO kb_chunks (version_id, doc_slug, chunk_index, chunk_hash, heading, text, search_text, tsv, embedding, embedding_model) VALUES ($1, 'd', 0, 'h', 'H', 'hello world token', 'hello world token', to_tsvector('simple', 'hello world token'), $2::vector, 'm')",
      [v.rows[0]!.id, "[1,0,0]"],
    );
    const r = await db.query<{ heading: string; dist: number }>("SELECT heading, (embedding <=> $1::vector)::float8 AS dist FROM kb_chunks ORDER BY embedding <=> $1::vector LIMIT 1", ["[1,0,0]"]);
    expect(r.rows[0]).toMatchObject({ heading: "H", dist: 0 });
    const t = await db.query("SELECT 1 FROM kb_chunks WHERE tsv @@ to_tsquery('simple', 'token | nothing')");
    expect(t.rowCount).toBe(1);
  });

  it("transaction tự rollback khi lỗi", async () => {
    await expect(
      db.tx(async (t) => {
        await t.query("INSERT INTO settings (key, value) VALUES ('k', '1'::jsonb)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await db.query("SELECT 1 FROM settings WHERE key = 'k'")).rowCount).toBe(0);
  });

  it("ràng buộc unique cho idempotency webhook", async () => {
    const a = await db.query("INSERT INTO inbound_updates (telegram_update_id) VALUES (42) ON CONFLICT DO NOTHING RETURNING telegram_update_id");
    const b = await db.query("INSERT INTO inbound_updates (telegram_update_id) VALUES (42) ON CONFLICT DO NOTHING RETURNING telegram_update_id");
    expect([a.rowCount, b.rowCount]).toEqual([1, 0]);
  });
});
