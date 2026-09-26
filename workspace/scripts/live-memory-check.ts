/**
 * Kiểm tra THỰC TẾ các tính năng memory (huong-dan-memory v3) với LLM thật (gateway trong .env) + embedding thật, DB tạm trong
 * bộ nhớ (PGlite), kênh Telegram giả: không đụng dữ liệu đang chạy, không gửi tin cho ai. Báo cáo ghi vào .staging/.
 *
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/live-memory-check.ts [--only=S1,S4]
 */
import { writeFileSync } from "node:fs";
import { BotPipeline } from "../src/bot/pipeline";
import { ResponseResolver } from "../src/bot/resolver";
import type { Channel, MessageEntity } from "../src/bot/types";
import { looksVietnamese } from "../src/core/language";
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
import type { JsonRequest, LlmProvider } from "../src/llm/types";
import { HANDLERS, type JobContext } from "../src/worker/jobs";

const env = process.env;
if (!env.LLM_BASE_URL || !env.LLM_API_KEY) throw new Error("thiếu LLM_BASE_URL / LLM_API_KEY");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";

class Capture implements Channel {
  sent: { chatId: number; text: string; entities?: MessageEntity[] }[] = [];
  async send(chatId: number, text: string, opts?: { entities?: MessageEntity[] }) {
    this.sent.push({ chatId, text, ...(opts?.entities ? { entities: opts.entities } : {}) });
    return { messageId: this.sent.length };
  }
  async downloadImage(): Promise<{ mime: string; base64: string }> {
    throw new Error("không dùng ảnh trong kiểm tra này");
  }
}

/** Provider bọc: ghi lại chữ gửi cho AI (kiểm tra không có bí mật của khách), và giả lập mất kết nối khi cần. */
class Recorder implements LlmProvider {
  readonly name = "gateway";
  down = false;
  inputs: { purpose: string; text: string }[] = [];
  constructor(private readonly inner: LlmProvider) {}
  async generateJson<T>(req: JsonRequest<T>) {
    this.inputs.push({ purpose: req.purpose, text: req.user.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n") });
    if (this.down) {
      const { ProviderUnavailableError } = await import("../src/llm/types");
      throw new ProviderUnavailableError("giả lập mất kết nối");
    }
    return this.inner.generateJson(req);
  }
}

interface Check { name: string; ok: boolean; detail: string }
interface Scenario { id: string; title: string; checks: Check[]; transcript: string[]; calls: number; tokens: number; ms: number }

async function main() {
  const db = await openDb("pglite:memory");
  await migrate(db);
  const conv = convRepo(db), kb = kbRepo(db), ops = opsRepo(db);
  const embedder = createEmbedder({ EMBEDDING_URL: env.EMBEDDING_URL, EMBEDDING_MODEL: env.EMBEDDING_MODEL, EMBEDDING_API_KEY: env.EMBEDDING_API_KEY });
  const calls: CallRecord[] = [];
  const models = { fast: String(env.LLM_MODEL_FAST).split(/\s/)[0]!, strong: String(env.LLM_MODEL_STRONG).split(/\s/)[0]! };
  const rec = new Recorder(new OpenAICompatProvider(async () => ({ baseUrl: env.LLM_BASE_URL!, apiKey: env.LLM_API_KEY!, models: { ...models, intake: models.fast } }), "gateway"));
  const chain = new ProviderChain([rec], { onCall: (r) => void calls.push(r), failureThreshold: 1000 });
  const predicatesFile = "content/config/predicates.yml";
  const live = new LiveContent(db, kb, ops, embedder, predicatesFile);
  const llm = new LlmClient(chain, loadSkills("content"), () => true, async () => live.guide);
  const kbService = new KbService({ db, kb, ops, embedder, live, predicatesFallback: () => loadPredicates(predicatesFile) });
  await seedContent(kbService, kb, ops, db, { contentDir: "content", adminIds: [9001], ownerId: 9001 });
  await live.rebuild();
  const settings = new SettingsService(ops, 0);
  const channel = new Capture();
  const resolver = new ResponseResolver(kb, llm, () => live.index, () => live.urlHosts);
  const pipeline = new BotPipeline({ db, conv, kb, ops, live, settings, resolver, channel, llm, knowledge: new PgKnowledge(kb, embedder), ownerId: 9001, adminWebUrl: "http://admin.local" });
  const jobCtx: JobContext = { db, conv, kb, ops, settings, kbService, channel, llm, ownerId: null, adminWebUrl: "x", now: () => new Date(), fetchImpl: fetch, log: () => undefined, resolver, live };
  console.log(`kiểm tra memory thực tế · embedding=${embedder.version} · model nhanh=${models.fast} mạnh=${models.strong}\n`);

  let update = 1;
  const say = (uid: number, text: string) => pipeline.handle({ chatId: uid, chatType: "private", userId: uid, name: `Live ${uid}`, username: `live${uid}`, isMention: true, at: new Date(), items: [{ updateId: update++, messageId: update, text }] });
  const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const episodes = (uid: number) => q<{ id: string; status: string; topic_key: string | null; issue: string | null; ref_code: string | null; last_ref: string | null; last_template_id: string | null; anchor_query_en: string | null }>("SELECT id, status, topic_key, issue, ref_code, last_ref, last_template_id, anchor_query_en FROM episodes WHERE user_id = $1 ORDER BY id", [uid]);
  const events = (uid: number, type: string) => q<{ payload: Record<string, unknown> }>("SELECT payload FROM events WHERE user_id = $1 AND type = $2 ORDER BY id", [uid, type]);
  const lastDecision = async (uid: number) => (await q<{ kind: string; template_id: string | null; reason: string | null; notes: { handoff_reason?: string | null } | null }>("SELECT kind, template_id, reason, notes FROM decisions WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [uid]))[0];
  const out = (uid: number) => channel.sent.filter((s) => s.chatId === uid);

  const results: Scenario[] = [];
  const scenario = async (id: string, title: string, body: (c: (name: string, ok: boolean, detail?: unknown) => void, t: string[]) => Promise<void>) => {
    if (only && !only.includes(id)) return;
    const checks: Check[] = [];
    const transcript: string[] = [];
    const c0 = calls.length;
    const started = Date.now();
    try {
      await body((name, ok, detail) => checks.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail ?? "") }), transcript);
    } catch (e) {
      checks.push({ name: "chạy không lỗi", ok: false, detail: (e as Error).stack ?? String(e) });
    }
    const mine = calls.slice(c0);
    const s: Scenario = { id, title, checks, transcript, calls: mine.length, tokens: mine.reduce((n, x) => n + x.usage.inputTokens + x.usage.outputTokens, 0), ms: Date.now() - started };
    results.push(s);
    console.log(`${checks.every((x) => x.ok) ? "✓" : "✗"} ${id} ${title} · ${s.calls} lời gọi AI · ${s.tokens} token · ${Math.round(s.ms / 1000)}s`);
    for (const x of checks) console.log(`   ${x.ok ? "✓" : "✗"} ${x.name}${x.ok ? "" : ` — ${x.detail.slice(0, 400)}`}`);
  };
  const talk = async (uid: number, text: string, t: string[]) => {
    const n = out(uid).length;
    await say(uid, text);
    t.push(`khách: ${text}`);
    for (const m of out(uid).slice(n)) t.push(`${m.entities ? "bot [khối tóm tắt]" : "bot"}: ${m.text}`);
    return out(uid).slice(n);
  };

  await scenario("S1", "Đổi chủ đề (AI/RAG) tách vụ việc; vấn đề cũ không bị ghi đè", async (c, t) => {
    const u = 700_001;
    await talk(u, "How do I log in to the InterLink app?", t);
    const e1 = await episodes(u);
    await talk(u, "Where can I find my wallet address?", t);
    const e2 = await episodes(u);
    c("vụ việc đầu có mã tham chiếu và chủ đề", !!e1[0]?.ref_code && !!e1[0]?.topic_key, e1);
    c("câu hỏi ví mở vụ việc thứ hai, vụ việc đầu tạm lắng", e2.length === 2 && e2[0]!.status === "dormant" && e2[0]!.topic_key !== e2[1]!.topic_key, e2);
    c("vấn đề của vụ việc đầu không bị ghi đè", e2[0]?.issue === e1[0]?.issue, { before: e1[0]?.issue, after: e2[0]?.issue });
  });

  await scenario("S2", "Trả lời từ tài liệu rồi khách cảm ơn: nhận ra tin nối tiếp theo đúng đoạn tài liệu", async (c, t) => {
    const u = 700_002;
    await talk(u, "What is the utility of the ITLG token?", t);
    const d1 = await lastDecision(u);
    const e1 = await episodes(u);
    await talk(u, "Thanks, that's clear!", t);
    const d2 = await lastDecision(u);
    const so = await events(u, "step_outcome");
    c("lượt 1 trả lời bằng tài liệu (GROUNDED)", d1?.kind === "GROUNDED", d1);
    c("last_ref là đoạn tài liệu, last_template_id trống", /^K:/.test(e1[0]?.last_ref ?? "") && !e1[0]?.last_template_id, e1[0]);
    c("lượt 2 là lời cảm ơn (you-are-welcome)", d2?.template_id === "you-are-welcome", d2);
    c("kết quả bước: solved cho đúng đoạn tài liệu", so.some((x) => x.payload.ref === e1[0]?.last_ref && x.payload.outcome === "solved"), so);
  });

  await scenario("S3", "Khách báo chưa được đến khi chuyển nhân viên: mã tham chiếu, khối tóm tắt, kết quả từng bước", async (c, t) => {
    const u = 700_003;
    let replies = await talk(u, "My ITLG balance was reduced, why? I lost 50 ITLG since 25/09/2026", t);
    let d = await lastDecision(u);
    for (const next of ["That doesn't help, my balance is still lower than yesterday", "Still not solved", "Nothing works, I need a human"]) {
      if (d?.kind === "ESCALATE") break;
      replies = await talk(u, next, t);
      d = await lastDecision(u);
    }
    const [ep] = (await episodes(u)).slice(-1);
    const block = replies.find((m) => m.entities?.some((e) => e.type === "pre"));
    const msg = replies.find((m) => !m.entities && m.text.includes("@interlink_technicalsupport"));
    c("chuyển nhân viên", d?.kind === "ESCALATE", d);
    c("câu chuyển nhân viên có đúng mã tham chiếu của vụ việc", !!ep?.ref_code && !!msg?.text.includes(ep.ref_code), { ref: ep?.ref_code, msg: msg?.text });
    c("khối tóm tắt là tin riêng dạng khối code", !!block && block.entities![0]!.length === block.text.length, block?.entities);
    c("khối có mã, bước đã hướng dẫn kèm kết quả, lý do", !!block && block.text.includes(`Ref: ${ep?.ref_code}`) && /Bot guidance already given:\n {2}1\./.test(block.text) && /not solved|customer asked again/.test(block.text) && block.text.includes("Reason for transfer"), block?.text);
    c("khối giữ nguyên số liệu khách nêu (50 ITLG, 25/09/2026)", !!block && /50 ITLG/.test(block.text) && block.text.includes("25/09/2026"), block?.text);
    c("khối không in id nội bộ của template", !!block && !/fp-\d|esc-|--b\d/.test(block.text), block?.text);
    c("ghi lý do chuyển nhân viên để thống kê", !!d?.notes?.handoff_reason, d?.notes?.handoff_reason);
    const hb = await events(u, "handoff_block");
    c("event handoff_block ghi bậc A hoặc B", hb.some((x) => x.payload.tier === "A" || x.payload.tier === "B"), hb);
    const again = await talk(u, "Still not solved after that, please check again", t);
    const eps = await episodes(u);
    c("khách nhắn tiếp ngay sau khi chuyển: dùng lại mã tham chiếu cũ, không mở vụ việc mới", eps.length === 1 && again.some((m) => !!ep?.ref_code && m.text.includes(ep.ref_code)), { eps: eps.map((e) => e.ref_code), again: again.map((m) => m.text.slice(0, 200)) });
  });

  await scenario("S4", "Khách tiếng Việt chuyển nhân viên: câu chuyển nhân viên và khối tóm tắt bằng tiếng Việt", async (c, t) => {
    const u = 700_004;
    await talk(u, "Tôi không tạo được ví trong app, báo lỗi 504 ở phiên bản 3.2.1", t);
    let replies = out(u);
    let d = await lastDecision(u);
    if (d?.kind !== "ESCALATE") {
      replies = await talk(u, "Vẫn không được, tôi thử lại nhiều lần rồi", t);
      d = await lastDecision(u);
    }
    const block = replies.find((m) => m.entities?.some((e) => e.type === "pre"));
    c("chuyển nhân viên", d?.kind === "ESCALATE", d);
    c("có khối tóm tắt", !!block, replies.map((r) => r.text));
    c("khối tóm tắt bằng tiếng Việt", !!block && looksVietnamese(block.text), block?.text);
    c("khối giữ nguyên mã lỗi và phiên bản", !!block && block.text.includes("504") && block.text.includes("3.2.1"), block?.text);
  });

  await scenario("S5", "Cảnh báo lộ seed phrase cho khách Hàn: tiếng Hàn, AI không nhận seed", async (c, t) => {
    const u = 700_005;
    const before = rec.inputs.length;
    const replies = await talk(u, `제 지갑 복구 문구입니다 ${SEED} 도와주세요`, t);
    const sentToAi = rec.inputs.slice(before);
    const ev = await events(u, "security_alert");
    c("cảnh báo viết bằng tiếng Hàn", /\p{Script=Hangul}/u.test(replies[0]?.text ?? ""), replies[0]?.text);
    c("cảnh báo giữ nguyên @interlink_technicalsupport", !!replies[0]?.text.includes("@interlink_technicalsupport"), replies[0]?.text);
    c("chữ gửi cho AI không có từ seed hay tin của khách", sentToAi.every((x) => !/abandon|accident|지갑|도와주세요/.test(x.text)), sentToAi.map((x) => x.purpose));
    c("chỉ một lời gọi AI (dịch)", sentToAi.length === 1 && sentToAi[0]!.purpose === "translate", sentToAi.map((x) => x.purpose));
    c("event ghi ngôn ngữ ko", ev[0]?.payload.lang === "ko", ev[0]?.payload);
  });

  await scenario("S6", "Tin ngoài phạm vi của khách Đức: cảnh báo chống spam bằng tiếng Đức", async (c, t) => {
    const u = 700_006;
    const replies = await talk(u, "Wie wird das Wetter morgen in Berlin?", t);
    const ev = await events(u, "antispam_warning");
    c("cảnh báo chống spam được gửi", replies.length === 1, replies.map((r) => r.text));
    c("không còn là câu tiếng Anh gốc", !replies[0]?.text.startsWith("I can only assist"), replies[0]?.text);
    c("event ghi ngôn ngữ de", ev[0]?.payload.lang === "de", ev[0]?.payload);
  });

  await scenario("S7", "Dịch sẵn câu khẩn rồi mất kết nối AI: câu báo mất kết nối bằng tiếng của khách, không gọi AI", async (c, t) => {
    const u = 700_007;
    await talk(u, "こんにちは、アプリについて質問があります", t);
    const lang = (await conv.getUser(u))?.language;
    const pre = (await HANDLERS["prewarm-urgent-translations"]!(jobCtx, { langs: [lang ?? "ja"] })) as { translated: number; skipped: number; failed: string[] };
    t.push(`dịch sẵn (${lang}): ${JSON.stringify(pre)}`);
    rec.down = true;
    const before = rec.inputs.length;
    const replies = await talk(u, "ウォレットのアドレスはどこで確認できますか？", t);
    rec.down = false;
    const attempts = rec.inputs.slice(before).filter((x) => x.purpose === "translate").length;
    c("ngôn ngữ khách đã nhớ là ja", lang === "ja", lang);
    c("dịch sẵn đủ nhóm câu khẩn", pre.failed.length === 0 && pre.translated + pre.skipped === 11, pre);
    c("câu báo mất kết nối bằng tiếng Nhật", /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(replies.at(-1)?.text ?? ""), replies.at(-1)?.text);
    c("không thử dịch tại chỗ khi mất kết nối", attempts === 0, attempts);
  });

  await scenario("S8", "Câu hỏi lúc mất kết nối AI được gắn vào vụ việc mở ở lượt sau", async (c, t) => {
    const u = 700_008;
    rec.down = true;
    await talk(u, "How do I reset my face scan?", t);
    rec.down = false;
    const unanswered = await events(u, "unanswered_question");
    await talk(u, "How do I log in to the InterLink app?", t);
    const eps = await episodes(u);
    const msgs = await q<{ id: string; episode_id: string | null }>("SELECT id, episode_id FROM messages WHERE user_id = $1 AND direction = 'in' ORDER BY id", [u]);
    c("ghi vết câu hỏi chưa trả lời", unanswered.length === 1, unanswered);
    c("tin đầu được gắn vào vụ việc mới", eps.length === 1 && msgs.every((m) => m.episode_id === eps[0]!.id), { eps, msgs });
  });

  const failed = results.flatMap((s) => s.checks.filter((x) => !x.ok).map((x) => `${s.id}: ${x.name}`));
  console.log(`\nKẾT QUẢ: ${results.length - new Set(failed.map((f) => f.split(":")[0])).size}/${results.length} kịch bản đạt · ${failed.length} kiểm tra không đạt · tổng ${calls.length} lời gọi AI · lỗi gọi AI ${calls.filter((x) => !x.ok).length}`);
  writeFileSync(".staging/live-memory-check.json", JSON.stringify({ at: new Date().toISOString(), models, embedding: embedder.version, results }, null, 2));
  await db.close();
}
main().catch((e) => {
  console.error("live-memory-check lỗi:", e);
  process.exit(1);
});
