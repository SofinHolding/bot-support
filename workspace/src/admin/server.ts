/** Admin API + phục vụ giao diện web tĩnh. */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import { readReviewWorkbook } from "../kb/review-xlsx";
import { FOLLOW_UP_KINDS } from "../core/templates";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../app";
import type { PredicateMap } from "../core/predicates";
import { checkOutput, TELEGRAM_MAX_CHARS } from "../core/gate";
import { validateSetting, DEFAULT_SETTINGS } from "../core/settings";
import { sameProtectedSet } from "../core/translate";
import type { AdminRole } from "../db/repo-ops";
import { evalSettings, outcomeKey, runEval } from "../kb/eval";
import { HttpEmbedder, SelectedEmbedder } from "../llm/embedder";
import { parseSkill, SKILL_NAMES, type SkillName } from "../llm/skills";
import { routeHybrid, type RouterSettings } from "../core/router";
import { detectLanguage } from "../core/language";
import { normalize } from "../core/text";
import { usableLlm, type OverlapSide } from "../core/ports";
import { activeEmbedder, cosine } from "../core/embedding";
import { containsPhrase } from "../core/text";
import { DEFAULT_OVERLAP_MIN, scanCorpus } from "../kb/overlap";
import { CONFUSION_FIX_HINT, confusionsOf, describeConfusion, findConfusions } from "../kb/routing-check";
import { intakeToItems, renderIntakeMarkdown } from "../kb/intake";
import { NEEDS_DECISION } from "../kb/overlap";
import { chunkKey, itemKey, templateHash, textHash, UNCHECKED_VERDICT } from "../kb/pair-decisions";
import { extractText, MAX_UPLOAD_BYTES } from "../kb/doc-extract";
import { GUIDE_SLUG } from "../core/guide";
import { GatewayConfigError, listGatewayModels, runningInDocker, testGateway } from "../llm/gateway-config";
import { KbError, type Actor } from "../kb/service";
import { localDate } from "../worker/schedule";
import { registerVaultRoutes } from "./vault-routes";

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
  // Kéo-thả tệp vào trợ lý "Nạp nội dung mới" (.txt/.pdf/.doc/.docx/.xlsx): giới hạn RIÊNG cao hơn bodyLimit chung ở trên,
  // chỉ áp dụng cho route đọc tệp (xem MAX_UPLOAD_BYTES, kb/doc-extract.ts) — không nới giới hạn cho các route JSON khác.
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

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
    return { episode: { ...ep, user_id: viewerMask(req, ep.user_id) }, parent, user: user ? { ...user, telegram_id: viewerMask(req, user.telegram_id), username: viewer ? null : user.username, name: viewer ? null : user.name } : null, tickets: (tickets.rows as { user_id: number }[]).map((t) => ({ ...t, user_id: viewerMask(req, Number(t.user_id)) })), ...detail };
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
    const q = z.object({ status: z.string().optional(), ref: z.string().max(20).optional(), limit: z.coerce.number().min(1).max(100).default(30), offset: z.coerce.number().min(0).default(0) }).parse(req.query);
    const rows = await conv.listTickets({ status: q.status || undefined, ref: q.ref || undefined, limit: q.limit, offset: q.offset });
    const viewer = req.admin!.role === "viewer";
    return { items: rows.map((t) => ({ ...t, user_id: viewerMask(req, t.user_id), user_name: viewer ? null : t.user_name, user_username: viewer ? null : t.user_username })) };
  });

  app.patch("/api/tickets/:id", { preHandler: need("admin") }, async (req) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const { notes_base: notesBase, ...body } = z.object({ status: z.enum(["open", "in_progress", "closed"]).optional(), pic: z.string().max(80).nullable().optional(), notes: z.string().max(4000).nullable().optional(), notes_base: z.string().nullable().optional() }).parse(req.body);
    const cur = (await svc.db.query<{ status: string; pic: string | null; notes: string | null }>("SELECT status, pic, notes FROM tickets WHERE id = $1", [id])).rows[0];
    if (!cur) throw new KbError("không tìm thấy ticket", 404);
    // Bot nối "khách hỏi lại..." vào ghi chú trong lúc admin đang soạn: không cho bản cũ ghi đè làm mất lịch sử.
    if (body.notes !== undefined && notesBase !== undefined && (notesBase ?? "") !== (cur.notes ?? "")) throw new KbError("Ghi chú của ticket vừa có nội dung mới (khách nhắn lại hoặc người khác vừa sửa). Tải lại trang rồi sửa tiếp để không mất nội dung đó.", 409);
    await conv.updateTicket(id, body); // trường có mặt trong body (kể cả null) được ghi; trường vắng mặt giữ nguyên
    await audit(req, "ticket.update", `ticket:${id}`, Object.fromEntries(Object.keys(body).map((k) => [k, (cur as Record<string, unknown>)[k] ?? null])), body);
    return { ok: true };
  });

  // ---------------------------------------------------------------- kho tri thức
  app.get("/api/kb/documents", async () => {
    const [items, conflicts] = await Promise.all([kb.listDocuments(), kb.listOpenConflictCounts()]);
    return {
      items: items.map((d) => {
        const c = conflicts.get(d.slug);
        return c ? { ...d, conflicts: c.count, conflictHint: `Xung đột với "${c.topOtherTitle}" (${c.topOtherDoc}, ${c.topScore.toFixed(2)}) — bấm để xem chi tiết` } : { ...d, conflicts: 0, conflictHint: null };
      }),
      kbVersion: live.version,
    };
  });

  /**
   * Xung đột ĐANG MỞ chạm tới một tài liệu (đã chốt lúc publish, xem kb/service.ts syncConflictsAfterPublish). Dùng cho
   * thẻ "Xung đột nội dung" trên trang chi tiết tài liệu — không phải quét tạm thời như /api/kb/overlap.
   */
  app.get("/api/kb/conflicts", async (req) => {
    const q = z.object({ doc: z.string().min(1).max(200) }).parse(req.query ?? {});
    return { items: await kb.listConflicts(q.doc) };
  });

  /**
   * "Gỡ máy móc": xoá đúng một cụm khớp (đã biết chính xác từ tín hiệu code, xem kb/overlap.ts narrowTemplateMatch) khỏi
   * một template, tạo BẢN NHÁP mới — KHÔNG tự publish. Admin vẫn phải vào tài liệu, xem lại rồi bấm Publish (và một quản
   * trị viên khác duyệt nếu nội dung cần) như quy trình hiện có; đây chỉ là điền sẵn bản sửa cho admin, không bỏ qua kiểm duyệt.
   */
  app.post("/api/kb/conflicts/apply", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ templateId: z.string().min(1).max(200), phrase: z.string().min(1).max(300) }).parse(req.body);
    const { version } = await kbService.applyNarrow(b.templateId, b.phrase, actor(req));
    await audit(req, "kb.conflict_apply_narrow", b.templateId, null, { phrase: b.phrase, draftVersion: version.id });
    return { versionId: version.id, slug: version.slug };
  });

  app.get("/api/kb/documents/:slug", async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const doc = await kb.getDocument(slug);
    if (!doc) return reply.code(404).send({ error: "không tìm thấy" });
    return { document: doc, versions: (await kb.listVersions(slug)).map((v) => ({ ...v, source_md: undefined })) };
  });

  app.get("/api/kb/versions/:id", { preHandler: need("admin") }, async (req, reply) => {
    const v = await kb.getVersion(z.coerce.number().parse((req.params as { id: string }).id));
    if (!v) return reply.code(404).send({ error: "không tìm thấy" });
    const doc = await kb.getDocument(v.slug);
    return { version: v, units: doc ? await kbService.versionUnits(v, doc.kind) : [] };
  });

  app.post("/api/kb/documents", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ slug: z.string().min(2).max(80), kind: z.enum(["templates", "knowledge", "guide", "items"]), title: z.string().max(200).optional(), md: z.string().min(10).max(1_000_000) }).parse(req.body);
    // Nội dung tri thức chỉ vào qua "Thêm nội dung" (hệ thống tự phân tích); soạn thẳng chỉ còn cho Hướng dẫn AI làm việc
    if (b.kind !== "guide") throw new KbError('Nội dung tri thức chỉ thêm qua "Thêm nội dung" ở Kho tri thức — hệ thống tự phân tích, không soạn cấu trúc bằng tay', 403);
    const r = await kbService.createDraft({ slug: b.slug, kind: b.kind, title: b.title, md: b.md, author: actor(req) });
    await audit(req, "kb.create_draft", b.slug, null, { version: r.version.version, ok: r.report.ok });
    return { version: { ...r.version, source_md: undefined }, report: r.report };
  });

  app.put("/api/kb/versions/:id", { preHandler: need("admin") }, async (req) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const b = z.object({ md: z.string().min(10).max(1_000_000) }).parse(req.body);
    const v0 = await kb.getVersion(id);
    if (v0 && (await kb.getDocument(v0.slug))?.kind !== "guide") throw new KbError('Nội dung tri thức chỉ sửa qua "Thêm nội dung" (dán nội dung mới) — hệ thống tự phân tích', 403);
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

  /** Chỉ xoá được tài liệu CHƯA TỪNG publish (vd tạo nhầm loại) — kb/service.ts tự chặn nếu đã từng chạy thật. */
  app.delete("/api/kb/documents/:slug", { preHandler: need("admin") }, async (req) => {
    const slug = (req.params as { slug: string }).slug;
    await kbService.deleteDocument(slug, actor(req));
    return { ok: true };
  });

  // ---------------------------------------------------------------- Kho tri thức: một danh sách, một cửa thêm nội dung
  /** Mọi nội dung bot đang dùng (câu trả lời theo chủ đề, đoạn tài liệu theo tài liệu) + bản nháp đang chờ xử lý. */
  app.get("/api/kb/content", async () => kbService.listContent());
  /** Lịch sử theo từng phần của một nội dung: phần nào đổi khi nào, ai đổi, trước/sau. */
  app.get("/api/kb/history", async (req) => kbService.unitHistory(z.object({ key: z.string().min(3).max(400) }).parse(req.query).key));

  /** "Thử hỏi bot": câu này bot trả lời bằng mục nào (bộ đang chạy, hoặc sau khi đưa bản nháp lên). Không gọi AI. */
  app.post("/api/kb/try", async (req) => {
    const b = z.object({ question: z.string().trim().min(1).max(500), versionId: z.number().int().positive().optional() }).parse(req.body);
    return kbService.tryQuestion(b.question, b.versionId);
  });

  /** Người duyệt xác nhận nội dung mới thay thế nội dung đang dùng: ghi quan hệ + tạo bản nháp bỏ nội dung cũ (không publish). */
  app.post("/api/kb/supersede", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ newKey: z.string().min(3).max(400), oldKey: z.string().min(3).max(400), note: z.string().max(1000).optional() }).parse(req.body);
    const { version, report } = await kbService.supersede(b, actor(req));
    await audit(req, "kb.supersede", b.oldKey, null, { newKey: b.newKey, draftVersion: version.id });
    return { versionId: version.id, slug: version.slug, ok: report.ok };
  });

  /** Ghi nhận "giữ nguyên có chủ ý" cho cặp mục hỏi đáp ↔ đoạn tài liệu mà bước kiểm tra chặn, rồi kiểm tra lại bản nháp. */
  app.post("/api/kb/decide", { preHandler: need("admin") }, async (req) => {
    const b = z
      .union([
        z.object({ versionId: z.number().int().positive(), itemId: z.string().max(120), chunkId: z.string().max(40), note: z.string().max(1000).optional() }),
        // cặp AI đã chặn (trùng / xung đột / mâu thuẫn): giữ cả hai vì là hai trường hợp khác nhau, hoặc đã sửa cho thống nhất
        z.object({ versionId: z.number().int().positive().optional(), docSlug: z.string().max(200).optional(), aKey: z.string().min(3).max(400), bKey: z.string().min(3).max(400), decision: z.enum(["keep_both", "fixed"]), note: z.string().max(1000).optional() }),
      ])
      .parse(req.body);
    if ("aKey" in b) {
      // khung xung đột chỉ biết tài liệu của nội dung mới: dùng bản mới nhất (bản nháp) của tài liệu đó
      const versionId = b.versionId ?? (b.docSlug ? (await kb.listVersions(b.docSlug))[0]?.id : undefined);
      if (!versionId) throw new KbError("thiếu bản nháp cần quyết", 400);
      const report = await kbService.decidePair({ ...b, versionId }, actor(req));
      await audit(req, "kb.pair_decision", `${b.aKey}|${b.bKey}`, null, { decision: b.decision, note: b.note ?? null });
      return { report };
    }
    const report = await kbService.decideItemChunk({ ...b, decision: "keep_both" }, actor(req));
    await audit(req, "kb.pair_decision", `${b.itemId}|chunk:${b.chunkId}`, null, { decision: "keep_both", note: b.note ?? null });
    return { report };
  });

  /** AI kiểm tra lại các cặp của bản nháp mà nội dung đã đổi (hoặc lần trước AI không kiểm tra được), rồi kiểm tra lại bản nháp. */
  app.post("/api/kb/recheck-conflicts", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ versionId: z.number().int().positive() }).parse(req.body);
    const report = await kbService.recheckPairs(b.versionId, svc.llm);
    await audit(req, "kb.recheck_conflicts", String(b.versionId), null, { ok: report.ok });
    return { report };
  });

  /** Nhập file rà soát khách hàng trả về (.xlsx): áp quyết định thành bản nháp của các chủ đề. Không publish. */
  app.post("/api/kb/import-review", { preHandler: need("admin") }, async (req) => {
    const file = await req.file();
    if (!file) throw new KbError("thiếu tệp");
    if (!/\.xlsx$/i.test(file.filename)) throw new KbError("chỉ nhận tệp .xlsx (file rà soát nội dung)");
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new KbError(`tệp vượt quá ${Math.round(MAX_UPLOAD_BYTES / 1_000_000)} MB`, 413);
    let read;
    try {
      read = await readReviewWorkbook(buf);
    } catch (e) {
      throw new KbError(`không đọc được tệp Excel: ${(e as Error).message}`, 422);
    }
    const r = await kbService.applyReviewToDrafts(read.input, actor(req));
    await audit(req, "kb.import_review", file.filename, null, { drafts: r.drafts, applied: r.applied.length, decisions: r.decisionsSaved });
    return { ...r, todo: [...read.unknown, ...r.todo] };
  });

  /**
   * evalCount/conflicts: để admin đọc ngay trên một dòng "template này có đang được bảo vệ bằng câu kiểm tra không,
   * có đang dễ bị nhầm với template/tài liệu nào không" — không phải tự nhớ ID rồi mở tab khác tra lại.
   */
  app.get("/api/templates", async () => {
    const [rows, cases, conflicts] = await Promise.all([kb.loadPublishedTemplateRows(), kb.listEvalCases(), kb.listAllConflicts()]);
    const evalCountById = new Map<string, number>();
    for (const c of cases) if (c.expected_template_id) evalCountById.set(c.expected_template_id, (evalCountById.get(c.expected_template_id) ?? 0) + 1);
    const conflictsById = new Map<string, { withTitle: string; score: number }[]>();
    for (const c of conflicts) {
      for (const [side, other] of [[c.a, c.b] as const, [c.b, c.a] as const]) {
        if (side.kind !== "template") continue;
        const list = conflictsById.get(side.id) ?? [];
        list.push({ withTitle: other.title, score: c.score });
        conflictsById.set(side.id, list);
      }
    }
    return {
      docs: Object.fromEntries(rows.map((r) => [r.template.id, r.docSlug])),
      items: live.index.templates.map((t) => ({
        id: t.id,
        group: t.group,
        response_mode: t.response_mode,
        priority: t.priority,
        langs: Object.keys(t.answers),
        keywords: t.match.keywords.length,
        examples: t.match.examples.slice(0, 3),
        keyword_list: t.match.keywords.slice(0, 8),
        ticket: t.ticket ?? null,
        // hiện NGUYÊN VĂN câu bot gửi, kể cả khi template dùng chung câu trả lời của template khác (answer_from) — người đọc không phải tra id
        answer_en: (live.index.resolveAnswerSource(t).answers.en ?? "").replace("{SUPPORT_SUMMARY}", "").slice(0, 240),
        evalCount: evalCountById.get(t.id) ?? 0,
        conflicts: conflictsById.get(t.id) ?? [],
      })),
      kbVersion: live.version,
    };
  });

  /**
   * Tìm xuyên suốt kho tri thức đang chạy: tài liệu (slug/tiêu đề), đoạn tri thức đang publish (tiêu đề/nội dung), template
   * (id/nhóm/từ khoá/câu mẫu/câu trả lời EN). Trả về mục nào cũng kèm `docSlug` để mở đúng tài liệu chứa nó — trả lời câu
   * "cái này nằm trong file nào" mà admin phải tự nhớ trước đây. Không phân biệt hoa/thường, không phân biệt dấu tiếng Việt.
   */
  app.get("/api/kb/search", async (req) => {
    const q = z.object({ q: z.string().min(1).max(200) }).parse(req.query ?? {});
    const needle = normalize(q.q);
    if (needle.length < 2) return { items: [] }; // 1 ký tự khớp quá nhiều thứ để có ích
    const docs = await kb.listDocuments();
    const docHits = docs
      .filter((d) => normalize(d.slug).includes(needle) || normalize(d.title).includes(needle))
      .map((d) => ({ type: "doc" as const, docSlug: d.slug, title: d.title, snippet: d.kind === "templates" ? "tài liệu template" : d.kind === "guide" ? "hướng dẫn AI làm việc" : "tài liệu tri thức" }));
    const chunks = await kb.listPublishedChunks();
    const chunkHits = chunks
      .filter((c) => normalize(c.heading).includes(needle) || normalize(c.text).includes(needle))
      .slice(0, 30)
      .map((c) => ({ type: "chunk" as const, docSlug: c.docSlug, title: c.heading, snippet: c.text.slice(0, 160) }));
    const rows = await kb.loadPublishedTemplateRows();
    const docOf = new Map(rows.map((r) => [r.template.id, r.docSlug]));
    const tplHits = live.index.templates
      .filter((t) => normalize([t.id, t.group, ...t.match.keywords, ...t.match.examples, t.answers.en ?? ""].join(" ")).includes(needle))
      .slice(0, 30)
      .map((t) => ({
        type: "template" as const,
        docSlug: docOf.get(t.id) ?? "",
        id: t.id,
        title: `${t.group} — ${t.id}`,
        snippet: [...t.match.keywords, ...t.match.examples].find((k) => normalize(k).includes(needle)) ?? (t.answers.en ?? "").slice(0, 160),
      }));
    // template trước (thường là cái admin đang tìm theo id/từ khoá), rồi đoạn tri thức, rồi tài liệu
    return { items: [...tplHits, ...chunkHits, ...docHits].slice(0, 60) };
  });

  // ---- Chồng lấn nội dung: code cờ cặp (dùng chính bộ tìm kiếm lúc chạy thật) -> AI phán xét từng cặp -> admin quyết ----
  /** Quét toàn kho đang publish. `min`: ngưỡng điểm (cấu hình đề xuất DEFAULT_OVERLAP_MIN, cần hiệu chỉnh theo dữ liệu). Không gọi LLM. */
  app.get("/api/kb/overlap", { preHandler: need("admin") }, async (req) => {
    const q = z.object({ min: z.coerce.number().min(0.2).max(0.99).optional(), max: z.coerce.number().int().min(10).max(2000).optional() }).parse(req.query ?? {});
    const rows = await kb.loadPublishedTemplateRows();
    const docOf = new Map(rows.map((r) => [r.template.id, r.docSlug]));
    const raw = await scanCorpus({ index: live.index, kb, embedder: svc.embedder, docOf }, { minScore: q.min, maxPairs: q.max ?? 300 });
    // HỎI THỬ bot trên toàn bộ template + các đoạn tri thức có mặt trong danh sách: chỉ cặp bot trả lời nhầm thật mới là vấn đề
    const chunks = [...new Map(raw.flatMap((p) => [p.a, p.b]).filter((r) => r.kind === "chunk").map((r) => [r.id, { ref: r, heading: r.title }])).values()];
    const confusions = await findConfusions(live.index, live.evaluator, svc.embedder, evalSettings(live.urlHosts), { docOf, chunks });
    const titleOf = (id: string) => live.index.get(id)?.sets_context.issue ?? id;
    const pairs = raw
      .map((p) => {
        const cs = confusionsOf(p, confusions);
        return { ...p, confusions: cs, confirmed: cs.length > 0 || !!p.updateHint, explain: cs.slice(0, 3).map((c) => describeConfusion(c, titleOf)) };
      })
      .sort((x, y) => Number(y.confirmed) - Number(x.confirmed) || y.score - x.score);
    return { pairs, confirmed: pairs.filter((p) => p.confirmed).length, min: q.min ?? DEFAULT_OVERLAP_MIN, max: q.max ?? 300, kbVersion: live.version, model: (await activeEmbedder(svc.embedder)).version, fixHint: CONFUSION_FIX_HINT };
  });
  /** Tính lại danh sách xung đột đã ghi của mọi tài liệu theo cách kiểm tra hiện tại (hỏi thử bot). Không đổi nội dung nào. */
  app.post("/api/kb/conflicts/resync", { preHandler: need("admin") }, async (req) => {
    const r = await kbService.resyncAllConflicts();
    await audit(req, "kb.conflicts_resync", "kb_conflicts", null, r);
    return r;
  });
  /** AI phán xét từng cặp bị cờ (SKILL review-overlap): mỗi lời gọi đúng hai mục, tối đa 20 cặp một lần. */
  app.post("/api/kb/overlap/review", { preHandler: need("admin") }, async (req) => {
    const ref = z.object({ kind: z.enum(["template", "chunk"]), id: z.string().max(200) });
    const b = z.object({ pairs: z.array(z.object({ a: ref, b: ref, signals: z.array(z.string().max(300)).max(10).optional() })).min(1).max(20) }).parse(req.body);
    const llm = usableLlm(svc.llm);
    if (!llm) throw new KbError("chưa cấu hình LLM");
    const rows = await kb.loadPublishedTemplateRows();
    const docOf = new Map(rows.map((r) => [r.template.id, r.docSlug]));
    const chunks = await kb.listPublishedChunks();
    const side = (r: { kind: "template" | "chunk"; id: string }): OverlapSide | null => {
      if (r.kind === "template") {
        const t = live.index.get(r.id);
        return t ? { kind: "template", id: t.id, doc: docOf.get(t.id) ?? "", title: `${t.group} — ${t.sets_context.issue ?? t.id}`, keywords: t.match.keywords, examples: t.match.examples, text: live.index.resolveAnswerSource(t).answers.en ?? "" } : null;
      }
      const c = chunks.find((x) => x.chunkId === r.id);
      return c ? { kind: "chunk", id: c.chunkId, doc: c.docSlug, title: c.heading, keywords: [], examples: [], text: c.text } : null;
    };
    const results: { a: { kind: string; id: string }; b: { kind: string; id: string }; review?: Awaited<ReturnType<typeof llm.reviewOverlap>>; error?: string }[] = [];
    for (const p of b.pairs) {
      const a = side(p.a);
      const bb = side(p.b);
      if (!a || !bb) {
        results.push({ a: p.a, b: p.b, error: "không còn trong kho" });
        continue;
      }
      try {
        results.push({ a: p.a, b: p.b, review: await llm.reviewOverlap({ a, b: bb, signals: p.signals ?? [] }) });
      } catch (e) {
        results.push({ a: p.a, b: p.b, error: (e as Error).message.slice(0, 200) });
      }
    }
    await audit(req, "kb.overlap_review", "kb", null, { pairs: b.pairs.length });
    return { results };
  });

  // ---- Luồng nạp mới: tải file -> raw-data/ -> vault Obsidian -> xung đột -> vector (docs/adr/0005) ----
  registerVaultRoutes(app, svc, { need, actor, audit, now });

  // ---- Trợ lý "Nạp nội dung mới": văn bản tự do -> loại + cấu trúc (SKILL intake-draft) -> bản nháp thật + khung xung đột ----
  /**
   * Dán văn bản tự do -> AI đoán loại + tách trường có cấu trúc (không phải Markdown thô) -> code render Markdown đúng cú
   * pháp -> tạo NGAY một bản nháp thật (tận dụng đủ 6 bước kiểm tra sẵn có). Với vài cặp chồng lấn điểm cao nhất mà bước 3
   * vừa tính (report.overlapPairs), hỏi AI mô tả ngay (SKILL review-overlap) để trả kèm — người dùng thấy khung xung đột
   * kèm gợi ý ngay, không cần bấm thêm. Không bao giờ tạo được tài liệu "Hướng dẫn AI làm việc" (chặn cả ở schema lẫn ở đây).
   */
  /**
   * Dựng các "khung xung đột" (kèm mô tả + gợi ý của AI, SKILL review-overlap) cho MỘT bản nháp intake, từ `overlapPairs`
   * mà bước 3 đã tính (lưu trong report của version). Dùng chung cho lúc vừa tạo bản nháp lẫn khi mở lại trang sau đó —
   * chỉ MỘT chỗ dựng OverlapSide cho phía "a" (chính nội dung bản nháp, chưa publish nên không dò qua live.index/kb được
   * như `/api/kb/overlap/review` làm cho cả hai phía).
   */
  async function buildIntakeBoxes(llm: NonNullable<ReturnType<typeof usableLlm>>, kind: "templates" | "knowledge" | "items", slug: string, md: string, overlapPairs: import("../kb/overlap").OverlapPair[]) {
    const parsedDraft = kbService.parse(kind, md, slug);
    const rows = await kb.loadPublishedTemplateRows();
    const docOf = new Map(rows.map((r) => [r.template.id, r.docSlug]));
    const liveChunks = await kb.listPublishedChunks();
    const draftSide = (id: string): OverlapSide | null => {
      if (kind !== "knowledge") {
        const t = parsedDraft.templates.find((x) => x.id === id);
        return t ? { kind: "template", id: t.id, doc: slug, title: `${t.group} — ${t.id}`, keywords: t.match.keywords, examples: t.match.examples, text: t.answers.en ?? "" } : null;
      }
      const i = parsedDraft.chunks.findIndex((_c, idx) => `${slug}#${idx}` === id);
      const c = parsedDraft.chunks[i];
      return c ? { kind: "chunk", id, doc: slug, title: c.heading, keywords: [], examples: [], text: c.text } : null;
    };
    const liveSide = (k: "template" | "chunk", id: string): OverlapSide | null => {
      if (k === "template") {
        const t = live.index.get(id);
        return t ? { kind: "template", id: t.id, doc: docOf.get(t.id) ?? "", title: `${t.group} — ${t.sets_context.issue ?? t.id}`, keywords: t.match.keywords, examples: t.match.examples, text: live.index.resolveAnswerSource(t).answers.en ?? "" } : null;
      }
      const c = liveChunks.find((x) => x.chunkId === id);
      return c ? { kind: "chunk", id: c.chunkId, doc: c.docSlug, title: c.heading, keywords: [], examples: [], text: c.text } : null;
    };
    // Cụm gỡ máy móc có thể trỏ về CHÍNH template trong bản nháp vừa tạo (chưa publish) khi tín hiệu mạnh nhất là ví dụ của
    // chính nó — không dùng được với applyNarrow/applyBoxEdit (chỉ sửa tài liệu ĐÃ publish): khung vẫn hiện đủ tín hiệu +
    // gợi ý AI, chỉ ẩn narrow để không có nút "Áp dụng" trỏ sai chỗ; admin sửa trực tiếp trong ô nội dung mới của mình.
    const ownTemplateIds = new Set(kind !== "knowledge" ? parsedDraft.templates.map((t) => t.id) : []);
    const isDraft = (r: { kind: string; id: string }) => (r.kind === "template" ? ownTemplateIds.has(r.id) : r.id.startsWith(`${slug}#`));
    // Khung chỉ dành cho VẤN ĐỀ THẬT: chỗ hỏi thử thấy bot trả lời nhầm (routing-check) hoặc đoạn trùng nguyên văn — luôn hiện;
    // thêm vài cặp giống chữ điểm cao để AI soi xem nội dung có MÂU THUẪN / TRÙNG hẳn không (bot chọn đúng vẫn có thể nói sai).
    const confirmed = (p: (typeof overlapPairs)[number]) => !!p.confusions?.length || !!p.updateHint;
    const pairs = [...overlapPairs.filter(confirmed), ...overlapPairs.filter((p) => !confirmed(p))]
      .map((p) => (isDraft(p.a) || !isDraft(p.b) ? p : { ...p, a: p.b, b: p.a })) // bên nội dung mới luôn là `a`, bên đang dùng là `b` (để sửa)
      .slice(0, 8);
    const titleOf = (id: string) => live.index.get(id)?.sets_context.issue ?? parsedDraft.templates.find((t) => t.id === id)?.sets_context.issue ?? id;
    // Khoá + nội dung lúc kiểm tra của mỗi bên: nhận xét của AI được ghi lại (kb_pair_reviews) và là căn cứ chặn publish
    const unitOf = (r: { kind: string; id: string }, draft: boolean): { key: string; hash: string; title: string } | undefined => {
      if (r.kind === "template") {
        const t = draft ? parsedDraft.templates.find((x) => x.id === r.id) : live.index.get(r.id);
        return t ? { key: itemKey(t.id), hash: templateHash(t), title: t.item?.title ?? t.sets_context.issue ?? t.id } : undefined;
      }
      if (draft) {
        const c = parsedDraft.chunks.find((_c, idx) => `${slug}#${idx}` === r.id);
        return c ? { key: chunkKey(slug, c.heading), hash: textHash(c.text), title: c.heading } : undefined;
      }
      const c = liveChunks.find((x) => x.chunkId === r.id);
      return c ? { key: chunkKey(c.docSlug, c.heading), hash: textHash(c.text), title: c.heading } : undefined;
    };
    const boxes: { a: OverlapSide | { kind: string; id: string; doc: string; title: string }; b: OverlapSide | { kind: string; id: string; doc: string; title: string }; score: number; signals: string[]; explain: string[]; narrow: { templateId: string; phrase: string } | null; updateHint?: string; verdict: string | null; reason: string | null; suggestion: string | null; aKey: string | null; bKey: string | null }[] = [];
    for (const p of pairs) {
      const a = draftSide(p.a.id) ?? p.a;
      const bSide = liveSide(p.b.kind, p.b.id) ?? p.b;
      const narrow = p.narrow && !ownTemplateIds.has(p.narrow.templateId) ? p.narrow : null;
      const explain = (p.confusions ?? []).slice(0, 3).map((c) => describeConfusion(c, titleOf, "sẽ"));
      let verdict: string | null = null;
      let reason: string | null = null;
      let suggestion: string | null = null;
      const ua = unitOf(p.a, isDraft(p.a));
      const ub = unitOf(p.b, isDraft(p.b));
      // Cùng nội dung hai bên đã được AI kiểm tra: dùng lại nhận xét, không gọi AI lần nữa
      const cached = ua && ub ? await kbService.cachedPairReview(ua, ub) : undefined;
      if (cached && cached.verdict !== UNCHECKED_VERDICT) {
        verdict = cached.verdict;
        reason = cached.reason;
        suggestion = cached.suggestion;
      } else {
        try {
          const v = await llm.reviewOverlap({ a: a as OverlapSide, b: bSide as OverlapSide, signals: p.signals.slice(0, 5) });
          verdict = v.verdict;
          reason = v.reason ?? null;
          suggestion = v.suggestion ?? null;
        } catch {
          verdict = UNCHECKED_VERDICT; // AI không kiểm tra được: cặp bị chặn publish tới khi kiểm tra lại được
        }
        if (ua && ub) await kbService.recordPairReview(ua, ub, { verdict, reason, suggestion });
      }
      // giống chữ, bot vẫn trả lời đúng, AI cũng không thấy mâu thuẫn/trùng => không phải việc của người dùng
      if (!confirmed(p) && !NEEDS_DECISION.has(verdict ?? "") && verdict !== UNCHECKED_VERDICT) continue;
      boxes.push({ a, b: bSide, aKey: ua?.key ?? null, bKey: ub?.key ?? null, score: p.score, signals: p.signals, explain, narrow, updateHint: p.updateHint, verdict, reason, suggestion });
    }
    return boxes;
  }

  /**
   * Trích văn bản từ một tệp kéo-thả (.txt/.pdf/.doc/.docx/.xlsx) để điền vào ô "Nội dung" của trợ lý Nạp nội dung mới —
   * KHÔNG lưu tệp lại, chỉ xử lý trong bộ nhớ rồi trả về chữ. Không tự động phân loại/tạo tài liệu ở bước này; admin xem
   * lại chữ trích ra, sửa nếu cần, rồi mới bấm "Phân tích & tạo bản nháp" như luồng dán tay bình thường.
   */
  app.post("/api/kb/intake/extract", { preHandler: need("admin") }, async (req) => {
    const file = await req.file();
    if (!file) throw new KbError("thiếu tệp");
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new KbError(`tệp vượt quá ${Math.round(MAX_UPLOAD_BYTES / 1_000_000)} MB`, 413);
    try {
      const text = await extractText(buf, file.filename, file.mimetype);
      return { text, filename: file.filename };
    } catch (e) {
      throw new KbError((e as Error).message, 422);
    }
  });

  app.post("/api/kb/intake", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ rawText: z.string().min(20).max(200_000), target: z.string().max(400).optional() }).parse(req.body);
    const llm = usableLlm(svc.llm);
    if (!llm) throw new KbError("chưa cấu hình LLM — hệ thống cần AI để phân tích nội dung");
    // Sửa một đoạn tài liệu tham khảo: nội dung mới thay đúng đoạn đó (không cần AI tách cấu trúc)
    const chunkTarget = b.target ? /^chunk:([^#]+)#(.+)$/.exec(b.target) : null;
    if (chunkTarget) {
      const { version, report } = await kbService.applyBoxEdit({ targetDoc: chunkTarget[1]!, kind: "chunk", chunkHeading: chunkTarget[2]!, newText: b.rawText }, actor(req));
      const boxes = await buildIntakeBoxes(llm, "knowledge", version.slug, version.source_md, report.overlapPairs ?? []);
      const checked = await kbService.revalidate(version.id); // nhận xét AI vừa ghi là căn cứ chặn publish
      await audit(req, "kb.intake_edit", b.target!, null, { version: version.version });
      return { version: { ...version, source_md: undefined }, report: checked, boxes, drafts: [{ versionId: version.id, slug: version.slug, ok: checked.ok }] };
    }
    const itemTarget = b.target?.startsWith("item:") ? b.target.slice(5) : undefined;
    const existingGroups = [...new Set(live.index.templates.map((t) => t.group).filter(Boolean))].sort();
    const draft = await llm.draftIntake({ rawText: b.rawText, kindHint: itemTarget ? "templates" : undefined, existingGroups });
    if (draft.slug === GUIDE_SLUG) throw new KbError(`slug "${GUIDE_SLUG}" dành riêng cho Hướng dẫn AI làm việc, không dùng được ở đây`, 400);
    if (draft.kind === "knowledge") {
      const md = renderIntakeMarkdown(draft);
      const { version, report } = await kbService.createDraft({ slug: draft.slug, kind: "knowledge", title: draft.title, md, author: actor(req) });
      const boxes = await buildIntakeBoxes(llm, "knowledge", draft.slug, md, report.overlapPairs ?? []);
      const checked = await kbService.revalidate(version.id); // nhận xét AI vừa ghi là căn cứ chặn publish
      await audit(req, "kb.intake_draft", draft.slug, null, { version: version.version, kind: "knowledge", boxes: boxes.length });
      return { version: { ...version, source_md: undefined }, report: checked, boxes, drafts: [{ versionId: version.id, slug: version.slug, ok: checked.ok }] };
    }
    // Câu trả lời: thành mục hỏi đáp trong bản nháp của đúng chủ đề (AI xếp chủ đề, người dùng không chọn)
    const res = await kbService.addIntakeItems(intakeToItems(draft), actor(req), itemTarget);
    const newIds = new Set(res.newIds);
    const boxes = [];
    const drafts = [];
    for (const d of res.drafts) {
      const v = (await kb.getVersion(d.versionId))!;
      const all = kbService.parse("items", v.source_md, v.slug).templates;
      const fresh = all.filter((t) => newIds.has(t.id) || newIds.has(t.item?.id ?? ""));
      const pairs = await kbService.relationsForNew(fresh, v.slug, all);
      await kb.updateVersion(v.id, { report: { ...d.report, overlapPairs: pairs } }); // mở lại trang vẫn thấy đúng các khung của phần mới
      boxes.push(...(await buildIntakeBoxes(llm, "items", v.slug, v.source_md, pairs)));
      const checked = await kbService.revalidate(v.id); // nhận xét AI vừa ghi là căn cứ chặn publish
      drafts.push({ versionId: v.id, slug: v.slug, ok: checked.ok, report: checked });
    }
    const first = (await kb.getVersion(res.drafts[0]!.versionId))!;
    await audit(req, "kb.intake_draft", first.slug, null, { versions: drafts.map((x) => x.versionId), kind: "items", target: b.target ?? null, boxes: boxes.length });
    return { version: { ...first, source_md: undefined }, report: drafts[0]!.report, boxes, drafts: drafts.map(({ report: _r, ...x }) => x) };
  });

  /** Dựng lại các khung xung đột của một bản nháp intake đã có — dùng khi mở lại trang (không tạo mới, không gọi LLM để phân loại lại). */
  app.get("/api/kb/intake/:versionId/boxes", { preHandler: need("admin") }, async (req, reply) => {
    const id = z.coerce.number().parse((req.params as { versionId: string }).versionId);
    const v = await kb.getVersion(id);
    if (!v) return reply.code(404).send({ error: "không tìm thấy" });
    const doc = await kb.getDocument(v.slug);
    if (!doc || doc.kind === "guide") return reply.code(404).send({ error: "không tìm thấy" });
    const llm = usableLlm(svc.llm);
    if (!llm) throw new KbError("chưa cấu hình LLM");
    const report = v.report as { overlapPairs?: import("../kb/overlap").OverlapPair[] } | null;
    const boxes = await buildIntakeBoxes(llm, doc.kind, v.slug, v.source_md, report?.overlapPairs ?? []);
    return { boxes };
  });

  /** Sạch cặp này chưa, sau khi admin sửa nội dung trong một khung xung đột — nhẹ, chỉ so cặp này, không quét lại toàn kho. */
  app.post("/api/kb/intake/conflicts/recheck", { preHandler: need("admin") }, async (req) => {
    const b = z
      .object({
        narrow: z.object({ templateId: z.string().max(200), phrase: z.string().max(300) }).nullable().optional(),
        editedText: z.string().max(20_000),
        otherText: z.string().max(20_000).optional(),
        // khung do AI kết luận trùng / xung đột / mâu thuẫn: AI đọc lại cặp (nội dung mới ↔ nội dung đang dùng đã sửa)
        review: z.object({ aTitle: z.string().max(300), bTitle: z.string().max(300), bKind: z.enum(["template", "chunk"]) }).optional(),
      })
      .parse(req.body);
    if (b.narrow) return { stillConflicting: containsPhrase(normalize(b.editedText), b.narrow.phrase) };
    if (b.review) {
      const llm = usableLlm(svc.llm);
      if (!llm) throw new KbError("chưa kết nối được AI để kiểm tra lại", 503);
      const side = (kind: "template" | "chunk", title: string, text: string): OverlapSide => ({ kind, id: title, doc: "", title, keywords: [], examples: [], text });
      try {
        const v = await llm.reviewOverlap({ a: side("template", b.review.aTitle, b.otherText ?? ""), b: side(b.review.bKind, b.review.bTitle, b.editedText), signals: [] });
        return { stillConflicting: NEEDS_DECISION.has(v.verdict), verdict: v.verdict, reason: v.reason ?? null };
      } catch (e) {
        return { stillConflicting: true, error: `AI không kiểm tra được: ${(e as Error).message.slice(0, 200)}` };
      }
    }
    if (!b.otherText) throw new KbError("thiếu otherText khi không có narrow");
    try {
      const [qa, qb] = await svc.embedder.embed([b.editedText, b.otherText]);
      const score = qa && qb ? cosine(qa, qb) : 0;
      return { stillConflicting: score >= DEFAULT_OVERLAP_MIN, score };
    } catch (e) {
      return { stillConflicting: true, error: `không kiểm tra được: ${(e as Error).message.slice(0, 200)}` }; // lỗi -> coi như còn xung đột, an toàn hơn là cho Save nhầm
    }
  });

  /** "Save" của một khung: có narrow (cụm cụ thể đã biết) -> gỡ máy móc (applyNarrow); không thì admin đã tự sửa văn xuôi -> applyBoxEdit. Chỉ tạo bản nháp mới, không tự publish. */
  app.post("/api/kb/intake/conflicts/apply", { preHandler: need("admin") }, async (req) => {
    const b = z
      .object({
        templateId: z.string().max(200).optional(),
        phrase: z.string().max(300).optional(),
        targetDoc: z.string().max(200).optional(),
        kind: z.enum(["template", "chunk"]).optional(),
        lang: z.string().max(10).optional(),
        chunkHeading: z.string().max(300).optional(),
        newText: z.string().max(20_000).optional(),
      })
      .parse(req.body);
    if (b.templateId && b.phrase) {
      const { version } = await kbService.applyNarrow(b.templateId, b.phrase, actor(req));
      await audit(req, "kb.intake_conflict_apply", b.templateId, null, { mode: "narrow", phrase: b.phrase, draftVersion: version.id });
      return { versionId: version.id, slug: version.slug };
    }
    if (!b.targetDoc || !b.kind || b.newText === undefined) throw new KbError("thiếu templateId+phrase, hoặc targetDoc+kind+newText");
    const { version } = await kbService.applyBoxEdit({ targetDoc: b.targetDoc, kind: b.kind, templateId: b.templateId, lang: b.lang, chunkHeading: b.chunkHeading, newText: b.newText }, actor(req));
    await audit(req, "kb.intake_conflict_apply", b.targetDoc, null, { mode: "free-edit", draftVersion: version.id });
    return { versionId: version.id, slug: version.slug };
  });

  /** Publish tuần tự bản nháp chính + mọi bản nháp đã Save ở các khung xung đột — mỗi lần publish tự tái tạo vector. */
  app.post("/api/kb/intake/:versionId/publish-all", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ versionIds: z.array(z.coerce.number().int().positive()).min(1).max(20) }).parse(req.body);
    const results: { versionId: number; status?: "published" | "pending_approval"; error?: string }[] = [];
    for (const id of b.versionIds) {
      try {
        results.push({ versionId: id, status: await kbService.publish(id, actor(req)) });
      } catch (e) {
        results.push({ versionId: id, error: (e as Error).message.slice(0, 300) });
      }
    }
    await audit(req, "kb.intake_publish_all", "kb", null, { versions: b.versionIds, results: results.map((r) => ({ versionId: r.versionId, status: r.status, ok: !r.error })) });
    return { results };
  });

  // ---------------------------------------------------------------- bản dịch
  app.get("/api/translations", async (req) => ({ items: await kb.listTranslations((req.query as { status?: string }).status) }));
  app.post("/api/translations/approve", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ template_id: z.string(), lang: z.string().min(2).max(8), text: z.string().max(4096).optional() }).parse(req.body);
    const tpl = live.index.get(b.template_id);
    if (!tpl) throw new KbError("template không tồn tại", 404);
    const en = live.index.resolveAnswerSource(tpl).answers.en ?? "";
    const stored = await kb.getTranslation(b.template_id, b.lang);
    if (!stored) throw new KbError("chưa có bản dịch để duyệt", 404);
    const finalText = b.text ?? stored.text;
    const chk = checkOutput(finalText, { urlHostWhitelist: live.urlHosts, maxChars: TELEGRAM_MAX_CHARS });
    if (!chk.ok) throw new KbError("bản dịch chưa đạt: " + chk.problems.join("; "));
    if (!sameProtectedSet(en, finalText)) throw new KbError("bản dịch làm thay đổi URL, @handle hoặc tên sản phẩm so với bản tiếng Anh đã duyệt");
    await kb.approveTranslation(b.template_id, b.lang, actor(req).label, b.text);
    await audit(req, "translation.approve", `${b.template_id}:${b.lang}`, { text: stored.text, status: stored.status }, { text: finalText, status: "approved" });
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
    } else if (ch.kind === "skill_update") {
      const p = ch.payload as { name: SkillName; markdown: string };
      await svc.skills.save(p.name, p.markdown, actor(req).label);
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

  // ---------------------------------------------------------------- LLM (gateway, model)
  // Admin chọn model; URL gateway và khoá API chỉ owner đổi (đổi URL là đổi nơi nhận toàn bộ tin nhắn khách). Khoá không bao giờ được trả về trình duyệt.
  const needSecond = async () => (await svc.settings.get())["approval.second_person"];
  const gatewayAudit = (v: Awaited<ReturnType<typeof svc.gateway.view>>) => ({ baseUrl: v.baseUrl, hasKey: v.hasKey, modelFast: v.modelFast, modelStrong: v.modelStrong, modelIntake: v.modelIntake });
  const asKbError = <T>(p: Promise<T>) =>
    p.catch((e) => {
      throw e instanceof GatewayConfigError ? new KbError(e.message) : e;
    });

  app.get("/api/llm", { preHandler: need("admin") }, async () => {
    // Tình trạng THẬT của lời gọi AI 1 giờ qua: cấu hình "sẵn sàng" chưa có nghĩa là gọi được (vd URL localhost trong Docker)
    const r = await svc.db.query<{ calls: number; failed: number; last_error: string | null; last_at: Date | null }>(
      `SELECT count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed,
              (SELECT error FROM llm_calls WHERE NOT ok AND created_at > now() - interval '1 hour' ORDER BY id DESC LIMIT 1) AS last_error,
              max(created_at) AS last_at
       FROM llm_calls WHERE created_at > now() - interval '1 hour'`,
    );
    const rec = r.rows[0]!;
    return { ...(await svc.gateway.view()), ready: svc.llm?.ready !== false, recent: { calls: rec.calls, failed: rec.failed, lastError: rec.last_error, lastAt: rec.last_at }, inDocker: runningInDocker() };
  });

  app.put("/api/llm/models", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ fast: z.string().max(200).optional(), strong: z.string().max(200).optional(), intake: z.string().max(200).optional() }).parse(req.body);
    const before = gatewayAudit(await svc.gateway.view());
    await asKbError(svc.gateway.saveModels(b, actor(req).label));
    await audit(req, "llm.models", "llm", before, gatewayAudit(await svc.gateway.view()));
    return { ok: true };
  });

  // ---- Embedding: người vận hành chọn đúng MỘT model (API ngoài hoặc cục bộ); không dự phòng ngầm; API lỗi -> tự chuyển cục bộ + khoá ----
  const embeddingAudit = (v: Awaited<ReturnType<typeof svc.embedding.view>>) => ({ baseUrl: v.baseUrl, model: v.model, dimensions: v.dimensions, hasKey: v.hasKey, provider: v.provider, locked: v.locked });
  app.get("/api/embedding", { preHandler: need("admin") }, async () => {
    const view = await svc.embedding.view();
    const sel = svc.embedder instanceof SelectedEmbedder ? svc.embedder : null;
    const active = sel ? (await sel.active()).version : svc.embedder.version;
    const local = sel ? sel.local.version : svc.embedder.version;
    const external = sel ? ((await sel.externalEmbedder())?.version ?? null) : null;
    return { ...view, active, local, external, models: [external, local].filter((x): x is string => !!x), coverage: await svc.kb.chunkEmbeddingCoverage(), chunks: await svc.kb.countChunks(), reindexPending: await svc.ops.hasPendingJob("reindex-embeddings") };
  });
  /** Admin chọn model đang dùng. Chọn API khi đang bị khoá -> 400 với hướng dẫn mở khoá. Đổi xong: worker đánh chỉ mục lại toàn bộ cho model mới. */
  app.put("/api/embedding/provider", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ provider: z.enum(["local", "external"]) }).parse(req.body);
    const before = embeddingAudit(await svc.embedding.view());
    await asKbError(svc.embedding.setProvider(b.provider, actor(req).label));
    await audit(req, "embedding.provider", "embedding", before, embeddingAudit(await svc.embedding.view()));
    await svc.ops.enqueueJob("reindex-embeddings", {}, { dedupeKey: "reindex:provider-change" }).catch(() => undefined);
    return { ok: true, provider: (await svc.embedding.view()).provider };
  });
  /** Sau sự cố: gọi thử API với cấu hình đã lưu; thành công mới bỏ khoá. KHÔNG tự chọn lại API — admin chọn rõ ràng sau đó. */
  app.post("/api/embedding/unlock", { preHandler: need("admin") }, async (req) => {
    const r = await svc.embedding.resolve();
    if (!r) return { ok: false, error: "chưa cấu hình URL + model của dịch vụ embedding ngoài" };
    const e = new HttpEmbedder({ url: r.baseUrl, apiKey: r.apiKey, model: r.model, dimensions: r.dimensions });
    const t0 = Date.now();
    try {
      const [v] = await e.embed(["InterLink support bot embedding unlock check"]);
      await svc.embedding.unlockExternal();
      await audit(req, "embedding.unlock", "embedding", null, { model: e.version, dimensions: v?.length ?? 0 });
      return { ok: true, model: e.version, dimensions: v?.length ?? 0, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, model: e.version, error: (err as Error).message.slice(0, 200), latencyMs: Date.now() - t0 };
    }
  });
  /** Đánh chỉ mục lại toàn bộ nội dung đã publish bằng model đang chọn (worker chạy nền, lặp lại an toàn). */
  app.post("/api/embedding/reindex", { preHandler: need("admin") }, async (req) => {
    await svc.ops.enqueueJob("reindex-embeddings", {}, { dedupeKey: "reindex:manual" }).catch(() => undefined);
    await audit(req, "embedding.reindex", "embedding", null, null);
    return { ok: true };
  });
  app.put("/api/embedding/model", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ model: z.string().max(200).optional(), dimensions: z.number().int().nullable().optional() }).parse(req.body);
    const before = embeddingAudit(await svc.embedding.view());
    await asKbError(svc.embedding.save(b, actor(req).label));
    await audit(req, "embedding.model", "embedding", before, embeddingAudit(await svc.embedding.view()));
    await svc.ops.enqueueJob("reindex-embeddings", {}, { dedupeKey: "reindex:model-change" }).catch(() => undefined); // worker đánh chỉ mục kho bằng model mới
    return { ok: true };
  });
  app.put("/api/embedding/connection", { preHandler: need("owner") }, async (req) => {
    const b = z.object({ baseUrl: z.string().max(300).optional(), apiKey: z.string().max(500).optional() }).parse(req.body);
    const before = embeddingAudit(await svc.embedding.view());
    await asKbError(svc.embedding.save(b, actor(req).label));
    await audit(req, "embedding.connection", "embedding", before, { ...embeddingAudit(await svc.embedding.view()), apiKeyChanged: b.apiKey !== undefined });
    await svc.ops.enqueueJob("reindex-embeddings", {}, { dedupeKey: "reindex:conn-change" }).catch(() => undefined);
    return { ok: true };
  });
  /** Gọi thử API ngoài với cấu hình ĐANG LƯU (hoặc model đang nhập): số chiều, độ trễ. Không đổi gì. */
  app.post("/api/embedding/probe", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ model: z.string().max(200).optional(), dimensions: z.number().int().nullable().optional() }).parse(req.body ?? {});
    const r = await svc.embedding.resolve();
    const conn = r ?? ((await svc.embedding.view()).baseUrl ? { baseUrl: (await svc.embedding.view()).baseUrl, model: "" } : null);
    if (!conn?.baseUrl) return { ok: false, error: "chưa có URL dịch vụ embedding" };
    const model = b.model?.trim() || r?.model;
    if (!model) return { ok: false, error: "chưa có model" };
    const e = new HttpEmbedder({ url: conn.baseUrl, apiKey: r?.apiKey, model, dimensions: b.dimensions ?? r?.dimensions });
    const t0 = Date.now();
    try {
      const [v] = await e.embed(["InterLink support bot embedding probe"]);
      return { ok: true, model: e.version, dimensions: v?.length ?? 0, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, model: e.version, error: (err as Error).message.slice(0, 200), latencyMs: Date.now() - t0 };
    }
  });

  app.put("/api/llm/connection", { preHandler: need("owner") }, async (req) => {
    const b = z.object({ baseUrl: z.string().max(300).optional(), apiKey: z.string().max(500).optional() }).parse(req.body);
    const before = gatewayAudit(await svc.gateway.view());
    await asKbError(svc.gateway.saveConnection(b, actor(req).label));
    await audit(req, "llm.connection", "llm", before, { ...gatewayAudit(await svc.gateway.view()), apiKeyChanged: b.apiKey !== undefined });
    return { ok: true };
  });

  app.get("/api/llm/models", { preHandler: need("admin") }, async () => {
    const conn = await svc.gateway.connection();
    if (!conn) throw new KbError("Chưa có URL gateway");
    try {
      return { models: await listGatewayModels(conn) };
    } catch (e) {
      throw new KbError(e instanceof GatewayConfigError ? e.message : `không kết nối được gateway: ${(e as Error).message}`, 502);
    }
  });

  /** Gọi thử từng model gateway đang liệt kê (vài chục token mỗi model): /v1/models liệt kê cả model tài khoản này không dùng được. */
  app.post("/api/llm/probe", { preHandler: need("admin") }, async () => {
    const conn = await svc.gateway.connection();
    if (!conn) throw new KbError("Chưa có URL gateway");
    let models: string[];
    try {
      models = (await listGatewayModels(conn)).slice(0, 30);
    } catch (e) {
      throw new KbError(e instanceof GatewayConfigError ? e.message : `không kết nối được gateway: ${(e as Error).message}`, 502);
    }
    const results: { model: string; ok: boolean; latencyMs: number; error?: string }[] = [];
    let next = 0;
    const worker = async () => {
      while (next < models.length) {
        const model = models[next++]!;
        const r = await testGateway({ ...conn, models: { fast: model, strong: model, intake: model } }, "fast");
        results.push({ model, ok: r.ok, latencyMs: r.latencyMs, error: r.error });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return { results: results.sort((a, b) => a.model.localeCompare(b.model)) };
  });

  app.post("/api/llm/test", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ tier: z.enum(["fast", "strong", "intake"]), model: z.string().regex(/^[A-Za-z0-9._/:@+-]{1,200}$/).optional() }).parse(req.body);
    const conn = await svc.gateway.connection();
    if (!conn) throw new KbError("Chưa có URL gateway");
    const v = await svc.gateway.view();
    const model = b.model ?? (b.tier === "fast" ? v.modelFast : b.tier === "strong" ? v.modelStrong : v.modelIntake);
    if (!model) throw new KbError("Chưa chọn model");
    return testGateway({ ...conn, models: { fast: model, strong: model, intake: model } }, b.tier);
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
    if (!(await needSecond())) {
      await ops.setProtected(key, value, actor(req).label);
      await ops.bumpKbVersion(actor(req).label);
      await live.rebuild();
      await audit(req, "protected.set", key, null, { value });
      return { status: "applied" };
    }
    const id = await ops.proposeChange("protected_setting", { key, value }, req.admin!.id);
    await audit(req, "protected.propose", key, null, { changeId: id });
    return { changeId: id, status: "pending_approval" };
  });

  app.post("/api/admins", { preHandler: need("owner") }, async (req) => {
    const b = z.object({ telegramId: z.coerce.number().int().positive(), role: z.enum(["owner", "admin", "viewer"]) }).parse(req.body);
    if (!(await needSecond())) {
      await ops.upsertAdmin(b.telegramId, b.role, null);
      await audit(req, "admin.upsert", String(b.telegramId), null, { role: b.role });
      return { status: "applied" };
    }
    const id = await ops.proposeChange("admin_change", { action: "upsert", telegramId: b.telegramId, role: b.role }, req.admin!.id);
    await audit(req, "admin.propose_upsert", String(b.telegramId), null, { role: b.role, changeId: id });
    return { changeId: id, status: "pending_approval" };
  });

  app.delete("/api/admins/:id", { preHandler: need("owner") }, async (req) => {
    const telegramId = z.coerce.number().parse((req.params as { id: string }).id);
    if (!(await needSecond())) {
      const owners = (await ops.listAdmins()).filter((a) => a.role === "owner");
      if (owners.length === 1 && owners[0]!.telegram_id === telegramId) throw new KbError("không thể gỡ owner cuối cùng");
      await ops.removeAdmin(telegramId);
      await audit(req, "admin.remove", String(telegramId), null, null);
      return { status: "applied" };
    }
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
    return { range: { from, to }, ...d, rates: { decisions: total, zeroLlmRate: total ? noLlm / total : null, escalateRate: total ? esc / total : null }, health: { jobs, dead, outbox, cron, kbVersion: live.version, llmConfigured: svc.llm?.ready !== false && !!svc.llm }, weekly };
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
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const before = (await svc.db.query("SELECT question, expected_template_id, image_type, source FROM eval_cases WHERE id = $1", [id])).rows[0];
    if (!before) throw new KbError("không tìm thấy câu mẫu", 404);
    await kb.deleteEvalCase(id);
    await audit(req, "eval.delete", String(id), before, null); // câu mẫu là hàng rào chặn Publish: gỡ đi phải truy vết được
    return { ok: true };
  });
  // ---------------------------------------------------------------- SKILL (chỉ dẫn cho từng việc của AI)
  app.get("/api/skills", { preHandler: need("admin") }, async () => ({ items: await svc.skills.list(), secondApproval: await needSecond() }));
  app.put("/api/skills/:name", { preHandler: need("admin") }, async (req) => {
    const name = z.enum(SKILL_NAMES).parse((req.params as { name: string }).name);
    const { markdown } = z.object({ markdown: z.string().min(50).max(40_000) }).parse(req.body);
    await asKbError((async () => { parseSkill(markdown, name); })()); // báo lỗi cấu trúc ngay, trước khi đề xuất
    if (await needSecond()) {
      const id = await ops.proposeChange("skill_update", { name, markdown }, req.admin!.id);
      await audit(req, "skill.propose", name, null, { changeId: id });
      return { status: "pending_approval", changeId: id };
    }
    await asKbError(svc.skills.save(name, markdown, actor(req).label));
    await audit(req, "skill.update", name, null, { chars: markdown.length });
    return { status: "applied" };
  });
  app.delete("/api/skills/:name", { preHandler: need("admin") }, async (req) => {
    const name = z.enum(SKILL_NAMES).parse((req.params as { name: string }).name);
    await svc.skills.reset(name);
    await audit(req, "skill.reset", name, null, null);
    return { ok: true };
  });

  /**
   * Đánh giá bộ câu hỏi mẫu bằng AI (tốn token): (1) chạy đúng luồng bot thật (có AI) cho từng câu để xem bot sẽ chọn gì,
   * (2) SKILL review-eval nhận xét kỳ vọng có hợp lý không. Mặc định chỉ các câu đang sai ở tầng 0-1.
   */
  app.post("/api/eval/review", { preHandler: need("admin") }, async (req) => {
    const b = z.object({ scope: z.enum(["failures", "all"]).default("failures"), limit: z.number().int().min(1).max(60).default(30) }).parse(req.body ?? {});
    const llm = usableLlm(svc.llm);
    if (!llm) throw new KbError("chưa cấu hình LLM");
    const cases = await kb.listEvalCases();
    const offline = await runEval(cases, live.index, live.evaluator, evalSettings(live.urlHosts));
    const picked = cases.map((c, i) => ({ c, row: offline.rows[i]! })).filter((x) => b.scope === "all" || !x.row.ok).slice(0, b.limit);
    const settings = await svc.settings.get();
    const rs: RouterSettings = { semanticConfident: settings["router.semantic_confident"], semanticMargin: settings["router.semantic_margin"], semanticSuggest: settings["router.semantic_suggest"], tier3Mode: settings["router.tier3_mode"], tier3MinScore: settings["router.tier3_min_score"], tier3Verify: settings["router.tier3_verify"], knowledgeLang: settings["router.knowledge_lang"], tooShortMaxChars: settings["router.too_short_max_chars"], urlHostWhitelist: live.urlHosts };
    const withAi: { got: string; notes: string[] }[] = [];
    for (const { c } of picked) {
      try {
        const r = await routeHybrid({ codeDetectedLang: detectLanguage(c.question), text: c.question, norm: normalize(c.question), lang: detectLanguage(c.question) ?? "en", hasImage: !!c.image_type, isSticker: false, vision: c.image_type ? { screen_type: c.image_type as never, error_text: "", has_secret: false, readable: true } : undefined, ctx: {} }, { index: live.index, evaluator: live.evaluator, settings: rs, llm, knowledge: svc.knowledge });
        withAi.push({ got: outcomeKey(r.outcome), notes: r.trace.notes.filter((n) => /^AI |^nhánh|kiểm duyệt|chọn/.test(n)).slice(0, 4) });
      } catch (e) {
        withAi.push({ got: "LỖI", notes: [(e as Error).message.slice(0, 120)] });
      }
    }
    const templates = live.index.templates.filter((t) => t.response_mode === "EXACT_TEMPLATE").map((t) => ({ id: t.id, group: t.group, examples: t.match.examples, answer: live.index.resolveAnswerSource(t).answers.en ?? "" }));
    let review: Awaited<ReturnType<typeof llm.reviewEval>> = [];
    try {
      review = await llm.reviewEval({ templates, cases: picked.map((x, i) => ({ n: i + 1, question: x.c.question, expected: x.c.expected_template_id ?? "ESCALATE", got: withAi[i]?.got })) });
    } catch (e) {
      throw new KbError("AI đánh giá lỗi: " + (e as Error).message.slice(0, 160));
    }
    await audit(req, "eval.review", "eval", null, { scope: b.scope, n: picked.length });
    return {
      items: picked.map((x, i) => ({ id: x.c.id, question: x.c.question, expected: x.c.expected_template_id ?? "ESCALATE", rulesOnly: x.row.got, withAi: withAi[i]!.got, notes: withAi[i]!.notes, review: review.find((r) => r.n === i + 1) ?? null })),
      offline: { total: offline.total, correct: offline.correct },
    };
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
