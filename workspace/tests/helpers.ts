import { HashEmbedder } from "../src/core/embedding";
import { loadPredicates } from "../src/core/predicates";
import type { LlmPort } from "../src/core/ports";
import { SettingsService } from "../src/core/settings";
import type { VisionResult } from "../src/domain/types";
import { BotPipeline } from "../src/bot/pipeline";
import { ResponseResolver } from "../src/bot/resolver";
import type { Channel, InboundBatch, InboundItem } from "../src/bot/types";
import { migrate, openDb, type Db } from "../src/db/db";
import { convRepo } from "../src/db/repo-conv";
import { kbRepo } from "../src/db/repo-kb";
import { opsRepo } from "../src/db/repo-ops";
import { LiveContent } from "../src/kb/live-content";
import { PgKnowledge } from "../src/kb/knowledge-search";
import { seedContent } from "../src/kb/seed";
import { KbService } from "../src/kb/service";

export class FakeChannel implements Channel {
  sent: { chatId: number; text: string }[] = [];
  images = new Map<string, Partial<VisionResult>>();
  failSend = false;
  private nextId = 1000;

  async send(chatId: number, text: string) {
    if (this.failSend) throw new Error("telegram down");
    this.sent.push({ chatId, text });
    return { messageId: this.nextId++ };
  }
  async downloadImage(fileId: string) {
    const preset = this.images.get(fileId) ?? {};
    return { mime: "image/png", base64: Buffer.from(JSON.stringify(preset)).toString("base64") };
  }
  textsTo(chatId: number) {
    return this.sent.filter((s) => s.chatId === chatId).map((s) => s.text);
  }
}

/** Bản dịch giả sang tiếng Hàn viết bằng chữ Hàn (qua được kiểm tra chữ viết đích); giữ nguyên URL và con số */
export const fakeKorean = (text: string): string => `번역 ${text.replace(/https?:\/\/\S+|[A-Za-z]+/g, (m) => (m.startsWith("http") ? m : "번역"))}`;

export function fakeLlm(over: Partial<LlmPort> = {}): LlmPort {
  return {
    understand: async (r) => ({ language: "unknown", intent: "question", follow_up: "none", query_en: r.text, query_kb: r.text }),
    select: async () => ({ ref: "ESCALATE", reason: "fake" }),
    verify: async () => ({ ok: true }),
    verifyHandoff: async () => ({ ok: true }),
    reviewOverlap: async () => ({ verdict: "distinct" as const }),
    draftIntake: async (r) => ({
      kind: r.kindHint ?? "templates",
      slug: "fake-intake-doc",
      title: "Fake intake doc",
      templates: r.kindHint === "knowledge" ? [] : [{ id: "fake-intake-tpl", group: "Test", keywords: ["fake intake phrase"], examples: ["fake intake phrase", "this is a fake intake example"], answer_en: r.rawText.slice(0, 200) || "Fake answer." }],
      knowledge: r.kindHint === "knowledge" ? { lang: "en", sections: [{ heading: "Fake section", body: r.rawText.slice(0, 200) || "Fake body long enough to pass validation checks here." }] } : null,
    }),
    reviewEval: async (r) => r.cases.map((c) => ({ n: c.n, verdict: "ok" as const })),
    classify: async () => ({ action: "escalate" }),
    grounded: async () => ({ answerable: false, answer: "", cited: [] }),
    vision: async (req) => {
      const preset = JSON.parse(Buffer.from(req.base64, "base64").toString("utf8")) as Partial<VisionResult>;
      return { screen_type: "app_screen", error_text: "", has_secret: false, readable: true, ...preset };
    },
    translate: async (r) => `[${r.lang}] ${r.text}`,
    translateQuery: async (r) => ({ query: r.text }),
    summarize: async () => ({ issue: "i", user_reported: "u", unresolved_points: "p" }),
    ...over,
  };
}

export interface World {
  db: Db;
  conv: ReturnType<typeof convRepo>;
  kb: ReturnType<typeof kbRepo>;
  ops: ReturnType<typeof opsRepo>;
  live: LiveContent;
  kbService: KbService;
  pipeline: BotPipeline;
  channel: FakeChannel;
  clock: { now: Date; advance(ms: number): void };
  settings: SettingsService;
  say(userId: number, text: string, extra?: Partial<InboundItem> & { chatType?: InboundBatch["chatType"]; isMention?: boolean; name?: string }): ReturnType<BotPipeline["handle"]>;
  sayPhoto(userId: number, fileId: string, caption?: string): ReturnType<BotPipeline["handle"]>;
  close(): Promise<void>;
}

let updateSeq = 1;

/** `mode`: luồng xử lý (mặc định hybrid như lúc chạy thật; không còn luồng trả lời không qua AI). */
export async function makeWorld(opts: { llm?: LlmPort | null; adminIds?: number[]; ownerId?: number; databaseUrl?: string; mode?: "hybrid" | "llm_first" } = {}): Promise<World> {
  const db = await openDb(opts.databaseUrl ?? "pglite:memory");
  await migrate(db);
  const conv = convRepo(db);
  const kb = kbRepo(db);
  const ops = opsRepo(db);
  const embedder = new HashEmbedder();
  const clock = { now: new Date("2026-09-21T03:00:00Z"), advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); } };
  const live = new LiveContent(db, kb, ops, embedder, "content/config/predicates.yml", () => clock.now.getTime());
  const settings = new SettingsService(ops, 0);
  const llm = opts.llm === null ? undefined : opts.llm ?? fakeLlm();
  const kbService = new KbService({ db, kb, ops, embedder, live, llm, predicatesFallback: () => loadPredicates("content/config/predicates.yml"), now: () => clock.now, secondApproval: async () => (await settings.get())["approval.second_person"] });
  const adminIds = opts.adminIds ?? [9001];
  const ownerId = opts.ownerId ?? 9001;
  await seedContent(kbService, kb, ops, db, { contentDir: "content", adminIds, ownerId });
  await live.rebuild();

  const channel = new FakeChannel();
  await ops.setSetting("router.mode", opts.mode ?? "hybrid", "test");
  await ops.setSetting("router.tier3_mode", "extractive", "test"); // test kiểm luồng trích nguyên văn; chế độ sinh có test riêng
  settings.invalidate();
  const resolver = new ResponseResolver(kb, llm, () => live.index, () => live.urlHosts);
  const pipeline = new BotPipeline({
    db, conv, kb, ops, live, settings, resolver, channel, llm, knowledge: new PgKnowledge(kb, embedder),
    ownerId, adminWebUrl: "https://admin.example.test", now: () => clock.now,
  });

  const world: World = {
    db, conv, kb, ops, live, kbService, pipeline, channel, clock, settings,
    say(userId, text, extra = {}) {
      const { chatType, isMention, name, ...item } = extra;
      return pipeline.handle({ chatId: userId, chatType: chatType ?? "private", userId, name: name ?? `User ${userId}`, username: `u${userId}`, isMention: isMention ?? true, at: clock.now, items: [{ updateId: updateSeq++, messageId: updateSeq, text, ...item }] });
    },
    sayPhoto(userId, fileId, caption) {
      return pipeline.handle({ chatId: userId, chatType: "private", userId, name: `User ${userId}`, username: `u${userId}`, isMention: true, at: clock.now, items: [{ updateId: updateSeq++, messageId: updateSeq, text: caption, photoFileId: fileId }] });
    },
    close: () => db.close(),
  };
  return world;
}
