/**
 * Xoá vector của các model embedding CŨ, chỉ giữ lại đúng một model đang chọn (mặc định: model external hiện hành,
 * "http:gemini-embedding-001@3072"). Chạy SAU khi đã đánh chỉ mục lại toàn bộ và xác nhận 100% đoạn có vector model mới —
 * script tự kiểm tra điều kiện này trước, không đủ 100% thì KHÔNG xoá gì.
 *
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/purge-old-embedding-models.ts [--model=http:gemini-embedding-001@3072] --yes
 */
import { loadConfig } from "../src/config";
import { openDb } from "../src/db/db";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const yes = process.argv.includes("--yes");

async function main() {
  const cfg = loadConfig();
  const db = await openDb(cfg.DATABASE_URL);
  const keep = arg("model") ?? "http:gemini-embedding-001@3072";

  const missingVault = await db.query<{ n: number }>(`SELECT count(*)::int n FROM vault_chunks c WHERE NOT EXISTS (SELECT 1 FROM vault_chunk_vectors v WHERE v.chunk_id = c.chunk_id AND v.model = $1)`, [keep]);
  const missingKb = await db.query<{ n: number }>(`SELECT count(*)::int n FROM kb_chunks c WHERE NOT EXISTS (SELECT 1 FROM kb_chunk_embeddings e WHERE e.chunk_id = c.id AND e.model = $1)`, [keep]);
  const missingVaultN = missingVault.rows[0]?.n ?? 0;
  const missingKbN = missingKb.rows[0]?.n ?? 0;
  console.log(`Model giữ lại: ${keep}`);
  console.log(`Còn thiếu vector model này: vault = ${missingVaultN} · tài liệu cũ = ${missingKbN}`);
  if (missingVaultN > 0 || missingKbN > 0) {
    console.log("DỪNG: chưa đủ 100% đoạn có vector của model giữ lại. Chạy `npm run` job reindex-embeddings/vault-index cho xong trước, rồi chạy lại script này.");
    await db.close();
    return;
  }

  const before = await db.query(`SELECT model, count(*)::int n FROM vault_chunk_vectors GROUP BY model UNION ALL SELECT 'kb:' || model, count(*)::int FROM kb_chunk_embeddings GROUP BY model`);
  console.log("\nSẽ xoá mọi vector KHÔNG thuộc model trên. Hiện trạng trước khi xoá:", before.rows);

  if (!yes) {
    console.log("\n(chạy thử — chưa xoá gì) Thêm --yes vào cuối lệnh để xoá thật.");
    await db.close();
    return;
  }

  const delVault = await db.query(`DELETE FROM vault_chunk_vectors WHERE model <> $1`, [keep]);
  const delKb = await db.query(`DELETE FROM kb_chunk_embeddings WHERE model <> $1`, [keep]);
  console.log(`\nĐã xoá: vault_chunk_vectors ${delVault.rowCount} dòng · kb_chunk_embeddings ${delKb.rowCount} dòng.`);

  const after = await db.query(`SELECT model, count(*)::int n FROM vault_chunk_vectors GROUP BY model UNION ALL SELECT 'kb:' || model, count(*)::int FROM kb_chunk_embeddings GROUP BY model`);
  console.log("Sau khi xoá:", after.rows);
  await db.close();
}
main().catch((e) => { console.error("lỗi:", e.message); process.exit(1); });
