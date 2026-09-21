/**
 * Chạy đường `pg` thật (driver production) vào một máy chủ giao thức Postgres do PGlite mở ra.
 * Mục đích: kiểm chứng các khác biệt giữa `pg` và PGlite trực tiếp (bigint trả về chuỗi, suy luận kiểu tham số,
 * mảng, jsonb, transaction qua PoolClient) mà test PGlite thuần không chạm tới.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDueJobs, scheduleDue } from "../src/worker/runner";
import { CRONS } from "../src/worker/schedule";
import type { JobContext } from "../src/worker/jobs";
import { makeWorld, type World } from "./helpers";

const PORT = 54000 + Math.floor(Math.random() * 900);
let server: PGLiteSocketServer;
let backing: PGlite;
let w: World;

beforeAll(async () => {
  process.env.PG_POOL_MAX = "1"; // PGlite là một kết nối
  backing = await PGlite.create({ extensions: { vector } });
  server = new PGLiteSocketServer({ db: backing, port: PORT, host: "127.0.0.1" });
  await server.start();
  w = await makeWorld({ adminIds: [9001, 9002], ownerId: 9001, databaseUrl: `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres` });
});
afterAll(async () => {
  await w?.close();
  await server?.stop();
  await backing?.close();
});

describe("driver pg thật", () => {
  it("dùng đúng driver pg (không phải PGlite trực tiếp)", () => {
    expect(w.db.kind).toBe("pg");
  });

  it("luồng end-to-end: FP-2, escalate + ticket, episode, quyết định (kiểu số/bigint đúng)", async () => {
    await w.say(5001, "how to withdraw");
    expect(w.channel.textsTo(5001).at(-1)).toContain("you can not withdraw now");
    await w.say(5001, "swap fail");
    const t = (await w.conv.listTickets({ limit: 10, offset: 0 })).find((x) => x.user_id === 5001)!;
    expect(typeof t.id).toBe("number"); // pg trả bigint dạng chuỗi: repository phải ép về number
    expect(t).toMatchObject({ error_code: "SWAP", pic: "Quang" });
    const eps = await w.ops.listEpisodes({ userId: 5001, limit: 5, offset: 0 });
    expect(typeof (eps[0] as { id: unknown }).id).toBe("number");
    const detail = await w.ops.episodeDetail((eps[0] as { id: number }).id);
    expect(detail.messages.length).toBeGreaterThanOrEqual(4);
    expect(detail.decisions.length).toBeGreaterThanOrEqual(2);
  });

  it("mảng, jsonb, ON CONFLICT, idempotency và transaction qua PoolClient", async () => {
    expect(await w.conv.claimUpdate(99001)).toBe(true);
    expect(await w.conv.claimUpdate(99001)).toBe(false);
    const ev = await w.conv.userEvents(5001, ["template_sent", "ticket_created"], 10);
    expect(ev.length).toBeGreaterThan(0);
    expect(typeof ev[0]!.id).toBe("number");
    await expect(w.db.tx(async (t) => { await t.query("INSERT INTO settings (key, value) VALUES ('x', '1'::jsonb)"); throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect((await w.db.query("SELECT 1 FROM settings WHERE key = 'x'")).rowCount).toBe(0);
  });

  it("usage: tổng bigint/numeric được ép đúng về number", async () => {
    await w.conv.addLlmCall({ userId: 5001, purpose: "classify", model: "claude-haiku-4-5", inputTokens: 1200, outputTokens: 30, cost: 0.0013 }, w.clock.now);
    const day = w.clock.now.toISOString().slice(0, 10);
    const rows = await w.ops.usageByDay(day, "2099-01-01");
    expect(rows[0]).toMatchObject({ requests: 1, input: 1200, output: 30 });
    expect(typeof rows[0]!.totalTokens).toBe("number");
    expect(rows[0]!.totalTokens).toBe(1230);
    const top = await w.ops.usageTopUsers(day, "2099-01-01");
    expect(top[0]).toMatchObject({ userId: 5001, totalTokens: 1230 });
  });

  it("KB: publish (transaction), tìm kiếm pgvector + tsvector, rollback", async () => {
    const md = "---\nslug: pg-guide\ntitle: PG Guide\nresponse_mode: GROUNDED_GENERATION\nsource_url: https://whitepaper.interlinklabs.ai\n---\n## Halving schedule\n\nThe halving schedule reduces mining emission gradually over many rounds to protect long term value.\n";
    const { version, report } = await w.kbService.createDraft({ slug: "pg-guide", kind: "knowledge", md, author: "test" });
    expect(report.ok).toBe(true);
    await w.kbService.publish(version.id, { id: 9001, role: "owner", label: "owner" });
    const hits = await w.pipeline["d"].knowledge!.search("halving schedule", 3);
    expect(hits[0]!.heading).toContain("Halving");
    expect(hits[0]!.score).toBeGreaterThan(0.25);
  });

  it("hàng đợi job: claim bằng FOR UPDATE SKIP LOCKED, retry, dead-letter", async () => {
    const ctx: JobContext = { db: w.db, conv: w.conv, kb: w.kb, ops: w.ops, settings: w.settings, kbService: w.kbService, channel: w.channel, ownerId: 9001, adminWebUrl: "x", now: () => w.clock.now, fetchImpl: (async () => new Response("", { status: 500 })) as typeof fetch, log: () => undefined };
    expect((await scheduleDue(ctx)).length).toBe(CRONS.length);
    expect((await scheduleDue(ctx)).length).toBe(0);
    const r = await runDueJobs(ctx, 30);
    expect(r.ran).toBeGreaterThan(0);
    await w.ops.enqueueJob("khong-co-handler", {}, { dedupeKey: "pg-dead", maxAttempts: 1 });
    await runDueJobs(ctx, 10);
    expect((await w.ops.jobStats()).dead).toBeGreaterThanOrEqual(1);
  });

  it("thống kê tuần và dashboard chạy được (SQL múi giờ, ép kiểu)", async () => {
    const day = w.clock.now.toISOString().slice(0, 10);
    const d = await w.ops.dashboard(day, day);
    expect(d.totals.messages).toBeGreaterThan(0);
    const st = await w.ops.computeWeeklyStats("2099-01-06");
    expect(st.totalConversations).toBe(0);
  });
});
