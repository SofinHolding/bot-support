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
    expect(applied).toEqual([
      "001_init.sql",
      "002_secrets.sql",
      "003_guide_kind.sql",
      "004_chunk_embeddings.sql",
      "005_kb_conflicts.sql",
      "006_items.sql",
      "007_content_history.sql",
      "008_supersedes.sql",
      "009_pair_reviews.sql",
      "010_memory_episode.sql",
      "011_vault.sql",
      "012_vault_merge_prompts.sql",
      "013_knowledge_governance.sql",
      "014_audit_hardening.sql",
      "015_ragflow_index_payload_refresh.sql",
    ]);
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

  it("Knowledge Governance: một knowledge unit chỉ có tối đa một ACTIVE version", async () => {
    const source = "00000000-0000-4000-8000-000000000001";
    const unit = "00000000-0000-4000-8000-000000000002";
    await db.query(
      "INSERT INTO knowledge_sources(id,file_name,content_hash) VALUES($1,'support.txt','source-hash')",
      [source],
    );
    await db.query("INSERT INTO knowledge_units(id,knowledge_key) VALUES($1,'account.forgot_login_id')", [unit]);
    await db.query(
      `INSERT INTO knowledge_versions
       (id,knowledge_unit_id,source_id,version_number,status,content,source_priority,uploaded_at,content_hash)
       VALUES('00000000-0000-4000-8000-000000000003',$1,$2,1,'active','contact support',50,now(),'v1')`,
      [unit, source],
    );
    await expect(
      db.query(
        `INSERT INTO knowledge_versions
         (id,knowledge_unit_id,source_id,version_number,status,content,source_priority,uploaded_at,content_hash)
         VALUES('00000000-0000-4000-8000-000000000004',$1,$2,2,'active','recover in app',50,now(),'v2')`,
        [unit, source],
      ),
    ).rejects.toThrow();
    await db.query(
      `UPDATE knowledge_versions SET status='superseded'
       WHERE id='00000000-0000-4000-8000-000000000003'`,
    );
    await db.query(
      `INSERT INTO knowledge_versions
       (id,knowledge_unit_id,source_id,version_number,status,content,source_priority,uploaded_at,content_hash)
       VALUES('00000000-0000-4000-8000-000000000004',$1,$2,2,'active','recover in app',50,now(),'v2')`,
      [unit, source],
    );
    expect(
      (await db.query("SELECT content FROM knowledge_versions WHERE knowledge_unit_id=$1 AND status='active'", [unit])).rows,
    ).toEqual([{ content: "recover in app" }]);
  });
});
