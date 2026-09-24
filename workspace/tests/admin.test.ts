import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAdminServer } from "../src/admin/server";
import { createServices, type Services } from "../src/app";
import { loadConfig } from "../src/config";
import { fakeLlm, FakeChannel } from "./helpers";
import { BotPipeline } from "../src/bot/pipeline";

let svc: Services;
let app: FastifyInstance;
let channel: FakeChannel;
let pipeline: BotPipeline;
const media = mkdtempSync(join(tmpdir(), "admin-media-"));
const clock = { now: new Date("2026-09-21T03:00:00Z") };
let ipSeq = 1;
const ip = () => `10.1.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`; // mỗi lần đăng nhập một IP để không dính giới hạn theo IP

const H = { "x-requested-with": "admin-web", "content-type": "application/json" };
type Res = { statusCode: number; json: () => any; body: string; headers: Record<string, unknown> };

beforeAll(async () => {
  const cfg = loadConfig({ DATABASE_URL: "pglite:memory", ADMIN_TELEGRAM_IDS: "9001,9002", OWNER_TELEGRAM_ID: "9001", SECRETS_KEY: "test-secrets-key-0123456789-abcdefghij", MEDIA_DIR: media, CONTENT_DIR: "content", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  svc = await createServices(cfg, "admin");
  channel = new FakeChannel();
  (svc as { channel: unknown }).channel = channel;
  await svc.ops.upsertAdmin(9003, "viewer", null);
  await svc.ops.setSetting("router.mode", "hybrid", "test");
  svc.settings.invalidate();
  app = await buildAdminServer(svc, { now: () => clock.now, webDir: "src/admin/web" });
  const llm = fakeLlm();
  pipeline = new BotPipeline({ db: svc.db, conv: svc.conv, kb: svc.kb, ops: svc.ops, live: svc.live, settings: svc.settings, resolver: svc.resolver, channel, llm, knowledge: svc.knowledge, ownerId: 9001, adminWebUrl: "https://admin.test", now: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await svc.close();
  rmSync(media, { recursive: true, force: true });
});

async function login(id: number): Promise<string> {
  const n = channel.sent.length;
  const r1 = (await app.inject({ method: "POST", url: "/api/auth/request-code", headers: H, remoteAddress: ip(), payload: { telegramId: id } })) as Res;
  expect(r1.statusCode).toBe(200);
  const msg = channel.sent.slice(n).find((s) => s.chatId === id);
  const code = /\b(\d{6})\b/.exec(msg?.text ?? "")?.[1];
  expect(code, "mã đăng nhập phải được gửi qua Telegram của admin").toBeDefined();
  const r2 = (await app.inject({ method: "POST", url: "/api/auth/verify", headers: H, remoteAddress: ip(), payload: { telegramId: id, code } })) as Res & { cookies: { name: string; value: string; httpOnly?: boolean; sameSite?: string }[] };
  expect(r2.statusCode).toBe(200);
  const sid = r2.cookies.find((c) => c.name === "sid")!;
  expect(sid.httpOnly).toBe(true);
  expect(String(sid.sameSite).toLowerCase()).toBe("strict");
  return `sid=${sid.value}`;
}
const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } }) as Promise<Res>;
const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, cookie: string, payload?: unknown) => app.inject({ method, url, headers: { ...H, cookie }, payload: payload as never }) as Promise<Res>;

describe("đăng nhập", () => {
  it("chưa đăng nhập -> 401; thiếu header CSRF khi ghi -> 403", async () => {
    expect(((await app.inject({ method: "GET", url: "/api/episodes" })) as Res).statusCode).toBe(401);
    const r = (await app.inject({ method: "POST", url: "/api/settings/x", headers: { "content-type": "application/json" }, payload: {} })) as Res;
    expect(r.statusCode).toBe(403);
  });

  it("mã đúng -> phiên; mã sai bị từ chối; ID lạ không lộ ra là không phải admin", async () => {
    const owner = await login(9001);
    const me = (await get("/api/me", owner)).json();
    expect(me).toMatchObject({ id: 9001, role: "owner" });

    const before = channel.sent.length;
    const stranger = (await app.inject({ method: "POST", url: "/api/auth/request-code", headers: H, remoteAddress: ip(), payload: { telegramId: 5555 } })) as Res;
    expect(stranger.statusCode).toBe(200); // cùng phản hồi như với admin thật
    expect(channel.sent.length).toBe(before); // nhưng không gửi mã cho người lạ

    const bad = (await app.inject({ method: "POST", url: "/api/auth/verify", headers: H, remoteAddress: ip(), payload: { telegramId: 9001, code: "000000" } })) as Res;
    expect(bad.statusCode).toBe(401);
  });

  it("mã hết hạn sau 5 phút và chỉ dùng được một lần", async () => {
    const n = channel.sent.length;
    await app.inject({ method: "POST", url: "/api/auth/request-code", headers: H, remoteAddress: ip(), payload: { telegramId: 9002 } });
    const code = /\b(\d{6})\b/.exec(channel.sent.slice(n).find((s) => s.chatId === 9002)!.text)![1]!;
    clock.now = new Date(clock.now.getTime() + 6 * 60_000);
    const late = (await app.inject({ method: "POST", url: "/api/auth/verify", headers: H, remoteAddress: ip(), payload: { telegramId: 9002, code } })) as Res;
    expect(late.statusCode).toBe(401);
    clock.now = new Date(clock.now.getTime() - 6 * 60_000);
  });

  it("giới hạn thử đăng nhập theo IP: quá 10 lần/phút bị 429", async () => {
    const same = "10.9.9.9";
    let last = 200;
    for (let i = 0; i < 12; i++) last = ((await app.inject({ method: "POST", url: "/api/auth/verify", headers: H, remoteAddress: same, payload: { telegramId: 9001, code: "111111" } })) as Res).statusCode;
    expect(last).toBe(429);
  });

  it("đăng xuất huỷ phiên", async () => {
    const c = await login(9002);
    expect((await get("/api/me", c)).statusCode).toBe(200);
    await send("POST", "/api/auth/logout", c);
    expect((await get("/api/me", c)).statusCode).toBe(401);
  });
});

describe("phân quyền", () => {
  it("viewer: xem được nhưng ID khách bị che, không ghi được, không xem ảnh", async () => {
    const owner = await login(9001);
    await pipeline.handle({ chatId: 777001, chatType: "private", userId: 777001, name: "Khach A", username: "khach_a", isMention: true, at: clock.now, items: [{ updateId: 880001, messageId: 1, text: "swap fail" }] });
    const v = await login(9003);
    const list = (await get("/api/episodes", v)).json();
    expect(list.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain("777001");
    expect(JSON.stringify(list)).not.toContain("khach_a");
    expect((await send("PATCH", "/api/tickets/1", v, { status: "closed" })).statusCode).toBe(403);
    expect((await send("POST", "/api/kb/documents", v, { slug: "x-doc", kind: "templates", md: "---\nid: a\n---\nzzzzzzzzzzzz" })).statusCode).toBe(403);
    expect((await get("/api/media?ref=x", v)).statusCode).toBe(403);
    expect((await get("/api/users/777001", v)).statusCode).toBe(403);
    const asOwner = (await get("/api/episodes", owner)).json();
    expect(JSON.stringify(asOwner)).toContain("777001");
  });

  it("chỉ owner được đụng tới cấu hình được bảo vệ, admin và broadcast", async () => {
    const a = await login(9002);
    expect((await send("POST", "/api/protected/url_whitelist_extra", a, { value: ["cdn.example.com"] })).statusCode).toBe(403);
    expect((await send("POST", "/api/admins", a, { telegramId: 123456, role: "admin" })).statusCode).toBe(403);
    expect((await send("POST", "/api/broadcasts", a, { text: "hi" })).statusCode).toBe(403);
  });
});

describe("lịch sử hội thoại (thay lệnh /contexts)", () => {
  it("danh sách, lọc, chi tiết kèm quyết định và cổng, ticket, sự kiện", async () => {
    const c = await login(9001);
    const uid = 777002;
    for (const [i, t] of ["why ITLG reduce", "not burn"].entries()) {
      await pipeline.handle({ chatId: uid, chatType: "private", userId: uid, name: "Ho Huong", username: "hohuong19", isMention: true, at: clock.now, items: [{ updateId: 880010 + i, messageId: i, text: t }] });
    }
    const list = (await get(`/api/episodes?q=hohuong19`, c)).json();
    const ep = list.items.find((e: { user_id: number }) => e.user_id === uid);
    expect(ep).toBeDefined();
    expect(ep.status).toBe("escalated");

    const d = (await get(`/api/episodes/${ep.id}`, c)).json();
    expect(d.messages.length).toBeGreaterThanOrEqual(4);
    expect(d.decisions.map((x: { template_id: string }) => x.template_id)).toEqual(expect.arrayContaining(["fp-4-itlg-burn", "fp-12-escalate"]));
    expect(d.events.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(["template_sent", "ticket_created"]));
    expect(d.tickets[0]).toMatchObject({ error_code: "M02", pic: "Quang" });
    expect(d.user.username).toBe("hohuong19");

    const tk = (await get("/api/tickets?status=open", c)).json();
    const t = tk.items.find((x: { user_id: number }) => x.user_id === uid);
    await send("PATCH", `/api/tickets/${t.id}`, c, { status: "in_progress", notes: "đã chuyển cho Quang" });
    expect(((await get("/api/tickets?status=in_progress", c)).json().items as { id: number }[]).some((x) => x.id === t.id)).toBe(true);
    expect(JSON.stringify((await get("/api/audit", c)).json())).toContain("ticket.update");
  });
});

describe("nạp dữ liệu qua web, không cần lập trình viên", () => {
  it("tạo Draft (.md) -> báo cáo kiểm tra -> publish -> bot dùng ngay", async () => {
    const c = await login(9002);
    const md = "---\nid: web-added\ngroup: Test\nresponse_mode: EXACT_TEMPLATE\npriority: 300\nmatch:\n  keywords:\n    - moon base access\nsets_context:\n  status: pending\n---\n<!-- answer:en -->\nMoon base is not open yet.\n";
    const created = (await send("POST", "/api/kb/documents", c, { slug: "web-added", kind: "templates", md })).json();
    expect(created.report.ok).toBe(true);
    expect((await send("POST", `/api/kb/versions/${created.version.id}/publish`, c)).json()).toEqual({ status: "published" });
    expect((await get("/api/templates", c)).json().items.some((t: { id: string }) => t.id === "web-added")).toBe(true);
    // bot dùng ngay, không cần khởi động lại
    const before = channel.sent.length;
    await pipeline.handle({ chatId: 777100, chatType: "private", userId: 777100, isMention: true, at: clock.now, items: [{ updateId: 890100, messageId: 1, text: "how to get moon base access" }] });
    expect(channel.sent.slice(before).find((s) => s.chatId === 777100)?.text).toBe("Moon base is not open yet.");
  });

  it("dữ liệu sai bị từ chối với lý do cụ thể", async () => {
    const c = await login(9002);
    const bad = (await send("POST", "/api/kb/documents", c, { slug: "web-bad", kind: "templates", md: "---\nid: bad\ngroup: X\n---\n<!-- answer:en -->\nhello there friend\n" })).json();
    expect(bad.report.ok).toBe(false);
    const r = await send("POST", `/api/kb/versions/${bad.version.id}/publish`, c);
    expect(r.statusCode).toBe(400);
    expect((await send("POST", "/api/kb/documents", c, { slug: "Bad Slug!", kind: "templates", md: "x".repeat(20) })).statusCode).toBe(400);
  });
});

describe("cấu hình và duyệt hai người", () => {
  it("cấu hình thường: kiểm tra kiểu/khoảng giá trị, ghi audit", async () => {
    const c = await login(9002);
    expect((await send("PUT", "/api/settings/router.tier3_mode", c, { value: "banana" })).statusCode).toBe(400);
    expect((await send("PUT", "/api/settings/khong.co", c, { value: 1 })).statusCode).toBe(400);
    expect((await send("PUT", "/api/settings/router.semantic_confident", c, { value: 2 })).statusCode).toBe(400);
    expect((await send("PUT", "/api/settings/episode.t_gap_minutes", c, { value: 90 })).statusCode).toBe(200);
    const s = (await get("/api/settings", c)).json();
    expect(s.items.find((x: { key: string }) => x.key === "episode.t_gap_minutes")).toMatchObject({ value: 90, custom: true, default: 60 });
  });

  it("cấu hình bảo vệ: owner đề xuất -> chưa có hiệu lực -> owner không tự duyệt -> admin khác duyệt -> có hiệu lực", async () => {
    const owner = await login(9001);
    const admin = await login(9002);
    const p = (await send("POST", "/api/protected/url_whitelist_extra", owner, { value: ["cdn.example.com"] })).json();
    expect(p.status).toBe("pending_approval");
    expect(svc.live.urlHosts.has("cdn.example.com")).toBe(false);
    const self = await send("POST", `/api/changes/${p.changeId}/approve`, owner);
    expect(self.statusCode).toBe(403);
    expect((await send("POST", `/api/changes/${p.changeId}/approve`, admin)).statusCode).toBe(200);
    expect(svc.live.urlHosts.has("cdn.example.com")).toBe(true);
  });

  it("predicates sai cấu trúc bị từ chối ngay khi đề xuất", async () => {
    const owner = await login(9001);
    expect((await send("POST", "/api/protected/predicates", owner, { value: { x: { oops: 1 } } })).statusCode).toBe(400);
    expect((await send("POST", "/api/protected/predicates", owner, { value: { x: { regex: "([" } } })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("không thể gỡ owner cuối cùng", async () => {
    const owner = await login(9001);
    const admin = await login(9002);
    const p = (await send("DELETE", "/api/admins/9001", owner)).json();
    const r = await send("POST", `/api/changes/${p.changeId}/approve`, admin);
    expect(r.statusCode).toBe(400);
    expect((await svc.ops.getAdmin(9001))?.role).toBe("owner");
  });
});

describe("usage và dashboard", () => {
  it("báo cáo theo ngày Asia/Bangkok, top user, xuất CSV/Markdown", async () => {
    const c = await login(9001);
    await svc.conv.touchUser({ id: 777003, name: "U3", username: "u3" }, clock.now);
    await svc.conv.addLlmCall({ userId: 777003, purpose: "classify", model: "claude-haiku-4-5", inputTokens: 2000, outputTokens: 100, cost: 0.002 }, new Date("2026-09-20T18:00:00Z"));
    const u = (await get("/api/usage?from=2026-09-21&to=2026-09-21", c)).json();
    expect(u.totals).toMatchObject({ requests: 1, input: 2000, output: 100, totalTokens: 2100, uniqueUsers: 1 });
    expect(u.hourly[0]).toMatchObject({ hour: "01", requests: 1 });
    expect(u.topUsers[0]).toMatchObject({ userId: 777003, totalTokens: 2100 });
    const csv = await get("/api/usage/export?from=2026-09-21&to=2026-09-21&format=csv", c);
    expect(csv.body.split("\n")[0]).toBe("date,users,requests,input_tokens,output_tokens,cache_read,cache_write,total_tokens,cost_usd");
    expect(csv.body).toContain("2026-09-21,1,1,2000,100");
    expect((await get("/api/usage/export?format=md", c)).body).toContain("# Usage Report");
    const bad = await get("/api/usage?from=abc", c);
    expect(bad.statusCode).toBe(400);
  });

  it("dashboard: tỉ lệ không-LLM, escalate, câu chưa khớp và sức khoẻ hệ thống", async () => {
    const c = await login(9001);
    await pipeline.handle({ chatId: 777004, chatType: "private", userId: 777004, isMention: true, at: clock.now, items: [{ updateId: 880100, messageId: 1, text: "please explain quantum banana zebra protocol" }] });
    const d = (await get("/api/dashboard?from=2026-09-21&to=2026-09-21", c)).json();
    expect(d.rates.decisions).toBeGreaterThan(0);
    expect(d.unmatched.some((x: { text: string }) => x.text.includes("quantum banana"))).toBe(true);
    expect(d.health).toMatchObject({ llmConfigured: false });
    expect(d.health.jobs).toBeDefined();
  });
});

describe("broadcast", () => {
  it("owner phải gõ lại đúng số người nhận mới gửi được", async () => {
    const c = await login(9001);
    const draft = (await send("POST", "/api/broadcasts", c, { text: "Bảo trì lúc 22:00" })).json();
    expect(draft.total).toBeGreaterThan(0);
    expect((await send("POST", `/api/broadcasts/${draft.id}/send`, c, { confirmTotal: draft.total + 1 })).statusCode).toBe(400);
    expect((await send("POST", `/api/broadcasts/${draft.id}/send`, c, { confirmTotal: draft.total })).statusCode).toBe(200);
    expect((await svc.ops.jobStats()).queued).toBeGreaterThanOrEqual(1);
  });
});

describe("giao diện tĩnh và header bảo mật", () => {
  it("trang chủ phục vụ được, có CSP chặt và không cho nhúng iframe", async () => {
    const r = (await app.inject({ method: "GET", url: "/" })) as Res;
    expect(r.statusCode).toBe(200);
    expect(String(r.headers["content-security-policy"])).toContain("script-src 'self'");
    expect(String(r.headers["content-security-policy"])).not.toContain("unsafe-inline");
    expect(r.headers["x-frame-options"]).toBe("DENY");
  });
  it("ảnh: chặn path traversal", async () => {
    const c = await login(9001);
    expect((await get("/api/media?ref=" + encodeURIComponent("../../etc/passwd"), c)).statusCode).toBe(404);
  });
});

describe("siết quyền và sửa lỗi sau rà soát giao diện", () => {
  it("viewer không đọc được nhật ký, hàng chờ duyệt, phiên bản tài liệu, cấu hình bảo vệ; top user bị che", async () => {
    const v = await login(9003);
    for (const url of ["/api/audit", "/api/changes", "/api/kb/versions/1", "/api/broadcasts"]) expect((await get(url, v)).statusCode, url).toBe(403);
    const s = (await get("/api/settings", v)).json();
    expect(s.items.length).toBeGreaterThan(0);
    expect(s.protected).toBeNull();
    expect(s.admins).toBeNull();
    const u = (await get("/api/usage?from=2026-09-21&to=2026-09-21", v)).json();
    expect(u.topUsers.length).toBeGreaterThan(0);
    expect(JSON.stringify(u.topUsers)).not.toContain("777003");
    expect(JSON.stringify(u.topUsers)).not.toContain('"u3"');
    const owner = await login(9001);
    expect((await get("/api/settings", owner)).json().admins.length).toBeGreaterThan(0);
    expect((await get("/api/usage?from=2026-09-21&to=2026-09-21", owner)).json().topUsers[0]).toMatchObject({ userId: 777003, username: "u3" });
  });

  it("predicates rỗng bị từ chối; nội dung đang chạy không bao giờ mất bộ điều kiện mặc định", async () => {
    const owner = await login(9001);
    expect((await send("POST", "/api/protected/predicates", owner, { value: {} })).statusCode).toBe(400);
    const s = (await get("/api/settings", owner)).json();
    expect(Object.keys(s.protected.predicates).length).toBeGreaterThan(0);
  });

  it("phiên bản mới không ghi đè tiêu đề tài liệu bằng slug", async () => {
    const c = await login(9002);
    const md = (kw: string) => `---\nid: title-keep\ngroup: Test\nresponse_mode: EXACT_TEMPLATE\npriority: 300\nmatch:\n  keywords:\n    - ${kw}\nsets_context:\n  status: pending\n---\n<!-- answer:en -->\nHello there.\n`;
    const first = (await send("POST", "/api/kb/documents", c, { slug: "title-keep", kind: "templates", title: "Tiêu đề gốc", md: md("alpha keyword one") })).json();
    expect((await send("POST", `/api/kb/versions/${first.version.id}/publish`, c)).statusCode).toBe(200);
    expect((await send("POST", "/api/kb/documents", c, { slug: "title-keep", kind: "templates", md: md("alpha keyword two") })).statusCode).toBe(200);
    expect((await get("/api/kb/documents/title-keep", c)).json().document.title).toBe("Tiêu đề gốc");
  });

  it("ticket: xoá được PIC/ghi chú bằng null, trường vắng mặt giữ nguyên", async () => {
    const c = await login(9002);
    const t = (await get("/api/tickets", c)).json().items[0];
    expect(t, "cần có ít nhất một ticket từ các test trước").toBeDefined();
    expect((await send("PATCH", `/api/tickets/${t.id}`, c, { pic: "An", notes: "đã gọi khách" })).statusCode).toBe(200);
    expect((await send("PATCH", `/api/tickets/${t.id}`, c, { status: "in_progress" })).statusCode).toBe(200);
    let cur = (await get("/api/tickets", c)).json().items.find((x: { id: number }) => x.id === t.id);
    expect(cur).toMatchObject({ pic: "An", notes: "đã gọi khách", status: "in_progress" });
    expect((await send("PATCH", `/api/tickets/${t.id}`, c, { pic: null, notes: null })).statusCode).toBe(200);
    cur = (await get("/api/tickets", c)).json().items.find((x: { id: number }) => x.id === t.id);
    expect(cur).toMatchObject({ pic: null, notes: null, status: "in_progress" });
  });

  it("TRUST_PROXY: sau proxy, giới hạn đăng nhập tính theo IP thật thay vì IP của proxy", async () => {
    const cfg = loadConfig({ DATABASE_URL: "pglite:memory", TRUST_PROXY: "true", COOKIE_SECURE: "false", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
    expect(cfg.trustProxy).toBe(true);
    const app2 = await buildAdminServer({ ...svc, cfg } as Services, { now: () => clock.now, webDir: "src/admin/web" });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await app2.inject({ method: "POST", url: "/api/auth/request-code", headers: { ...H, "x-forwarded-for": "203.0.113.5" }, remoteAddress: "10.0.0.1", payload: { telegramId: 4242 } })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
    const other = await app2.inject({ method: "POST", url: "/api/auth/request-code", headers: { ...H, "x-forwarded-for": "203.0.113.99" }, remoteAddress: "10.0.0.1", payload: { telegramId: 4242 } });
    expect(other.statusCode).toBe(200);
    await app2.close();
  });
});

describe("LLM qua gateway (9router) trên Admin Web", () => {
  let gw: Server;
  let gwUrl: string;
  const calls: { url: string; auth?: string; body?: { model?: string; messages?: { content: unknown }[] } }[] = [];
  const KEY = "sk-test-gateway-key-123456";

  beforeAll(async () => {
    gw = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : undefined;
        calls.push({ url: req.url ?? "", auth: req.headers.authorization, body });
        res.setHeader("content-type", "application/json");
        if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "cx/gpt-5.5" }, { id: "cx/gpt-5.4-mini" }, { id: "combo-x" }] }));
        if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401).end(JSON.stringify({ error: "bad key" }));
        if (body?.model === "khong-co-model") return res.writeHead(404).end(JSON.stringify({ error: "model not found" }));
        const sys = String(body?.messages?.[0]?.content ?? "");
        const out = sys.includes('"ok": true') ? { ok: true } : { action: "template", template_id: "how-to-login" };
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
      });
    });
    await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
    gwUrl = `http://127.0.0.1:${(gw.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    await new Promise((r) => gw.close(r));
  });

  it("chưa cấu hình: bot ở chế độ template thuần; viewer không đọc được cấu hình LLM", async () => {
    const admin = await login(9002);
    const v = (await get("/api/llm", admin)).json();
    expect(v).toMatchObject({ ready: false, baseUrlSource: "none", hasKey: false, canStoreKey: true });
    expect(svc.llm?.ready).toBe(false);
    expect((await get("/api/llm", await login(9003))).statusCode).toBe(403);
  });

  it("admin chọn được model nhưng KHÔNG đổi được URL/khoá gateway; owner thì được", async () => {
    const admin = await login(9002);
    expect((await send("PUT", "/api/llm/models", admin, { fast: "cx/gpt-5.4-mini", strong: "cx/gpt-5.5" })).statusCode).toBe(200);
    expect((await send("PUT", "/api/llm/connection", admin, { baseUrl: gwUrl })).statusCode).toBe(403);
    expect((await send("PUT", "/api/llm/models", await login(9003), { fast: "x" })).statusCode).toBe(403);

    const owner = await login(9001);
    expect((await send("PUT", "/api/llm/connection", owner, { baseUrl: "ftp://evil.example" })).statusCode).toBe(400);
    expect((await send("PUT", "/api/llm/connection", owner, { baseUrl: "http://user:pw@host/v1" })).statusCode).toBe(400);
    expect((await send("PUT", "/api/llm/models", owner, { fast: "tên có khoảng trắng" })).statusCode).toBe(400);
    expect((await send("PUT", "/api/llm/connection", owner, { baseUrl: gwUrl + "/", apiKey: KEY })).statusCode).toBe(200);
    const v = (await get("/api/llm", owner)).json();
    expect(v).toMatchObject({ ready: true, baseUrl: gwUrl, baseUrlSource: "custom", hasKey: true, keySource: "custom", modelFast: "cx/gpt-5.4-mini", modelFastSource: "custom" });
    expect(svc.llm?.ready).toBe(true);
  });

  it("khoá API không bao giờ lộ: không trong phản hồi, không rõ trong DB, không trong audit", async () => {
    const owner = await login(9001);
    expect(JSON.stringify((await get("/api/llm", owner)).json())).not.toContain(KEY);
    expect(JSON.stringify((await get("/api/settings", owner)).json())).not.toContain(KEY);
    const stored = await svc.ops.getSecret("llm.api_key");
    expect(stored).toMatch(/^v1./);
    expect(stored).not.toContain(KEY);
    expect(JSON.stringify(await svc.ops.getSettings())).not.toContain(KEY);
    const audit = await svc.db.query("SELECT * FROM audit_log WHERE action LIKE 'llm.%'");
    expect(audit.rowCount).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit.rows)).not.toContain(KEY);
  });

  it("lấy danh sách model từ gateway và thử model đang nhập (chưa lưu)", async () => {
    const admin = await login(9002);
    expect((await get("/api/llm/models", admin)).json().models).toEqual(["combo-x", "cx/gpt-5.4-mini", "cx/gpt-5.5"]);
    const ok = (await send("POST", "/api/llm/test", admin, { tier: "fast" })).json();
    expect(ok).toMatchObject({ ok: true, model: "cx/gpt-5.4-mini" });
    const bad = (await send("POST", "/api/llm/test", admin, { tier: "strong", model: "khong-co-model" })).json();
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("model not found");
    expect((await get("/api/llm", admin)).json().modelStrong).toBe("cx/gpt-5.5"); // thử không làm đổi cấu hình
  });

  it("kiểm tra tất cả model: trả kết quả từng model, chỉ admin trở lên được gọi", async () => {
    const admin = await login(9002);
    const r = (await send("POST", "/api/llm/probe", admin, {})).json();
    expect(r.results.map((x: { model: string }) => x.model)).toEqual(["combo-x", "cx/gpt-5.4-mini", "cx/gpt-5.5"]);
    expect(r.results.every((x: { ok: boolean }) => x.ok)).toBe(true);
    expect((await send("POST", "/api/llm/probe", await login(9003), {})).statusCode).toBe(403);
  });

  it("bot dùng ngay model và khoá mới đã chọn, không cần khởi động lại", async () => {
    const owner = await login(9001);
    expect((await send("PUT", "/api/llm/models", owner, { fast: "combo-x" })).statusCode).toBe(200);
    calls.length = 0;
    const r = await svc.llm!.classify({ text: "how do I log in", lang: "en", context: { profile: "", events: [], recent: [] }, candidates: [{ id: "how-to-login", group: "Account", gist: "how to login" }] });
    expect(r).toEqual({ action: "template", template_id: "how-to-login" });
    const call = calls.find((c) => c.url === "/v1/chat/completions")!;
    expect(call.body?.model).toBe("combo-x");
    expect(call.auth).toBe(`Bearer ${KEY}`);
  });

  it("xoá khoá / về mặc định: quay lại giá trị trong .env (ở đây là trống => chưa sẵn sàng)", async () => {
    const owner = await login(9001);
    expect((await send("PUT", "/api/llm/connection", owner, { baseUrl: "", apiKey: "" })).statusCode).toBe(200);
    expect((await send("PUT", "/api/llm/models", owner, { fast: "", strong: "" })).statusCode).toBe(200);
    expect((await get("/api/llm", owner)).json()).toMatchObject({ ready: false, hasKey: false, baseUrlSource: "none", modelFastSource: "env" });
    expect(await svc.ops.getSecret("llm.api_key")).toBeNull();
    expect(svc.llm?.ready).toBe(false);
  });
});

describe("truy vết và an toàn dữ liệu phía quản trị", () => {
  it("ghi chú ticket: bản cũ không được ghi đè dòng bot vừa nối thêm (409); nhật ký giữ giá trị trước", async () => {
    const admin = await login(9002);
    const tk = await svc.conv.createTicket({ episodeId: null, userId: 777050, category: "wallet", reason: "test" });
    expect((await send("PATCH", `/api/tickets/${tk.id}`, admin, { notes: "đã gọi khách", notes_base: null })).statusCode).toBe(200);
    await svc.conv.appendTicketNote(tk.id, "[bot] khách hỏi lại: swap fail"); // bot nối thêm trong lúc admin đang soạn
    const stale = await send("PATCH", `/api/tickets/${tk.id}`, admin, { notes: "đã gọi khách, hẹn mai", notes_base: "đã gọi khách" });
    expect(stale.statusCode).toBe(409);
    const cur = (await svc.db.query<{ notes: string }>("SELECT notes FROM tickets WHERE id = $1", [tk.id])).rows[0]!.notes;
    expect(cur).toContain("khách hỏi lại: swap fail");
    expect((await send("PATCH", `/api/tickets/${tk.id}`, admin, { notes: cur + "\nhẹn mai", notes_base: cur })).statusCode).toBe(200);
    const au = await svc.db.query<{ before: { notes?: string } }>("SELECT before FROM audit_log WHERE action = 'ticket.update' AND entity = $1 ORDER BY id DESC LIMIT 1", [`ticket:${tk.id}`]);
    expect(au.rows[0]!.before.notes).toBe(cur);
  });

  it("viewer không thấy Telegram ID của khách qua danh sách ticket trong chi tiết hội thoại", async () => {
    await svc.conv.touchUser({ id: 777051, name: "Khách", username: "khach51" }, clock.now);
    const ep = await svc.conv.openEpisode({ userId: 777051, issue: "x", topicGroup: "Wallet" }, clock.now);
    await svc.conv.createTicket({ episodeId: ep.id, userId: 777051, category: "wallet", reason: "test" });
    const body = (await get(`/api/episodes/${ep.id}`, await login(9003))).body;
    expect(body).not.toContain("777051");
    expect((await get(`/api/episodes/${ep.id}`, await login(9002))).json().tickets[0].user_id).toBe(777051);
  });

  it("xoá câu hỏi mẫu (hàng rào chặn Publish) phải để lại nhật ký kèm nội dung", async () => {
    const admin = await login(9002);
    const id = (await send("POST", "/api/eval/cases", admin, { question: "câu mẫu sẽ bị xoá", expected: "how-to-login" })).json().id;
    expect((await send("DELETE", `/api/eval/cases/${id}`, admin)).statusCode).toBe(200);
    const au = await svc.db.query<{ actor: string; before: { question: string } }>("SELECT actor, before FROM audit_log WHERE action = 'eval.delete' AND entity = $1", [String(id)]);
    expect(au.rows[0]!.before.question).toBe("câu mẫu sẽ bị xoá");
    expect((await send("DELETE", `/api/eval/cases/${id}`, admin)).statusCode).toBe(404);
  });

  it("bản dịch sửa tay: đổi @handle/URL so với bản tiếng Anh đã duyệt thì bị từ chối; hợp lệ thì duyệt và nhật ký ghi nội dung trước/sau", async () => {
    const admin = await login(9002);
    const en = svc.live.index.get("fp-12-escalate")!.answers.en!;
    await svc.kb.saveTranslation("fp-12-escalate", "vi", en.replace("I'm sorry", "Xin lỗi"), createHash("sha1").update(en).digest("hex"), "llm", "pending");
    const bad = await send("POST", "/api/translations/approve", admin, { template_id: "fp-12-escalate", lang: "vi", text: "Xin lỗi. Liên hệ @fake_support nhé" });
    expect(bad.statusCode).toBe(400);
    const evil = await send("POST", "/api/translations/approve", admin, { template_id: "fp-12-escalate", lang: "vi", text: en + " https://evil.example.com" });
    expect(evil.statusCode).toBe(400);
    expect((await svc.kb.getTranslation("fp-12-escalate", "vi"))!.status).toBe("pending");
    const good = en.replace("I'm sorry", "Rất tiếc");
    expect((await send("POST", "/api/translations/approve", admin, { template_id: "fp-12-escalate", lang: "vi", text: good })).statusCode).toBe(200);
    const au = await svc.db.query<{ after: { text: string } }>("SELECT after FROM audit_log WHERE action = 'translation.approve' ORDER BY id DESC LIMIT 1");
    expect(au.rows[0]!.after.text).toBe(good);
  });
});

describe("quét chồng lấn toàn kho (Admin Web)", () => {
  it("GET /api/kb/overlap trả về cặp + ngưỡng + model; POST review từ chối khi không có cặp", async () => {
    const c = await login(9002);
    const r = (await get("/api/kb/overlap?min=0.55", c)).json();
    expect(Array.isArray(r.pairs)).toBe(true);
    expect(r.min).toBe(0.55);
    expect(typeof r.model).toBe("string");
    expect((await send("POST", "/api/kb/overlap/review", c, { pairs: [] })).statusCode).toBe(400);
  });
});

describe("tìm kiếm xuyên suốt kho tri thức (Admin Web)", () => {
  it("tìm theo id template trả về đúng template kèm tài liệu chứa nó; tìm theo từ khoá trả về template khớp; câu quá ngắn hoặc không khớp trả rỗng", async () => {
    const c = await login(9002);
    const byId = (await get("/api/kb/search?q=esc-login-fail", c)).json();
    const hit = byId.items.find((x: { type: string; id?: string }) => x.type === "template" && x.id === "esc-login-fail");
    expect(hit).toBeTruthy();
    expect(typeof hit.docSlug).toBe("string");
    expect(hit.docSlug.length).toBeGreaterThan(0);

    const byKeyword = (await get("/api/kb/search?q=login fail", c)).json();
    expect(byKeyword.items.some((x: { type: string; id?: string }) => x.type === "template" && x.id === "esc-login-fail")).toBe(true);

    const empty = (await get("/api/kb/search?q=x", c)).json();
    expect(empty.items).toEqual([]);

    const none = (await get("/api/kb/search?q=khong-ton-tai-zzz", c)).json();
    expect(none.items).toEqual([]);
  });
});

describe("xung đột nội dung đã publish (kb_conflicts) trên danh sách Tài liệu", () => {
  it("danh sách Tài liệu luôn kèm số xung đột + gợi ý hover; GET conflicts theo tài liệu; Áp dụng gỡ máy móc cần quyền admin", async () => {
    const c = await login(9002);
    const docs = (await get("/api/kb/documents", c)).json();
    expect(docs.items.length).toBeGreaterThan(0);
    for (const d of docs.items) {
      expect(typeof d.conflicts).toBe("number");
      expect(d.conflicts === 0 ? d.conflictHint === null : typeof d.conflictHint === "string").toBe(true);
    }

    const someDoc = docs.items[0].slug;
    const conflicts = (await get(`/api/kb/conflicts?doc=${encodeURIComponent(someDoc)}`, c)).json();
    expect(Array.isArray(conflicts.items)).toBe(true);
    expect((await get("/api/kb/conflicts", c)).statusCode).toBe(400); // thiếu ?doc

    const viewer = await login(9003);
    expect((await send("POST", "/api/kb/conflicts/apply", viewer, { templateId: "esc-login-fail", phrase: "login fail" })).statusCode).toBe(403);

    const notFound = await send("POST", "/api/kb/conflicts/apply", c, { templateId: "khong-ton-tai-xyz", phrase: "x" });
    expect(notFound.statusCode).toBe(404);
  });
});

describe("trợ lý Nạp nội dung mới (Admin Web) — /api/kb/intake*", () => {
  let gw: Server;
  let gwUrl: string;
  const KEY = "sk-intake-test-key";
  const CONFLICT_MARKER = "ZZ_INTAKE_CONFLICT_TEST";

  beforeAll(async () => {
    gw = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : undefined;
        res.setHeader("content-type", "application/json");
        if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "combo-x" }] }));
        const sys = String(body?.messages?.[0]?.content ?? "");
        const userRaw = body?.messages?.[1]?.content;
        const user = Array.isArray(userRaw) ? userRaw.map((p: { text?: string }) => p.text ?? "").join(" ") : String(userRaw ?? "");
        let out: unknown;
        if (sys.includes("Skill: intake-draft")) {
          out = user.includes(CONFLICT_MARKER)
            ? {
                kind: "templates",
                slug: "intake-conflict-doc",
                title: "Intake conflict test",
                templates: [{ id: "intake-conflict-tpl", group: "Test", keywords: ["cannot login because of face verify fail issue right now"], examples: ["cannot login because of face verify fail issue right now", "getting face verify fail error every time I try logging in"], answer_en: "Conflict test answer." }],
                knowledge: null,
              }
            : {
                kind: "templates",
                slug: "intake-clean-doc",
                title: "Intake clean test",
                templates: [{ id: "intake-clean-tpl", group: "Test", keywords: ["zzintake unique clean phrase"], examples: ["zzintake unique clean phrase example", "another zzintake unique clean phrase wording"], answer_en: "Clean test answer." }],
                knowledge: null,
              };
        } else if (sys.includes("Skill: review-overlap")) {
          out = { verdict: "subset", reason: "test reason", suggestion: "test suggestion" };
        } else {
          out = { action: "template", template_id: "how-to-login" };
        }
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
      });
    });
    await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
    gwUrl = `http://127.0.0.1:${(gw.address() as AddressInfo).port}/v1`;
    const owner = await login(9001);
    await send("PUT", "/api/llm/connection", owner, { baseUrl: gwUrl, apiKey: KEY });
    await send("PUT", "/api/llm/models", owner, { fast: "combo-x", strong: "combo-x", intake: "combo-x" });
  });
  afterAll(async () => {
    const owner = await login(9001);
    await send("PUT", "/api/llm/connection", owner, { baseUrl: "", apiKey: "" });
    await send("PUT", "/api/llm/models", owner, { fast: "", strong: "", intake: "" });
    await new Promise((r) => gw.close(r));
  });

  it("viewer bị chặn trên mọi route intake", async () => {
    const viewer = await login(9003);
    expect((await send("POST", "/api/kb/intake", viewer, { rawText: "x".repeat(30) })).statusCode).toBe(403);
    expect((await send("POST", "/api/kb/intake/conflicts/recheck", viewer, { editedText: "x" })).statusCode).toBe(403);
    expect((await send("POST", "/api/kb/intake/conflicts/apply", viewer, {})).statusCode).toBe(403);
    expect((await send("POST", "/api/kb/intake/1/publish-all", viewer, { versionIds: [1] })).statusCode).toBe(403);
  });

  it("dán nội dung sạch (không trùng gì) -> tạo bản nháp, không có khung xung đột, publish-all lên được ngay", async () => {
    const c = await login(9002);
    const r = await send("POST", "/api/kb/intake", c, { rawText: "Một đoạn văn bản tự do dài hơn hai mươi ký tự để mô tả một tình huống hỗ trợ khách hàng hoàn toàn mới, không đụng gì tới nội dung cũ." });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.version.slug).toBe("intake-clean-doc");
    expect(body.report.ok).toBe(true);
    expect(body.boxes).toEqual([]);

    const pub = (await send("POST", `/api/kb/intake/${body.version.id}/publish-all`, c, { versionIds: [body.version.id] })).json();
    expect(pub.results).toEqual([{ versionId: body.version.id, status: "published" }]);
  });

  it("dán nội dung trùng với template có sẵn -> khung xung đột có narrow + gợi ý AI; kiểm tra lại/gỡ máy móc/publish-all hoạt động đúng", async () => {
    const c = await login(9002);
    const r = await send("POST", "/api/kb/intake", c, { rawText: `Nội dung có chủ đích trùng lặp để kiểm thử. ${CONFLICT_MARKER} — đủ dài hơn hai mươi ký tự.` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.version.slug).toBe("intake-conflict-doc");
    expect(body.boxes.length).toBeGreaterThan(0);
    const box = body.boxes.find((x: { narrow: { templateId: string; phrase: string } | null }) => x.narrow?.templateId === "esc-login-fail");
    expect(box, "phải bắt được chồng lấn với esc-login-fail qua cụm 'face verify fail'").toBeTruthy();
    expect(box.verdict).toBe("subset");
    expect(box.reason).toBe("test reason");

    // Kiểm tra lại: cụm còn trong văn bản gốc -> vẫn xung đột; đã sửa hết -> hết xung đột
    const still = await send("POST", "/api/kb/intake/conflicts/recheck", c, { narrow: box.narrow, editedText: "face verify fail" });
    expect(still.json().stillConflicting).toBe(true);
    const clean = await send("POST", "/api/kb/intake/conflicts/recheck", c, { narrow: box.narrow, editedText: "no overlap here at all" });
    expect(clean.json().stillConflicting).toBe(false);

    // Save (gỡ máy móc): narrow đã biết -> applyNarrow, tạo bản nháp mới cho tài liệu chứa esc-login-fail
    const applied = await send("POST", "/api/kb/intake/conflicts/apply", c, { templateId: box.narrow.templateId, phrase: box.narrow.phrase });
    expect(applied.statusCode).toBe(200);
    const appliedBody = applied.json();
    expect(appliedBody.slug).toBe("templates-fast-path");

    // Gỡ đúng cụm "face verify fail" khỏi esc-login-fail lại phá một câu trong Bộ câu hỏi mẫu thật (content/eval/eval_cases.jsonl
    // mong đợi "face verify fail" -> esc-login-fail) — bước "5. Test hồi quy" đúng vai trò của nó: chặn publish thay vì âm
    // thầm làm hỏng một hành vi đã kiểm chứng, dù cụm này đến từ nút "Áp dụng" chứ không phải admin gõ tay.
    const pub = (await send("POST", `/api/kb/intake/${body.version.id}/publish-all`, c, { versionIds: [body.version.id, appliedBody.versionId] })).json();
    expect(pub.results[0]).toEqual({ versionId: body.version.id, status: "published" });
    expect(pub.results[1].versionId).toBe(appliedBody.versionId);
    expect(pub.results[1].error).toContain("5. Test hồi quy");
  });

  it("sửa tự do một khung (không có narrow) -> applyBoxEdit tạo bản nháp mới cho đúng template/đúng đoạn", async () => {
    const c = await login(9002);
    const applied = await send("POST", "/api/kb/intake/conflicts/apply", c, { targetDoc: "templates-fast-path", kind: "template", templateId: "fp-2-withdraw", lang: "en", newText: "Rewritten withdraw answer for test." });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().slug).toBe("templates-fast-path");

    const notFound = await send("POST", "/api/kb/intake/conflicts/apply", c, { targetDoc: "templates-fast-path", kind: "template", templateId: "khong-ton-tai-xyz", lang: "en", newText: "x" });
    expect(notFound.statusCode).toBe(404);

    const badBody = await send("POST", "/api/kb/intake/conflicts/apply", c, {});
    expect(badBody.statusCode).toBe(400);
  });

  it("recheck không narrow mà thiếu otherText -> báo lỗi rõ ràng", async () => {
    const c = await login(9002);
    expect((await send("POST", "/api/kb/intake/conflicts/recheck", c, { editedText: "abc" })).statusCode).toBe(400);
  });

  it("mở lại trang (GET boxes) dựng lại đúng khung như lúc tạo, không cần AI phân loại lại", async () => {
    const c = await login(9002);
    const created = (await send("POST", "/api/kb/intake", c, { rawText: `Nội dung khác để kiểm tra tải lại trang. ${CONFLICT_MARKER} — đủ dài.` })).json();
    expect(created.boxes.length).toBeGreaterThan(0);
    const reloaded = (await get(`/api/kb/intake/${created.version.id}/boxes`, c)).json();
    expect(reloaded.boxes.length).toBe(created.boxes.length);
    expect(reloaded.boxes[0].narrow).toEqual(created.boxes[0].narrow);
    expect((await get(`/api/kb/intake/999999/boxes`, c)).statusCode).toBe(404);
  });

  function multipartUpload(cookie: string, filename: string, content: string | Buffer, mime: string) {
    const boundary = "----intaketestboundary";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
      Buffer.isBuffer(content) ? content : Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({ method: "POST", url: "/api/kb/intake/extract", headers: { cookie, "x-requested-with": "admin-web", "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body }) as Promise<Res>;
  }

  it("kéo-thả tệp .txt -> trích đúng nội dung; viewer bị chặn; tệp rỗng và định dạng lạ báo lỗi rõ ràng", async () => {
    const c = await login(9002);
    const r = await multipartUpload(c, "note.txt", "Nội dung ghi chú hỗ trợ khách hàng, đủ dài để dùng thử.", "text/plain");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ text: "Nội dung ghi chú hỗ trợ khách hàng, đủ dài để dùng thử.", filename: "note.txt" });

    const viewer = await login(9003);
    expect((await multipartUpload(viewer, "note.txt", "x", "text/plain")).statusCode).toBe(403);

    const empty = await multipartUpload(c, "empty.txt", "   ", "text/plain");
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error).toContain("không trích được nội dung");

    const bad = await multipartUpload(c, "photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toContain("không hỗ trợ định dạng");
  });
});
