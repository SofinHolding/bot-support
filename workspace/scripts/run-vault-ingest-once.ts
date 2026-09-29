/**
 * Chạy MỘT LẦN luồng nạp vault thật (SKILL + LLM + embedding thật) cho một tệp cụ thể, không qua Admin Web/worker container
 * (container đang chạy chưa có code vault). Dùng để đưa dữ liệu đã rà soát vào `knowledge/` trước khi triển khai bản mới.
 * Không gửi Telegram (không gọi vault-conflict-notify): xung đột (nếu có) chỉ nằm trong DB, xem trên Admin Web sau khi triển khai.
 *
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/run-vault-ingest-once.ts --file=.staging/vault-source/V1-nguon-sach.xlsx --name="Rà soát V1"
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServices } from "../src/app";
import { loadConfig } from "../src/config";
import { rawFileName } from "../src/admin/vault-routes";
import { ProviderChain } from "../src/llm/chain";
import { LlmClient } from "../src/llm/client";
import { OpenAICompatProvider } from "../src/llm/openai-compat";
import { runIngest, type VaultJobDeps } from "../src/vault/ingest";
import { runIndex } from "../src/vault/indexer";
import { VaultStore } from "../src/vault/store";

const arg = (k: string, d?: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const file = arg("file");
const displayName = arg("name", file?.split(/[\\/]/).pop())!;
if (!file) throw new Error('thiếu --file="đường dẫn tệp nguồn sạch"');

const cfg = loadConfig();
const svc = await createServices(cfg, "worker");
try {
  // Cấu hình gateway lưu trong DB trỏ host.docker.internal (đúng khi chạy TRONG container). Script này chạy từ host nên
  // dùng thẳng LLM_BASE_URL trong .env(.local) (localhost:20128) — không đụng vào cấu hình đã lưu cho container thật.
  if (!cfg.LLM_BASE_URL) throw new Error("thiếu LLM_BASE_URL trong .env/.env.local");
  // Lô thật (~12.000 ký tự/lượt, tối đa 8000 token đầu ra) lâu hơn timeout mặc định 30s của provider; nới riêng cho script này.
  const chain = new ProviderChain([new OpenAICompatProvider({ baseUrl: cfg.LLM_BASE_URL, apiKey: cfg.LLM_API_KEY, models: { fast: cfg.LLM_MODEL_FAST, strong: cfg.LLM_MODEL_STRONG, intake: cfg.LLM_MODEL_FAST }, timeoutMs: 180_000 }, "gateway-host")]);
  const llm = new LlmClient(chain, () => svc.skills.get());
  mkdirSync(cfg.RAW_DATA_DIR, { recursive: true });
  const raw = rawFileName(cfg.RAW_DATA_DIR, file, new Date().toISOString().slice(0, 10));
  copyFileSync(file, join(cfg.RAW_DATA_DIR, raw));
  const batchId = await svc.vault.createBatch(displayName, raw, "cli:run-vault-ingest-once");
  console.log(`Batch #${batchId}, tệp raw-data/${raw}`);

  const deps: VaultJobDeps = {
    store: VaultStore.open(cfg.VAULT_DIR, svc.vault), repo: svc.vault, llm, rawDir: cfg.RAW_DATA_DIR, now: () => new Date(), log: svc.log,
    enqueue: async () => true, // không xếp job nền: chạy index ngay dưới đây trong cùng tiến trình
  };
  const report = await runIngest(deps, batchId);
  console.log(JSON.stringify(report, null, 2));

  console.log("\n--- đánh chỉ mục (chunk + embed) ---");
  let idxReport;
  do {
    idxReport = await runIndex({ store: deps.store, repo: svc.vault, embedder: svc.embedder, log: svc.log });
    console.log(JSON.stringify(idxReport, null, 2));
  } while (idxReport.remaining > 0);

  const conflicts = await svc.vault.listConflicts(["open", "sent"]);
  if (conflicts.length) {
    console.log(`\n⚠️ ${conflicts.length} xung đột đang chờ duyệt (xem Admin Web sau khi triển khai bản mới, hoặc bảng ingest_conflicts):`);
    for (const c of conflicts) console.log(`  #${c.id} [${c.type}] ${c.versionGroup}: ${c.candidates.map((x) => x.label + ":" + x.noteId).join(", ")}`);
  } else {
    console.log("\nKhông có xung đột nào.");
  }
} finally {
  await svc.close();
}
