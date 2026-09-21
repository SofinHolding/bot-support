/** Admin API + phục vụ giao diện web tĩnh. */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../app";
import type { PredicateMap } from "../core/predicates";
import { validateSetting, DEFAULT_SETTINGS } from "../core/settings";
import type { AdminRole } from "../db/repo-ops";
import { evalSettings, outcomeKey, routeOffline, runEval } from "../kb/eval";
import { KbError, type Actor } from "../kb/service";
import { localDate } from "../worker/schedule";

const RANK: Record<AdminRole, number> = { viewer: 1, admin: 2, owner: 3 };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SESSION_HOURS = 12;
const PROTECTED_KEYS = ["predicates", "url_whitelist_extra"] as const;

declare module "fastify" {
  interface FastifyRequest {
    admin?: { id: number; role: AdminRole; name: string | null };
  }
}

export interface AdminServerOptions {
  now?: () => Date;
  webDir?: string;
}

const maskId = (id: number) => `•••${String(id).slice(-4)}`;

function webDirDefault(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "web"), join(here, "..", "src", "admin", "web"), join(process.cwd(), "src", "admin", "web")]) if (existsSync(join(p, "index.html"))) return p;
  return join(process.cwd(), "src", "admin", "web");
}

export async function buildAdminServer(svc: Services, opt: AdminServerOptions = {}): Promise<FastifyInstance> {
  const now = opt.now ?? (() => new Date());
  const { ops, conv, kb, kbService, live, cfg } = svc;
  // Sau reverse proxy phải bật TRUST_PROXY, nếu không mọi admin dùng chung một bộ đếm giới hạn đăng nhập theo IP.
  const app = Fastify({ logger: false, bodyLimit: 2_000_000, trustProxy: cfg.trustProxy });
  await app.register(fastifyCookie);

  // Các nút như Publish/Đăng xuất gửi POST không có body kèm content-type JSON: coi là {} thay vì báo lỗi 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      done(Object.assign(new Error("JSON không hợp lệ"), { statusCode: 400 }), undefined);
    }
  });

  // ---------------------------------------------------------------- bảo mật chung
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (_req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
  });

  // Giới hạn thử đăng nhập theo IP (bộ nhớ, đủ cho một instance)
  const attempts = new Map<string, { n: number; reset: number }>();
  const limited = (ip: string, max: number) => {
    const t = now().getTime();
    const cur = attempts.get(ip);
    if (!cur || cur.reset < t) {
      attempts.set(ip, { n: 1, reset: t + 60_000 });
      return false;
    }
    cur.n++;
    return cur.n > max;
  };

  // Xác thực phiên + chống CSRF (SameSite=Strict + header tuỳ biến cho mọi thao tác ghi)
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/auth/")) return;
    if (req.method !== "GET" && req.headers["x-requested-with"] !== "admin-web") return reply.code(403).send({ error: "thiếu header x-requested-with" });
    const token = req.cookies.sid;
    const sess = token ? await ops.getSession(sha(token), now()) : null;
    const admin = sess ? await ops.getAdmin(sess.telegram_id) : null;
    if (!admin) return reply.code(401).send({ error: "chưa đăng nhập" });
    req.admin = { id: admin.telegram_id, role: admin.role, name: admin.name };
  });

  const need = (min: AdminRole) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.admin || RANK[req.admin.role] < RANK[min]) return reply.code(403).send({ error: "không đủ quyền" });
  };
  const actor = (req: FastifyRequest): Actor => ({ id: req.admin!.id, role: req.admin!.role, label: `${req.admin!.name ?? "admin"}#${req.admin!.id}` });
  const audit = (req: FastifyRequest, action: string, entity: string | null, before: unknown, after: unknown) => ops.audit(actor(req).label, action, entity, before, after);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof KbError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "dữ liệu không hợp lệ", details: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    svc.log("error", "admin api lỗi", { err: err.stack });
    return reply.code(500).send({ error: "lỗi máy chủ" });
  });

  // ---------------------------------------------------------------- đăng nhập bằng mã gửi qua Telegram
  app.post("/api/auth/request-code", async (req, reply) => {
    const { telegramId } = z.object({ telegramId: z.coerce.number().int().positive() }).parse(req.body);
    if (limited(req.ip, 10)) return reply.code(429).send({ error: "thử quá nhiều lần" });
    const admin = await ops.getAdmin(telegramId);
    const recent = await ops.recentLoginCodes(telegramId, new Date(now().getTime() - 15 * 60_000));
    if (admin && recent < 3) {
      const code = String(randomInt(100000, 1_000_000));
      await ops.createLoginCode(telegramId, sha(`${telegramId}:${code}`), new Date(now().getTime() + 5 * 60_000));
      try {
        await svc.channel.send(telegramId, `Mã đăng nhập trang quản trị InterLink Support: ${code}\nHết hạn sau 5 phút. Không chia sẻ mã này cho ai.`);
      } catch (e) {
        svc.log("warn", "không gửi được mã đăng nhập", { err: (e as Error).message });
      }
    }
    return { ok: true }; // luôn trả lời giống nhau: không lộ ai là admin
  });

  app.post("/api/auth/verify", async (req, reply) => {
    const { telegramId, code } = z.object({ telegramId: z.coerce.number().int().positive(), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    if (limited(req.ip, 10)) return reply.code(429).send({ error: "thử quá nhiều lần" });
    const ok = await ops.consumeLoginCode(telegramId, sha(`${telegramId}:${code}`), now());
    const admin = ok ? await ops.getAdmin(telegramId) : null;
    if (!admin) return reply.code(401).send({ error: "mã không đúng hoặc đã hết hạn" });
    const token = randomBytes(32).toString("hex");
    await ops.createSession(sha(token), telegramId, new Date(now().getTime() + SESSION_HOURS * 3600_000));
    reply.setCookie("sid", token, { httpOnly: true, sameSite: "strict", secure: cfg.cookieSecure, path: "/", maxAge: SESSION_HOURS * 3600 });
    await ops.audit(`admin#${telegramId}`, "auth.login", null, null, { role: admin.role });
    return { ok: true, role: admin.role };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies.sid;
    if (token) await ops.deleteSession(sha(token));
    reply.clearCookie("sid", { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => ({ id: req.admin!.id, role: req.admin!.role, name: req.admin!.name }));

  // ---------------------------------------------------------------- hội thoại
  const viewerMask = (req: FastifyRequest, v: number | null | undefined) => (v == null ? v : req.admin!.role === "viewer" ? maskId(v) : v);

  app.get("/api/episodes", async (req) => {
    const q = z.object({ status: z.string().optional(), q: z.string().max(100).optional(), userId: z.coerce.number().optional(), limit: z.coerce.number().min(1).max(100).default(30), offset: z.coerce.number().min(0).default(0) }).parse(req.query);
    const rows = (await ops.listEpisodes({ status: q.status || undefined, q: q.q || undefined, userId: q.userId, limit: q.limit, offset: q.offset })) as (Record<string, unknown> & { user_id: number })[];
    const viewer = req.admin!.role === "viewer";
    return { items: rows.map((r) => ({ ...r, user_id: viewerMask(req, r.user_id), user_username: viewer ? null : r.user_username, user_name: viewer ? null : r.user_name })) };
  });

  app.get("/api/episodes/:id", async (req, reply) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const ep = await conv.getEpisode(id);
    if (!ep) return reply.code(404).send({ error: "không tìm thấy" });
    const [detail, user, tickets, parent] = await Promise.all([ops.episodeDetail(id), conv.getUser(ep.user_id), svc.db.query("SELECT * FROM tickets WHERE episode_id = $1 ORDER BY id", [id]), ep.parent_episode_id ? conv.getEpisode(ep.parent_episode_id) : null]);
    const viewer = req.admin!.role === "viewer";
    return { episode: { ...ep, user_id: viewerMask(req, ep.user_id) }, parent, user: user ? { ...user, telegram_id: viewerMask(req, user.telegram_id), username: viewer ? null : user.username, name: viewer ? null : user.name } : null, tickets: tickets.rows, ...detail };
  });

  app.get("/api/users", async (req) => {
    const q = z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().min(1).max(100).default(30), offset: z.coerce.number().min(0).default(0) }).parse(req.query);
    const rows = await conv.listUsers({ q: q.q || undefined, limit: q.limit, offset: q.offset });
    const viewer = req.admin!.role === "viewer";
    return { items: rows.map((u) => ({ ...u, telegram_id: viewerMask(req, u.telegram_id), username: viewer ? null : u.username, name: viewer ? null : u.name })) };
  });

  app.get("/api/users/:id", { preHandler: need("admin") }, async (req, reply) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const user = await conv.getUser(id);
    if (!user) return reply.code(404).send({ error: "không tìm thấy" });
    const [episodes, anti, events] = await Promise.all([conv.recentEpisodes(id, 20), conv.getAntispam(id), conv.userEvents(id, ["antispam_warning", "antispam_block", "antispam_unblock", "security_alert"], 30)]);
    return { user, episodes, antispam: anti, events };
  });

  // ---------------------------------------------------------------- ticket
  app.get("/api/tickets", async (req) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().min(1).max(100).default(30), offset: z.coerce.number().min(0).default(0) }).parse(req.query);
    const rows = await conv.listTickets({ status: q.status || undefined, limit: q.limit, offset: q.offset });
    const viewer = req.admin!.role === "viewer";
    return { items: rows.map((t) => ({ ...t, user_id: viewerMask(req, t.user_id), user_name: viewer ? null : t.user_name, user_username: viewer ? null : t.user_username })) };
  });

  app.patch("/api/tickets/:id", { preHandler: need("admin") }, async (req) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const body = z.object({ status: z.enum(["open", "in_progress", "closed"]).optional(), pic: z.string().max(80).nullable().optional(), notes: z.string().max(4000).nullable().optional() }).parse(req.body);
    await conv.updateTicket(id, body); // trường có mặt trong body (kể cả null) được ghi; trường vắng mặt giữ nguyên
    await audit(req, "ticket.update", `ticket:${id}`, null, body);
    return { ok: true };
  });

  // ---------------------------------------------------------------- kho tri thức
  app.get("/api/kb/documents", async () => ({ items: await kb.listDocuments(), kbVersion: live.version }));

  app.get("/api/kb/documents/:slug", async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const doc = await kb.getDocument(slug);
    if (!doc) return reply.code(404).send({ error: "không tìm thấy" });
    return { document: doc, versions: (await kb.listVersions(slug)).map((v) => ({ ...v, source_md: undefined })) };
  });

  app.get("/api/kb/versions/:id", { preHandler: need("admin") }, async (req, reply) => {
    const v = await kb.getVersion(z.coerce.number().parse((req.params as { id: string }).id));
    if (!v) return reply.code(404).send({ error: "không tìm thấy" });
    return { version: v };
  });

  app.post("/api/kb/documents", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ slug: z.string().min(2).max(80), kind: z.enum(["templates", "knowledge"]), title: z.string().max(200).optional(), md: z.string().min(10).max(1_000_000) }).parse(req.body);
    const r = await kbService.createDraft({ slug: b.slug, kind: b.kind, title: b.title, md: b.md, author: actor(req) });
    await audit(req, "kb.create_draft", b.slug, null, { version: r.version.version, ok: r.report.ok });
    return { version: { ...r.version, source_md: undefined }, report: r.report };
  });

  app.put("/api/kb/versions/:id", { preHandler: need("admin") }, async (req) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const b = z.object({ md: z.string().min(10).max(1_000_000) }).parse(req.body);
    const report = await kbService.updateDraft(id, b.md);
    await audit(req, "kb.update_draft", `version:${id}`, null, { ok: report.ok });
    return { report };
  });

  app.post("/api/kb/versions/:id/validate", { preHandler: need("admin") }, async (req) => ({ report: await kbService.revalidate(z.coerce.number().parse((req.params as { id: string }).id)) }));

  app.post("/api/kb/versions/:id/publish", { preHandler: need("admin") }, async (req) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const status = await kbService.publish(id, actor(req));
    return { status };
  });

  app.post("/api/kb/documents/:slug/rollback", { preHandler: need("admin") }, async (req) => {
    const slug = (req.params as { slug: string }).slug;
    const b = z.object({ version: z.coerce.number().int().positive() }).parse(req.body);
    return { status: await kbService.rollback(slug, b.version, actor(req)) };
  });

  app.get("/api/templates", async () => ({
    items: live.index.templates.map((t) => ({ id: t.id, group: t.group, response_mode: t.response_mode, priority: t.priority, langs: Object.keys(t.answers), keywords: t.match.keywords.length, ticket: t.ticket ?? null, answer_en: t.answer_from ? `(dùng câu của ${t.answer_from})` : (t.answers.en ?? "").slice(0, 240) })),
    kbVersion: live.version,
  }));

  /** "Thử câu hỏi này": xem template nào sẽ được chọn (tầng 0-1, không tốn token) và vì sao. */
  app.get("/api/kb/try", async (req) => {
    const q = z.object({ q: z.string().min(1).max(500), image_type: z.string().optional(), last: z.string().optional() }).parse(req.query);
    const r = await routeOffline(q.q, q.image_type, live.index, live.evaluator, evalSettings(live.urlHosts), q.last);
    const tid = r.outcome.kind === "TEMPLATE" ? r.outcome.templateId : null;
    const answer = tid ? (await svc.resolver.forTemplate(tid, "en").catch(() => null))?.text ?? null : null;
    return { outcome: r.outcome, key: outcomeKey(r.outcome), answer, trace: r.trace };
  });

  // ---------------------------------------------------------------- bản dịch
  app.get("/api/translations", async (req) => ({ items: await kb.listTranslations((req.query as { status?: string }).status) }));
  app.post("/api/translations/approve", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ template_id: z.string(), lang: z.string().min(2).max(8), text: z.string().max(4096).optional() }).parse(req.body);
    await kb.approveTranslation(b.template_id, b.lang, actor(req).label, b.text);
    await audit(req, "translation.approve", `${b.template_id}:${b.lang}`, null, { edited: !!b.text });
    return { ok: true };
  });

  // ---------------------------------------------------------------- thay đổi cần người thứ hai duyệt
  app.get("/api/changes", { preHandler: need("admin") }, async (req) => ({ items: await ops.listChanges((req.query as { status?: string }).status ?? "pending") }));

  app.post("/api/changes/:id/approve", { preHandler: need("admin") }, async (req) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const ch = await ops.getChange(id);
    if (!ch || ch.status !== "pending") throw new KbError("không có thay đổi chờ duyệt", 404);
    if (ch.proposed_by === req.admin!.id) throw new KbError("người đề xuất không thể tự duyệt: cần một người khác", 403);
    if (ch.kind === "kb_publish") {
      await kbService.approve(id, actor(req));
      return { ok: true };
    }
    if (ch.kind === "protected_setting") {
      const { key, value } = ch.payload as { key: string; value: unknown };
      await ops.setProtected(key, value, actor(req).label);
      await ops.bumpKbVersion(actor(req).label);
      await live.rebuild();
    } else if (ch.kind === "admin_change") {
      const p = ch.payload as { action: "upsert" | "remove"; telegramId: number; role?: AdminRole };
      if (p.action === "upsert") await ops.upsertAdmin(p.telegramId, p.role ?? "admin", null);
      else {
        const owners = (await ops.listAdmins()).filter((a) => a.role === "owner");
        if (owners.length === 1 && owners[0]!.telegram_id === p.telegramId) throw new KbError("không thể gỡ owner cuối cùng");
        await ops.removeAdmin(p.telegramId);
      }
    }
    await ops.decideChange(id, "approved", req.admin!.id);
    await audit(req, `change.approve.${ch.kind}`, `change:${id}`, null, ch.payload);
    return { ok: true };
  });

  app.post("/api/changes/:id/reject", { preHandler: need("admin") }, async (req) => {
    await kbService.reject(z.coerce.number().parse((req.params as { id: string }).id), actor(req));
    return { ok: true };
  });

  // ---------------------------------------------------------------- cấu hình
  app.get("/api/settings", async (req) => {
    const stored = await ops.getSettings();
    const items = Object.entries(DEFAULT_SETTINGS).map(([key, def]) => ({ key, default: def, value: stored[key] ?? def, custom: stored[key] !== undefined }));
    // Viewer chỉ thấy cấu hình thường. Cấu hình được bảo vệ và danh sách admin (Telegram ID) chỉ từ admin trở lên.
    if (RANK[req.admin!.role] < RANK.admin) return { items, protectedKeys: [], protected: null, admins: null };
    const prot = await ops.getProtected();
    return { items, protectedKeys: PROTECTED_KEYS, protected: { url_whitelist_extra: prot.url_whitelist_extra ?? [], predicates: prot.predicates ?? live.predicates ?? {} }, admins: await ops.listAdmins() };
  });

  app.put("/api/settings/:key", { preHandler: need("admin") }, async (req) => {
    const key = (req.params as { key: string }).key;
    const { value } = z.object({ value: z.unknown() }).parse(req.body);
    const err = validateSetting(key, value);
    if (err) throw new KbError(err);
    const before = (await ops.getSettings())[key];
    await ops.setSetting(key, value, actor(req).label);
    svc.settings.invalidate();
    await audit(req, "settings.update", key, before ?? null, value);
    return { ok: true };
  });

  /** Cấu hình được bảo vệ: chỉ owner đề xuất, người khác duyệt. */
  app.post("/api/protected/:key", { preHandler: need("owner") }, async (req) => {
    const key = (req.params as { key: string }).key;
    if (!(PROTECTED_KEYS as readonly string[]).includes(key)) throw new KbError("khoá không thuộc cấu hình được bảo vệ");
    const { value } = z.object({ value: z.unknown() }).parse(req.body);
    if (key === "url_whitelist_extra" && !(Array.isArray(value) && value.every((x) => typeof x === "string" && /^[a-z0-9.-]+$/i.test(x)))) throw new KbError("url_whitelist_extra phải là danh sách hostname");
    if (key === "predicates") {
      const m = value as PredicateMap;
      if (!m || typeof m !== "object" || Object.keys(m).length === 0 || Object.values(m).some((d) => !d || typeof d !== "object" || !("any" in d || "regex" in d || "all_of" in d || "image_type" in d))) throw new KbError("predicates không đúng cấu trúc");
      for (const d of Object.values(m)) {
        if (!("regex" in d)) continue;
        try {
          new RegExp(d.regex, d.flags ?? "iu");
        } catch {
          throw new KbError(`regex không hợp lệ: ${d.regex}`);
        }
      }
    }
    const id = await ops.proposeChange("protected_setting", { key, value }, req.admin!.id);
    await audit(req, "protected.propose", key, null, { changeId: id });
    return { changeId: id, status: "pending_approval" };
  });

  app.post("/api/admins", { preHandler: need("owner") }, async (req) => {
    const b = z.object({ telegramId: z.coerce.number().int().positive(), role: z.enum(["owner", "admin", "viewer"]) }).parse(req.body);
    const id = await ops.proposeChange("admin_change", { action: "upsert", telegramId: b.telegramId, role: b.role }, req.admin!.id);
    await audit(req, "admin.propose_upsert", String(b.telegramId), null, { role: b.role, changeId: id });
    return { changeId: id, status: "pending_approval" };
  });

  app.delete("/api/admins/:id", { preHandler: need("owner") }, async (req) => {
    const telegramId = z.coerce.number().parse((req.params as { id: string }).id);
    const id = await ops.proposeChange("admin_change", { action: "remove", telegramId }, req.admin!.id);
    await audit(req, "admin.propose_remove", String(telegramId), null, { changeId: id });
    return { changeId: id, status: "pending_approval" };
  });

  app.get("/api/audit", { preHandler: need("admin") }, async (req) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(200).default(50), offset: z.coerce.number().min(0).default(0) }).parse(req.query);
    return { items: await ops.listAudit(q.limit, q.offset) };
  });

  // ---------------------------------------------------------------- dashboard + usage
  const range = (q: { from?: string; to?: string }) => {
    const to = q.to ?? localDate(now(), "Asia/Bangkok");
    const from = q.from ?? localDate(new Date(now().getTime() - 6 * 86_400_000), "Asia/Bangkok");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new KbError("from/to phải dạng YYYY-MM-DD");
    return { from, to };
  };

  app.get("/api/dashboard", async (req) => {
    const { from, to } = range(req.query as { from?: string; to?: string });
    const [d, jobs, dead, outbox, cron, weekly] = await Promise.all([ops.dashboard(from, to), ops.jobStats(), ops.deadJobs(10), ops.outboxStats(), ops.listCron(), ops.listWeeklyStats(8)]);
    const total = d.byKind.reduce((s, x) => s + x.n, 0);
    const noLlm = d.byTier.filter((t) => t.tier <= 1).reduce((s, x) => s + x.n, 0);
    const esc = d.byKind.find((k) => k.kind === "ESCALATE")?.n ?? 0;
    return { range: { from, to }, ...d, rates: { decisions: total, zeroLlmRate: total ? noLlm / total : null, escalateRate: total ? esc / total : null }, health: { jobs, dead, outbox, cron, kbVersion: live.version, llmConfigured: !!svc.llm }, weekly };
  });

  const usageData = async (q: { from?: string; to?: string }) => {
    const { from, to } = range(q);
    const perDay = await ops.usageByDay(from, to);
    const distinct = await svc.db.query<{ n: number }>("SELECT count(DISTINCT user_id)::int AS n FROM llm_calls WHERE user_id IS NOT NULL AND (created_at AT TIME ZONE 'Asia/Bangkok')::date BETWEEN $1::date AND $2::date", [from, to]);
    const totals = perDay.reduce((t, d) => ({ requests: t.requests + d.requests, input: t.input + d.input, output: t.output + d.output, cacheRead: t.cacheRead + d.cacheRead, cacheWrite: t.cacheWrite + d.cacheWrite, totalTokens: t.totalTokens + d.totalTokens, cost: t.cost + d.cost }), { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
    return { range: { from, to }, totals: { ...totals, uniqueUsers: Number(distinct.rows[0]?.n ?? 0) }, perDay, topUsers: await ops.usageTopUsers(from, to, 20), hourly: from === to ? await ops.usageHourly(from) : null };
  };

  app.get("/api/usage", async (req) => {
    const u = await usageData(req.query as { from?: string; to?: string });
    if (req.admin!.role !== "viewer") return u;
    // viewer không được thấy định danh khách: che ID, bỏ tên và username
    return { ...u, topUsers: u.topUsers.map((t) => ({ ...t, userId: maskId(t.userId), name: null, username: null })) };
  });

  app.get("/api/usage/export", { preHandler: need("admin") }, async (req, reply) => {
    const q = req.query as { from?: string; to?: string; format?: string };
    const u = await usageData(q);
    if (q.format === "md") {
      const md = [`# Usage Report — ${u.range.from} → ${u.range.to}`, `> Generated: ${now().toISOString()}`, "", "| Date | Users | Req | Input | Output | Cache | Total | Cost |", "|---|---|---|---|---|---|---|---|", ...u.perDay.map((d) => `| ${d.day} | ${d.uniqueUsers} | ${d.requests} | ${d.input} | ${d.output} | ${d.cacheRead + d.cacheWrite} | ${d.totalTokens} | $${d.cost.toFixed(4)} |`)].join("\n");
      return reply.header("content-type", "text/markdown; charset=utf-8").header("content-disposition", `attachment; filename="usage-report-${u.range.to}.md"`).send(md);
    }
    const csv = ["date,users,requests,input_tokens,output_tokens,cache_read,cache_write,total_tokens,cost_usd", ...u.perDay.map((d) => [d.day, d.uniqueUsers, d.requests, d.input, d.output, d.cacheRead, d.cacheWrite, d.totalTokens, d.cost].join(","))].join("\n");
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="usage-daily-${u.range.to}.csv"`).send(csv);
  });

  // ---------------------------------------------------------------- bộ câu hỏi mẫu
  app.get("/api/eval/cases", async () => ({ items: await kb.listEvalCases() }));
  app.post("/api/eval/cases", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ question: z.string().min(2).max(500), expected: z.string().nullable(), image_type: z.string().nullable().optional() }).parse(req.body);
    const id = await kb.addEvalCase({ question: b.question, expected: b.expected, imageType: b.image_type ?? null, source: "admin" });
    await audit(req, "eval.add", String(id), null, b);
    return { id };
  });
  app.delete("/api/eval/cases/:id", { preHandler: need("admin") }, async (req) => {
    await kb.deleteEvalCase(z.coerce.number().parse((req.params as { id: string }).id));
    return { ok: true };
  });
  app.post("/api/eval/run", async () => {
    const cases = await kb.listEvalCases();
    const r = await runEval(cases, live.index, live.evaluator, evalSettings(live.urlHosts));
    return { total: r.total, correct: r.correct, accuracy: r.total ? r.correct / r.total : null, failures: r.rows.filter((x) => !x.ok).slice(0, 100) };
  });

  // ---------------------------------------------------------------- ảnh khách gửi (chỉ admin+)
  app.get("/api/media", { preHandler: need("admin") }, async (req, reply) => {
    const ref = z.object({ ref: z.string().max(200) }).parse(req.query).ref;
    const f = svc.media.read(ref);
    if (!f) return reply.code(404).send({ error: "không có ảnh (đã hết hạn lưu?)" });
    return reply.header("content-type", f.mime).header("content-disposition", "inline").send(f.data);
  });

  // ---------------------------------------------------------------- broadcast (owner, có xác nhận số người nhận)
  app.get("/api/broadcasts", { preHandler: need("owner") }, async () => ({ items: await ops.listBroadcasts() }));
  app.post("/api/broadcasts", { preHandler: need("owner") }, async (req) => {
    const b = z.object({ text: z.string().min(1).max(3500) }).parse(req.body);
    const total = (await conv.allUserIds()).length;
    const id = await ops.createBroadcast(req.admin!.id, b.text, total);
    await audit(req, "broadcast.draft", String(id), null, { total });
    return { id, total, status: "draft" };
  });
  app.post("/api/broadcasts/:id/send", { preHandler: need("owner") }, async (req) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const b = z.object({ confirmTotal: z.coerce.number() }).parse(req.body);
    const bc = await ops.getBroadcast(id);
    if (!bc || bc.status !== "draft") throw new KbError("thông báo không ở trạng thái nháp", 404);
    if (Number(bc.total) !== b.confirmTotal) throw new KbError("số người nhận xác nhận không khớp");
    await ops.updateBroadcast(id, { status: "sending" });
    await ops.enqueueJob("broadcast-send", { broadcastId: id, offset: 0 }, { dedupeKey: `bc:${id}:0` });
    await audit(req, "broadcast.send", String(id), null, { total: bc.total });
    return { ok: true };
  });

  // ---------------------------------------------------------------- sức khoẻ
  app.get("/healthz", async () => ({ ok: true, service: "admin", kbVersion: live.version }));

  // ---------------------------------------------------------------- giao diện web tĩnh
  await app.register(fastifyStatic, { root: resolve(opt.webDir ?? webDirDefault()), prefix: "/" });
  return app;
}
