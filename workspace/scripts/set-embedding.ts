/**
 * Đặt cấu hình embedding NGOÀI vào DB đang chạy bằng đúng cơ chế của Admin Web (khoá mã hoá bằng SECRETS_KEY), rồi xếp job đánh chỉ mục.
 * Dùng khi chưa đăng nhập được Admin Web. Khoá lấy từ biến môi trường EMBEDDING_API_KEY_SET (không ghi vào file).
 *   EMBEDDING_API_KEY_SET=sk-... npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/set-embedding.ts --url=https://platform.beeknoee.com/v1 --model=gemini-embedding-001 [--dimensions=768]
 */
import { openDb } from "../src/db/db";
import { opsRepo } from "../src/db/repo-ops";
import { EmbeddingConfig } from "../src/llm/embedding-config";
import { HttpEmbedder } from "../src/llm/embedder";
import { SecretBox } from "../src/llm/secret-box";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const url = arg("url");
const model = arg("model");
const dims = arg("dimensions") ? Number(arg("dimensions")) : undefined;
const apiKey = process.env.EMBEDDING_API_KEY_SET;
if (!process.env.DATABASE_URL || !process.env.SECRETS_KEY) throw new Error("cần DATABASE_URL và SECRETS_KEY trong .env");
if (!url || !model) throw new Error("cần --url và --model");

async function main() {
  const probe = new HttpEmbedder({ url: url!, apiKey, model: model!, dimensions: dims });
  const t0 = Date.now();
  const [v] = await probe.embed(["InterLink support bot embedding probe"]);
  console.log(`thử API: ${probe.version} -> ${v?.length} chiều, ${Date.now() - t0} ms`);

  const db = await openDb(process.env.DATABASE_URL!);
  const ops = opsRepo(db);
  const cfg = new EmbeddingConfig(ops, new SecretBox(process.env.SECRETS_KEY!), 0);
  await cfg.save({ baseUrl: url!, model: model!, dimensions: dims ?? null, ...(apiKey ? { apiKey } : {}) }, "script:set-embedding");
  const view = await cfg.view();
  console.log("đã lưu:", { baseUrl: view.baseUrl, model: view.model, dimensions: view.dimensions, hasKey: view.hasKey, keyHint: view.keyHint });
  await ops.enqueueJob("reindex-embeddings", {}, { dedupeKey: "reindex:set-embedding" });
  console.log("đã xếp job reindex-embeddings cho worker");
  await db.close();
}
main().catch((e) => { console.error("lỗi:", (e as Error).message); process.exit(1); });
