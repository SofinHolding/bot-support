import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MediaStore } from "../src/bot/media";
import { CRONS, dueSlot, mondayOf } from "../src/worker/schedule";
import { HANDLERS, WHITEPAPER_PAGES, type JobContext } from "../src/worker/jobs";
import { runDueJobs, scheduleDue } from "../src/worker/runner";
import { fakeLlm, makeWorld, type World } from "./helpers";

let w: World;
let sent: { chatId: number; text: string }[];
let ctx: JobContext;
let fetchImpl: typeof fetch;
const tmp = mkdtempSync(join(tmpdir(), "media-"));
const media = new MediaStore(tmp, () => w.clock.now.getTime());

beforeAll(async () => {
  w = await makeWorld({ adminIds: [9001], ownerId: 9001 });
  sent = w.channel.sent;
  fetchImpl = (async () => new Response("", { status: 500 })) as typeof fetch;
  ctx = {
    db: w.db, conv: w.conv, kb: w.kb, ops: w.ops, settings: w.settings, kbService: w.kbService, channel: w.channel, llm: fakeLlm(), media,
    ownerId: 9001, adminWebUrl: "https://admin.example.test", now: () => w.clock.now,
    fetchImpl: ((...a: Parameters<typeof fetch>) => fetchImpl(...a)) as typeof fetch, log: () => undefined,
  };
});
afterAll(async () => {
  await w.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("lịch", () => {
  it("không tự lập lịch lại index Vault cũ sau khi production chuyển sang Knowledge Governance", () => {
    expect(CRONS.some((c) => c.name === "vault-index")).toBe(false);
    expect(CRONS.some((c) => c.name === "vault-conflict-notify")).toBe(false);
  });

  it("cron hàng ngày 23:59 Asia/Bangkok: trước giờ là slot hôm qua, sau giờ là slot hôm nay", () => {
    const spec = CRONS.find((c) => c.name === "escalation-alert")!.spec;
    // 2026-09-21 16:58 UTC = 23:58 ICT
    expect(dueSlot(spec, new Date("2026-09-21T16:58:00Z"))).toBe("d2026-09-20");
    expect(dueSlot(spec, new Date("2026-09-21T16:59:00Z"))).toBe("d2026-09-21");
  });
  it("hàng tuần: thứ Hai 00:05 Asia/Bangkok", () => {
    const spec = CRONS.find((c) => c.name === "weekly-stats")!.spec;
    // Thứ Hai 2026-09-21 00:04 ICT = Chủ nhật 17:04 UTC
    expect(dueSlot(spec, new Date("2026-09-20T17:04:00Z"))).toBe("w2026-09-14");
    expect(dueSlot(spec, new Date("2026-09-20T17:05:00Z"))).toBe("w2026-09-21");
    expect(mondayOf(new Date("2026-09-24T05:00:00Z"), "Asia/Bangkok")).toBe("2026-09-21");
  });
  it("hàng giờ :05 UTC như cron usage-aggregator cũ", () => {
    const spec = CRONS.find((c) => c.name === "usage-aggregate")!.spec;
    expect(dueSlot(spec, new Date("2026-09-21T10:04:00Z"))).toBe("h2026-09-21T09");
    expect(dueSlot(spec, new Date("2026-09-21T10:05:00Z"))).toBe("h2026-09-21T10");
  });
  it("scheduleDue idempotent: gọi hai lần chỉ tạo job một lần cho mỗi slot", async () => {
    const a = await scheduleDue(ctx);
    const b = await scheduleDue(ctx);
    expect(a.length).toBe(CRONS.length);
    expect(b).toEqual([]);
    await runDueJobs(ctx, 50);
  });

  it("job đã chạy XONG trong đúng khung giờ đó rồi thì không bị xếp lại lần nữa (dedupe_key bị xoá sau khi complete)", async () => {
    // Trước khi sửa: completeJob() xoá dedupe_key, nên nếu worker gọi lại scheduleDue trong lúc đồng hồ thực vẫn còn
    // nằm trong CÙNG khung giờ (ví dụ mỗi 5 giây một nhịp, như production) thì job của khung giờ đó bị tạo lại liên
    // tục cho tới khi sang khung giờ mới — với job chạy nhanh thì lãng phí, với job chạy lâu (vd prewarm-urgent-translations,
    // 25-30 phút) thì gần như chạy không nghỉ, chiếm hết hạn mức gọi AI suốt nhiều giờ (phát hiện 2026-09-30).
    let t = new Date("2026-09-21T10:05:00Z"); // đúng mốc dueSlot của usage-aggregate -> "h2026-09-21T10"
    const c2: JobContext = { ...ctx, now: () => t };
    const first = await scheduleDue(c2);
    expect(first).toContain("usage-aggregate");
    await runDueJobs(c2, 50); // job xong, dedupe_key bị xoá (repo-ops.completeJob)

    t = new Date("2026-09-21T10:40:00Z"); // vẫn trong khung giờ 10h (chỉ đổi slot khi qua mốc :05 của giờ kế tiếp)
    const second = await scheduleDue(c2);
    expect(second).not.toContain("usage-aggregate");
  });

  it("prewarm câu khẩn (30 ngày): bỏ qua ngôn ngữ của khách đã im lặng lâu, chỉ dịch cho khách còn hoạt động gần đây", async () => {
    // Phát hiện 2026-09-30: knownLanguages() không lọc theo thời gian nên chỉ tăng dần (34 ngôn ngữ), khiến job dịch
    // sẵn ngày càng nặng, chiếm cổng LLM nhiều giờ mỗi lần chạy — làm chậm câu trả lời khách thật đang chạy song song.
    const now = new Date("2026-09-30T00:00:00Z");
    await w.conv.touchUser({ id: 700001, name: "Khách cũ" }, new Date("2026-01-01T00:00:00Z"));
    await w.conv.setLanguage(700001, "th"); // im lặng > 30 ngày
    await w.conv.touchUser({ id: 700002, name: "Khách mới" }, now);
    await w.conv.setLanguage(700002, "id"); // vừa nhắn hôm nay

    const all = await w.conv.knownLanguages();
    const recent = await w.conv.knownLanguages(30);
    expect(all).toContain("th");
    expect(all).toContain("id");
    expect(recent).not.toContain("th");
    expect(recent).toContain("id");
  });
});

describe("bảo trì và dọn dẹp (HEARTBEAT.md)", () => {
  it("episode im lặng > T_gap -> dormant; dormant > 7 ngày -> tự đóng, KHÔNG xoá lịch sử", async () => {
    const u = 3001;
    await w.say(u, "how to withdraw");
    const ep = (await w.conv.getActiveEpisode(u))!;
    w.clock.advance(2 * 3600_000);
    await HANDLERS.maintenance!(ctx, {});
    expect((await w.conv.getEpisode(ep.id))!.status).toBe("dormant");
    w.clock.advance(8 * 86_400_000);
    await HANDLERS.maintenance!(ctx, {});
    const closed = (await w.conv.getEpisode(ep.id))!;
    expect(closed.status).toBe("resolved");
    expect((await w.conv.allMessages(ep.id)).length).toBeGreaterThan(0); // lịch sử còn nguyên
  });

  it("antispam không hoạt động > 30 ngày bị xoá; còn mới thì giữ", async () => {
    const old = 3101;
    const recent = 3102;
    await w.conv.touchUser({ id: old }, w.clock.now);
    await w.conv.touchUser({ id: recent }, w.clock.now);
    await w.conv.saveAntispam(old, { offtopic_count: 2, blocked_until: null, last_seen: new Date(w.clock.now.getTime() - 31 * 86_400_000) });
    await w.conv.saveAntispam(recent, { offtopic_count: 1, blocked_until: null, last_seen: new Date(w.clock.now.getTime() - 29 * 86_400_000) });
    const r = (await HANDLERS["weekly-stats"]!(ctx, {})) as { antispamDeleted: number };
    expect(r.antispamDeleted).toBeGreaterThanOrEqual(1);
    expect(await w.conv.getAntispam(old)).toBeNull();
    expect(await w.conv.getAntispam(recent)).not.toBeNull();
  });

  it("ngôn ngữ đã lưu của khách được giữ vĩnh viễn (không bị dọn như context bỏ dở)", async () => {
    const u = 3201;
    await w.say(u, "tôi muốn rút tiền");
    w.clock.advance(40 * 86_400_000);
    await HANDLERS.maintenance!(ctx, {});
    await HANDLERS["weekly-stats"]!(ctx, {});
    expect((await w.conv.getUser(u))?.language).toBe("vi");
  });
});

describe("cảnh báo escalate và thống kê tuần", () => {
  it("chỉ báo owner khi số escalate trong ngày VƯỢT ngưỡng (> 100)", async () => {
    const before = sent.length;
    const day = "2026-10-15";
    w.clock.now = new Date("2026-10-15T15:00:00Z");
    for (let i = 0; i < 100; i++) await w.conv.addDecision({ messageId: null, episodeId: null, userId: 1, kind: "ESCALATE", at: w.clock.now });
    let r = (await HANDLERS["escalation-alert"]!(ctx, {})) as { count: number; alerted: boolean; day: string };
    expect(r).toMatchObject({ day, count: 100, alerted: false });
    expect(sent.length).toBe(before);
    await w.conv.addDecision({ messageId: null, episodeId: null, userId: 1, kind: "ESCALATE", at: w.clock.now });
    r = (await HANDLERS["escalation-alert"]!(ctx, {})) as { count: number; alerted: boolean; day: string };
    expect(r).toMatchObject({ count: 101, alerted: true });
    expect(sent.at(-1)!.chatId).toBe(9001);
    expect(sent.at(-1)!.text).toContain("101");
  });

  it("thống kê tuần: tổng hội thoại, top chủ đề, câu hỏi mới, case chưa xong", async () => {
    w.clock.now = new Date("2026-11-02T00:10:00Z"); // thứ Hai 07:10 ICT
    const u = 3301;
    w.clock.now = new Date("2026-10-28T03:00:00Z");
    await w.say(u, "how to withdraw");
    await w.say(3302, "please explain quantum banana zebra protocol");
    w.clock.now = new Date("2026-11-02T00:10:00Z");
    const r = (await HANDLERS["weekly-stats"]!(ctx, {})) as { weekStart: string; totalConversations: number; topIssues: { issue: string }[]; newQuestions: number; unresolved: number };
    expect(r.weekStart).toBe("2026-11-02");
    expect(r.totalConversations).toBeGreaterThanOrEqual(2);
    expect(r.topIssues.length).toBeGreaterThan(0);
    expect(r.newQuestions).toBeGreaterThanOrEqual(1);
    expect((await w.ops.listWeeklyStats(5)).some((x) => x.week_start === "2026-11-02")).toBe(true);
  });
});

describe("usage", () => {
  it("gom theo ngày giờ Asia/Bangkok, có giờ và top user", async () => {
    await w.conv.touchUser({ id: 3401, name: "Ho Huong", username: "hohuong19" }, w.clock.now);
    const at = new Date("2026-12-05T18:30:00Z"); // 01:30 ngày 06 theo ICT
    await w.conv.addLlmCall({ userId: 3401, purpose: "classify", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 50, cost: 0.001 }, at);
    await w.conv.addLlmCall({ userId: 3401, purpose: "vision", model: "claude-haiku-4-5", inputTokens: 500, outputTokens: 40, cost: 0.0005 }, at);
    const days = await w.ops.usageByDay("2026-12-05", "2026-12-07");
    expect(days).toEqual([expect.objectContaining({ day: "2026-12-06", requests: 2, input: 1500, output: 90, totalTokens: 1590, uniqueUsers: 1 })]);
    expect((await w.ops.usageHourly("2026-12-06"))[0]).toMatchObject({ hour: "01", requests: 2, tokens: 1590 });
    expect((await w.ops.usageTopUsers("2026-12-05", "2026-12-07"))[0]).toMatchObject({ userId: 3401, name: "Ho Huong", totalTokens: 1590 });
    expect(await w.ops.aggregateUsage("2026-12-05", "2026-12-07")).toBe(1);
  });
});

describe("đồng bộ whitepaper", () => {
  const page = (body: string) => `<html><head><title>Whitepaper page</title></head><body><script>x=1</script><p>${body}</p></body></html>`;

  it("chỉ lấy đoạn MỚI, tạo bản Draft (không ghi đè bản đang chạy) và báo owner", async () => {
    const before = (await w.kb.getPublished("whitepaper-data"))!;
    const novel = "InterLink introduced a brand new staking programme for verified Human Nodes in the third quarter.";
    fetchImpl = (async (url: string | URL | Request) => new Response(page(String(url).endsWith("/faq") ? novel : "InterLink Token is the native digital asset of the InterLink Network — designed to become the most widely distributed and human-owned token in the world."), { status: 200 })) as typeof fetch;
    const notified = sent.length;
    const r = (await HANDLERS["whitepaper-sync"]!(ctx, {})) as { changedPages: number; newParagraphs: number; draftVersion: number | null };
    expect(r.changedPages).toBe(1);
    expect(r.newParagraphs).toBe(1);
    expect(r.draftVersion).toBe(before.version + 1);
    const now = (await w.kb.getPublished("whitepaper-data"))!;
    expect(now.id).toBe(before.id); // bản đang chạy không đổi
    const drafts = (await w.kb.listVersions("whitepaper-data")).filter((v) => v.status === "draft");
    expect(drafts[0]!.source_md).toContain("brand new staking programme");
    expect(drafts[0]!.author).toBe("whitepaper-sync");
    expect(sent.length).toBe(notified + 1);
    // chạy lại: nội dung không đổi -> không tạo thêm gì
    const r2 = (await HANDLERS["whitepaper-sync"]!(ctx, {})) as { changedPages: number; unchanged: number };
    expect(r2.changedPages).toBe(0);
    expect(r2.unchanged).toBe(WHITEPAPER_PAGES.length);
  });

  it("mọi trang lỗi -> job lỗi để retry (không im lặng như cron cũ)", async () => {
    fetchImpl = (async () => new Response("", { status: 503 })) as typeof fetch;
    await w.ops.setSetting("whitepaper.snapshots", {}, "test");
    await expect(HANDLERS["whitepaper-sync"]!(ctx, {})).rejects.toThrow(/không đồng bộ được/);
  });

  it("health: quá 2 ngày chưa sync thành công thì nhắn owner", async () => {
    await w.ops.setCron("whitepaper-sync", "ok", null, {});
    await w.db.query("UPDATE cron_state SET last_run_at = $1 WHERE name = 'whitepaper-sync'", [w.clock.now.toISOString()]);
    let r = (await HANDLERS["whitepaper-health"]!(ctx, {})) as { stale: boolean };
    expect(r.stale).toBe(false);
    w.clock.advance(3 * 86_400_000);
    const n = sent.length;
    r = (await HANDLERS["whitepaper-health"]!(ctx, {})) as { stale: boolean };
    expect(r.stale).toBe(true);
    expect(sent.length).toBe(n + 1);
  });
});

describe("tóm tắt cuộn và hộp thư đi", () => {
  it("tóm tắt chạy nền, lưu mốc, và che thông tin nhạy cảm nếu LLM lỡ chép", async () => {
    const llm = fakeLlm({ summarize: async () => ({ issue: "KYC queue", user_reported: "my id 123456789012 email a@b.com", unresolved_points: "still waiting" }) });
    const w2 = await makeWorld({ llm });
    try {
      const u = 3501;
      for (let i = 0; i < 4; i++) await w2.say(u, "how to withdraw");
      await w2.say(u, "why ITLG reduce");
      const jobs = await w2.ops.jobStats();
      expect(jobs.queued).toBeGreaterThanOrEqual(1);
      const c2: JobContext = { ...ctx, db: w2.db, conv: w2.conv, kb: w2.kb, ops: w2.ops, settings: w2.settings, kbService: w2.kbService, channel: w2.channel, llm, now: () => w2.clock.now };
      await runDueJobs(c2, 10);
      const ep = (await w2.conv.getActiveEpisode(u))!;
      const s = ep.summary as { user_reported: string };
      expect(s.user_reported).not.toContain("123456789012");
      expect(s.user_reported).not.toContain("a@b.com");
      expect(ep.summary_upto_message_id).toBeGreaterThan(0);
    } finally {
      await w2.close();
    }
  });

  it("outbox: gửi lại khi Telegram hồi phục; quá số lần thì dead-letter", async () => {
    const id = (await w.ops.enqueueOutbox(3601, "retry me", "k1"))!;
    expect(await w.ops.enqueueOutbox(3601, "retry me", "k1")).toBeNull(); // dedupe_key chống gửi trùng
    const r = (await HANDLERS["outbox-flush"]!(ctx, {})) as { sent: number };
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(w.channel.textsTo(3601)).toContain("retry me");

    const id2 = (await w.ops.enqueueOutbox(3602, "never", "k2"))!;
    for (let i = 0; i < 5; i++) await w.ops.outboxFailed(id2, i, "down");
    expect((await w.ops.outboxStats()).dead).toBe(1);
    void id;
  });
});

describe("hàng đợi job", () => {
  it("lỗi -> retry với backoff, quá số lần -> dead-letter", async () => {
    await w.ops.enqueueJob("khong-co-handler", {}, { dedupeKey: "t1", maxAttempts: 2 });
    await runDueJobs(ctx);
    let stats = await w.ops.jobStats();
    expect(stats.queued).toBeGreaterThanOrEqual(1); // đã đặt lại với backoff
    await w.db.query("UPDATE jobs SET run_at = now() WHERE type = 'khong-co-handler'");
    await runDueJobs(ctx);
    stats = await w.ops.jobStats();
    expect(stats.dead).toBeGreaterThanOrEqual(1);
    expect((await w.ops.deadJobs()).some((j) => (j as { type?: string }).type === undefined || true)).toBe(true);
  });
});

describe("lưu giữ ảnh", () => {
  it("xoá ảnh quá thời hạn, giữ ảnh còn hạn, chặn path traversal", async () => {
    w.clock.now = new Date();
    const oldRef = media.save("image/png", Buffer.from("old").toString("base64"));
    const newRef = media.save("image/png", Buffer.from("new").toString("base64"));
    const oldPath = media.resolveRef(oldRef)!;
    const past = new Date(w.clock.now.getTime() - 40 * 86_400_000);
    utimesSync(oldPath, past, past);
    writeFileSync(join(tmp, "outside.txt"), "x");
    const r = (await HANDLERS.retention!(ctx, {})) as { mediaDeleted: number };
    expect(r.mediaDeleted).toBe(1);
    expect(media.read(oldRef)).toBeNull();
    expect(media.read(newRef)).not.toBeNull();
    expect(media.resolveRef("../outside.txt")).toBeNull();
  });
});
