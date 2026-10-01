/**
 * Eval THỰC TẾ cho nội dung VAULT: LLM thật + embedding thật + DB thật (CompositeKnowledge = vault + tài liệu cũ), trên một
 * tệp JSONL câu hỏi (mặc định: content/eval/vault-cases.jsonl). Khác với scripts/live-eval.ts (DB tạm trong bộ nhớ, chỉ nối
 * PgKnowledge — không bao giờ chạm tới note vault), script này dùng ĐÚNG DB đang chạy và ĐÚNG CompositeKnowledge như server
 * thật, nên là công cụ duy nhất bắt được lỗi chọn sai note vault (vd lỗi tiếng Việt "ways-to-earn-more-itlg" bị chọn nhầm
 * sang Ambassador, phát hiện 2026-09-29).
 *
 * Mỗi dòng: {"question": "...", "expected": "GROUNDED:<note_id> | GROUNDED | ESCALATE | OFFTOPIC | null", "lang"?: "vi", "note"?: "..."}
 * Ghi vào bảng users/episodes/messages/events thật với userId âm, xoá sạch bằng --cleanup. KHÔNG gửi tin cho ai (kênh giả).
 *
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/vault-eval.ts [tệp.jsonl] [--limit=N] [--out=báo-cáo.json] [--cleanup]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServices } from "../src/app";
import { loadConfig } from "../src/config";
import { ProviderChain } from "../src/llm/chain";
import { LlmClient } from "../src/llm/client";
import { OpenAICompatProvider } from "../src/llm/openai-compat";
import { BotPipeline } from "../src/bot/pipeline";
import { ResponseResolver } from "../src/bot/resolver";
import type { Channel, InboundBatch, MessageEntity } from "../src/bot/types";
import { detectLanguage, looksVietnamese } from "../src/core/language";

const BASE_ID = -900100000; // dải id giả riêng cho eval vault, không trùng chatId thật lẫn scripts/test-live-response.ts
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const file = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "content/eval/vault-cases.jsonl";
const limit = Number(arg("limit") ?? 0);
const cleanupOnly = process.argv.includes("--cleanup");

interface Case { question: string; expected: string | null; lang?: string; note?: string }
interface Row { i: number; question: string; expected: string | null; got: string; ok: boolean; lang: string; replyLang: string; ms: number; note?: string; reply: string }

class CapturingChannel implements Channel {
  sent: { text: string }[] = [];
  async send(_chatId: number, text: string) { this.sent.push({ text }); return { messageId: 1 }; }
  async downloadImage(): Promise<{ mime: string; base64: string }> { throw new Error("không dùng trong eval này"); }
}

function outcomeLabel(kind: string, templateId: string | null, chunkIds: string[]): string {
  if (kind === "TEMPLATE") return templateId ?? "TEMPLATE";
  if (kind === "GROUNDED") {
    const first = chunkIds[0];
    if (first?.startsWith("v:")) return `GROUNDED:${first.slice(2).split("#")[0]}`;
    return first ? "GROUNDED:legacy" : "GROUNDED";
  }
  return kind; // ESCALATE | OFFTOPIC | SECURITY | BLOCKED
}
const matches = (expected: string | null, got: string) =>
  expected === null ? got === "ESCALATE" || got === "OFFTOPIC" : got === expected || (expected === "GROUNDED" && got.startsWith("GROUNDED"));

async function main() {
  const cfg = loadConfig();
  const svc = await createServices(cfg, "worker", { seed: false });
  try {
    if (cleanupOnly) {
      await svc.db.query("DELETE FROM events WHERE user_id <= $1", [BASE_ID]);
      await svc.db.query("DELETE FROM messages WHERE user_id <= $1", [BASE_ID]);
      await svc.db.query("DELETE FROM episodes WHERE user_id <= $1", [BASE_ID]);
      await svc.db.query("DELETE FROM decisions WHERE user_id <= $1", [BASE_ID]);
      await svc.db.query("DELETE FROM antispam WHERE user_id <= $1", [BASE_ID]); // quan trọng: offtopic_count/blocked_until tích luỹ qua nhiều lần chạy nếu không dọn (phát hiện 2026-09-30)
      await svc.db.query("DELETE FROM users WHERE telegram_id <= $1", [BASE_ID]);
      console.log("Đã xoá dữ liệu eval vault (userId <=", BASE_ID, ")");
      return;
    }
    if (!cfg.LLM_BASE_URL) throw new Error("thiếu LLM_BASE_URL trong .env/.env.local");
    // Tự dọn sạch dải id trước MỖI lần chạy thật (không chỉ khi gọi --cleanup riêng): chạy nhiều lần trong ngày mà không
    // dọn antispam từng làm offtopic_count dồn lại rồi tự khoá đúng các id cố định dùng cho câu ngoài phạm vi, khiến kết
    // quả lần sau bị nhiễu bởi lần trước chứ không phải lỗi hệ thống thật (phát hiện 2026-09-30).
    for (const t of ["events", "messages", "episodes", "decisions", "antispam"]) await svc.db.query(`DELETE FROM ${t} WHERE user_id <= $1`, [BASE_ID]);
    await svc.db.query("DELETE FROM users WHERE telegram_id <= $1", [BASE_ID]);
    // --min-interval=<ms>: chỉ dùng khi cần chẩn đoán lại tình trạng nghẽn cổng LLM (mặc định tắt — xem
    // src/worker/runner.ts: nguyên nhân thật của đợt "escalate nhầm" 2026-09-30 là job cron bị xếp lặp lại, đã sửa ở gốc).
    const minIntervalMs = Number(arg("min-interval") ?? 0) || undefined;
    const chain = new ProviderChain([new OpenAICompatProvider({ baseUrl: cfg.LLM_BASE_URL, apiKey: cfg.LLM_API_KEY, models: { fast: cfg.LLM_MODEL_FAST, strong: cfg.LLM_MODEL_STRONG, intake: cfg.LLM_MODEL_FAST }, timeoutMs: 60_000 }, "gateway-host")], { minIntervalMs });
    const llm = new LlmClient(chain, () => svc.skills.get(), () => true, async () => { await svc.live.ensureFresh(10_000); return svc.live.guide; });

    const cases: Case[] = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Case);
    const picked = limit ? cases.slice(0, limit) : cases;
    const channel = new CapturingChannel();
    const resolver = new ResponseResolver(svc.kb, llm, () => svc.live.index, () => svc.live.urlHosts);
    const pipeline = new BotPipeline({
      db: svc.db, conv: svc.conv, kb: svc.kb, ops: svc.ops, live: svc.live, settings: svc.settings, resolver, channel, llm,
      knowledge: svc.knowledge, media: svc.media, ownerId: svc.cfg.ownerId, adminWebUrl: svc.cfg.PUBLIC_ADMIN_URL, log: svc.log,
    });

    console.log(`eval vault thật · ${picked.length} câu từ ${file} · router mode=${(await svc.settings.get())["router.mode"]}\n`);
    const rows: Row[] = [];
    // updateId chống trùng của Telegram dùng chung một không gian toàn cục (không tách theo user) — bắt đầu từ một mốc
    // riêng theo thời điểm chạy để không đụng updateId của các lần chạy script khác trong cùng phiên (vd test-live-response.ts).
    let update = Date.now() % 1_000_000_000;
    for (const [i, c] of picked.entries()) {
      const uid = BASE_ID - i;
      channel.sent = [];
      const t0 = Date.now();
      const batch: InboundBatch = { chatId: uid, chatType: "private", userId: uid, name: `Eval vault ${i}`, username: `eval_vault_${i}`, isMention: true, at: new Date(), items: [{ updateId: update++, messageId: update, text: c.question }] };
      const res = await pipeline.handle(batch);
      const ms = Date.now() - t0;
      const ev = (await svc.db.query<{ payload: { chunk_ids?: string[] } }>("SELECT payload FROM events WHERE user_id = $1 AND type = 'knowledge_sent' ORDER BY id DESC LIMIT 1", [uid])).rows[0];
      const out = (await svc.db.query<{ language: string | null }>("SELECT language FROM messages WHERE user_id = $1 AND direction = 'out' ORDER BY id DESC LIMIT 1", [uid])).rows[0];
      const got = outcomeLabel(res.decisionKind ?? "", null, ev?.payload?.chunk_ids ?? []);
      const lang = c.lang ?? detectLanguage(c.question) ?? "en";
      const reply = channel.sent.map((s) => s.text).join(" | ");
      const row: Row = { i: i + 1, question: c.question, expected: c.expected, got, ok: matches(c.expected, got), lang, replyLang: out?.language ?? "-", ms, note: c.note, reply };
      rows.push(row);
      const viLeak = lang !== "vi" && looksVietnamese(reply);
      console.log(`${row.ok ? "✓" : "✗"} #${row.i} ${row.ms}ms [${lang}] ${c.question.slice(0, 70)} → ${got}${row.ok ? "" : ` (mong đợi ${c.expected})`}${viLeak ? " ⛔ tiếng Việt lọt" : ""}`);
    }

    const ok = rows.filter((r) => r.ok).length;
    console.log(`\nKẾT QUẢ: ${ok}/${rows.length} đúng (${((ok / rows.length) * 100).toFixed(1)}%)`);
    const wrong = rows.filter((r) => !r.ok);
    if (wrong.length) console.log(`\nCÂU SAI (${wrong.length}):\n` + wrong.map((r) => `  #${r.i} "${r.question}"\n     mong đợi ${r.expected} · nhận ${r.got}${r.note ? `\n     ghi chú: ${r.note}` : ""}\n     trả lời: ${r.reply.slice(0, 300)}`).join("\n"));
    const outFile = arg("out");
    if (outFile) writeFileSync(outFile, JSON.stringify({ file, at: new Date().toISOString(), summary: { ok, total: rows.length }, rows }, null, 2));
  } finally {
    await svc.close();
  }
}
main().catch((e) => { console.error("vault-eval lỗi:", e); process.exit(1); });
