import { mkdtempSync, rmSync } from "node:fs";
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
  const cfg = loadConfig({ DATABASE_URL: "pglite:memory", ADMIN_TELEGRAM_IDS: "9001,9002", OWNER_TELEGRAM_ID: "9001", MEDIA_DIR: media, CONTENT_DIR: "content", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  svc = await createServices(cfg, "admin");
  channel = new FakeChannel();
  (svc as { channel: unknown }).channel = channel;
  await svc.ops.upsertAdmin(9003, "viewer", null);
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
    const tried = (await get("/api/kb/try?q=" + encodeURIComponent("how to get moon base access"), c)).json();
    expect(tried.key).toBe("web-added");
    expect(tried.answer).toBe("Moon base is not open yet.");
    expect((await get("/api/templates", c)).json().items.some((t: { id: string }) => t.id === "web-added")).toBe(true);
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
