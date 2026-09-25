/**
 * Eval THỰC TẾ qua LLM thật + embedding thật, trên một tệp JSONL câu hỏi (mặc định: content/eval/handwritten.jsonl).
 * Mỗi dòng: {"question": "...", "expected": "<template id> | ESCALATE | OFFTOPIC | GROUNDED | GROUNDED:<doc slug>", "lang"?: "de", "note"?: "..."}
 * Báo cáo: đúng/sai theo NHÁNH (FAST PATH / AI-RAG), theo ngôn ngữ, độ trễ, token, và danh sách câu sai kèm lý do bot đã ghi.
 * DB tạm trong bộ nhớ, kênh giả: không đụng dữ liệu đang chạy, không gửi tin cho ai.
 *
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/live-eval.ts [tệp.jsonl] [--mode=hybrid|llm_first|code_first] [--limit=N] [--out=báo-cáo.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { BotPipeline } from "../src/bot/pipeline";
import { ResponseResolver } from "../src/bot/resolver";
import type { Channel } from "../src/bot/types";
import { detectLanguage, looksVietnamese } from "../src/core/language";
import { loadPredicates } from "../src/core/predicates";
import { SettingsService } from "../src/core/settings";
import { migrate, openDb } from "../src/db/db";
import { convRepo } from "../src/db/repo-conv";
import { kbRepo } from "../src/db/repo-kb";
import { opsRepo } from "../src/db/repo-ops";
import { PgKnowledge } from "../src/kb/knowledge-search";
import { LiveContent } from "../src/kb/live-content";
import { seedContent } from "../src/kb/seed";
import { KbService } from "../src/kb/service";
import { ProviderChain, type CallRecord } from "../src/llm/chain";
import { LlmClient } from "../src/llm/client";
import { createEmbedder } from "../src/llm/embedder";
import { OpenAICompatProvider } from "../src/llm/openai-compat";
import { loadSkills } from "../src/llm/skills";

interface Case { question: string; expected: string | null; lang?: string; note?: string; image_type?: string }
interface Row { i: number; question: string; expected: string | null; got: string; ok: boolean; branch: string; lang: string; replyLang: string; ms: number; tokens: number; calls: number; reason: string; viLeak: boolean }

const env = process.env;
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const file = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "content/eval/handwritten.jsonl";
const mode = (arg("mode") ?? "hybrid") as "hybrid" | "llm_first" | "code_first";
const limit = Number(arg("limit") ?? 0);
if (!env.LLM_BASE_URL || !env.LLM_API_KEY) throw new Error("thiếu LLM_BASE_URL / LLM_API_KEY");

class Capture implements Channel {
  sent: { chatId: number; text: string }[] = [];
  async send(chatId: number, text: string) { this.sent.push({ chatId, text }); return { messageId: this.sent.length }; }
  async downloadImage(): Promise<{ mime: string; base64: string }> { throw new Error("eval này không dùng ảnh"); }
}

/** Nhãn kết quả có thể so với `expected` */
function outcomeLabel(d: { kind: string; template_id: string | null; via: string | null }, sources: string | null): string {
  if (d.kind === "TEMPLATE") return d.template_id ?? "TEMPLATE";
  if (d.kind === "GROUNDED") return sources ? `GROUNDED:${sources}` : "GROUNDED";
  return d.kind; // ESCALATE | OFFTOPIC | SECURITY | BLOCKED
}
/** expected: template id | esc-* (trigger chuyển nhân viên) | ESCALATE | OFFTOPIC | GROUNDED[:slug] | null (= chuyển nhân viên HOẶC ngoài phạm vi đều đúng) */
const matches = (expected: string | null, got: string) =>
  expected === null ? got === "ESCALATE" || got === "OFFTOPIC" : got === expected || (expected === "GROUNDED" && got.startsWith("GROUNDED")) || ((expected === "ESCALATE" || expected.startsWith("esc-")) && got === "ESCALATE");

async function main() {
  const cases: Case[] = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Case).filter((c) => !c.image_type);
  const picked = limit ? cases.slice(0, limit) : cases;
  const db = await openDb("pglite:memory");
  await migrate(db);
  const conv = convRepo(db), kb = kbRepo(db), ops = opsRepo(db);
  const embedder = createEmbedder({ EMBEDDING_URL: env.EMBEDDING_URL, EMBEDDING_MODEL: env.EMBEDDING_MODEL, EMBEDDING_API_KEY: env.EMBEDDING_API_KEY });
  const calls: CallRecord[] = [];
  const models = { fast: String(env.LLM_MODEL_FAST).split(/\s/)[0]!, strong: String(env.LLM_MODEL_STRONG).split(/\s/)[0]! };
  const modelsAll = { ...models, intake: models.fast };
  const chain = new ProviderChain([new OpenAICompatProvider(async () => ({ baseUrl: env.LLM_BASE_URL!, apiKey: env.LLM_API_KEY!, models: modelsAll }), "gateway")], { onCall: (r) => void calls.push(r) });
  const predicatesFile = "content/config/predicates.yml";
  const live = new LiveContent(db, kb, ops, embedder, predicatesFile);
  const llm = new LlmClient(chain, loadSkills("content"), () => true, async () => live.guide);
  const kbService = new KbService({ db, kb, ops, embedder, live, predicatesFallback: () => loadPredicates(predicatesFile) });
  await seedContent(kbService, kb, ops, db, { contentDir: "content", adminIds: [9001], ownerId: 9001 });
  await ops.setSetting("router.mode", mode, "live-eval");
  await live.rebuild();
  const settings = new SettingsService(ops, 0);
  const channel = new Capture();
  const resolver = new ResponseResolver(kb, llm, () => live.index, () => live.urlHosts);
  const pipeline = new BotPipeline({ db, conv, kb, ops, live, settings, resolver, channel, llm, knowledge: new PgKnowledge(kb, embedder), ownerId: 9001, adminWebUrl: "http://admin.local" });
  console.log(`eval thật · ${picked.length} câu từ ${file} · mode=${mode} · embedding=${embedder.version} · model nhanh=${models.fast} mạnh=${models.strong}\n`);

  const rows: Row[] = [];
  let update = 1;
  for (const [i, c] of picked.entries()) {
    const uid = 100_000 + i; // mỗi câu một khách mới: không ảnh hưởng ngữ cảnh lẫn nhau
    const before = calls.length, sentBefore = channel.sent.length, started = Date.now();
    await pipeline.handle({ chatId: uid, chatType: "private", userId: uid, name: `Eval ${i}`, username: `eval${i}`, isMention: true, at: new Date(), items: [{ updateId: update++, messageId: update, text: c.question }] });
    const ms = Date.now() - started;
    const d = (await db.query<{ kind: string; template_id: string | null; via: string | null; reason: string | null; notes: { notes?: string[] } | null }>("SELECT kind, template_id, via, reason, notes FROM decisions WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [uid])).rows[0]!;
    const out = (await db.query<{ language: string | null }>("SELECT language FROM messages WHERE user_id = $1 AND direction = 'out' ORDER BY id DESC LIMIT 1", [uid])).rows[0];
    const notes = d.notes?.notes ?? [];
    const branch = notes.some((n) => n.startsWith("nhánh: FAST PATH")) ? "FAST PATH" : notes.some((n) => n.startsWith("nhánh: AI/RAG") || n.includes("AI hiểu trước")) ? "AI/RAG" : d.kind === "OFFTOPIC" || notes.some((n) => n.startsWith("AI hiểu:")) ? "AI (hiểu)" : "CODE";
    const got = outcomeLabel(d, null);
    const mine = calls.slice(before);
    const replies = channel.sent.slice(sentBefore).map((s) => s.text);
    const lang = c.lang ?? detectLanguage(c.question) ?? "en";
    const row: Row = {
      i: i + 1, question: c.question, expected: c.expected, got, ok: matches(c.expected, got), branch, lang, replyLang: out?.language ?? "-", ms,
      tokens: mine.reduce((n, x) => n + x.usage.inputTokens + x.usage.outputTokens, 0), calls: mine.length,
      reason: [d.reason, ...notes.filter((n) => /^AI chọn|^AI hiểu|^AI viết|câu AI viết|chưa đủ chắc|kiểm duyệt FAST PATH|bỏ câu truy vấn|ràng buộc ngôn ngữ/.test(n))].filter(Boolean).join(" | ").slice(0, 900),
      viLeak: lang !== "vi" && replies.some(looksVietnamese),
    };
    rows.push(row);
    console.log(`${row.ok ? "✓" : "✗"} #${row.i} [${branch}] ${row.ms}ms ${row.tokens}tok · ${c.question.slice(0, 70)} → ${got}${row.ok ? "" : ` (mong đợi ${c.expected})`}${row.viLeak ? " ⛔ tiếng Việt lọt" : ""}`);
  }

  const by = <K extends keyof Row>(k: K) => {
    const m = new Map<string, Row[]>();
    for (const r of rows) m.set(String(r[k]), [...(m.get(String(r[k])) ?? []), r]);
    return [...m.entries()].map(([key, rs]) => `${key}: ${rs.filter((r) => r.ok).length}/${rs.length} đúng · trung bình ${Math.round(rs.reduce((n, r) => n + r.ms, 0) / rs.length)}ms · ${Math.round(rs.reduce((n, r) => n + r.tokens, 0) / rs.length)} token`).join("\n  ");
  };
  const ok = rows.filter((r) => r.ok).length;
  console.log(`\nKẾT QUẢ: ${ok}/${rows.length} đúng (${((ok / rows.length) * 100).toFixed(1)}%) · tổng ${calls.length} lời gọi AI · lỗi gọi AI ${calls.filter((c) => !c.ok).length} · tiếng Việt lọt: ${rows.filter((r) => r.viLeak).length}`);
  console.log(`Theo nhánh:\n  ${by("branch")}\nTheo ngôn ngữ:\n  ${by("lang")}`);
  const wrong = rows.filter((r) => !r.ok);
  if (wrong.length) console.log(`\nCÂU SAI (${wrong.length}):\n` + wrong.map((r) => `  #${r.i} [${r.branch}] "${r.question}"\n     mong đợi ${r.expected} · nhận ${r.got}\n     ${r.reason}`).join("\n"));
  const outFile = arg("out");
  if (outFile) writeFileSync(outFile, JSON.stringify({ file, mode, at: new Date().toISOString(), summary: { ok, total: rows.length }, rows }, null, 2));
  await db.close();
}
main().catch((e) => { console.error("live-eval lỗi:", e); process.exit(1); });
