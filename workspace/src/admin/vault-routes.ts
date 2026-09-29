/**
 * API Admin Web cho luồng nạp mới (docs/adr/0005): tải file -> raw-data/ -> job vault-ingest; xem lượt nạp; xem và quyết định
 * xung đột. Admin KHÔNG ghi vào vault: chỉ lưu file thô và xếp job (worker là nơi ghi duy nhất). Quyết định xung đột được
 * khoá nguyên tử ở DB (người bấm đầu tiên thắng) rồi xếp job vault-decide.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../app";
import { usableLlm } from "../core/ports";
import type { AdminRole } from "../db/repo-ops";
import type { ConflictRow } from "../db/repo-vault";
import { MAX_UPLOAD_BYTES } from "../kb/doc-extract";
import { KbError, type Actor } from "../kb/service";
import { VaultDraftNoteSchema } from "../llm/client";
import { claimAndCommitDecision } from "../vault/decide";
import { renderTaxonomyForPrompt } from "../vault/ingest";
import { sectionsToBody } from "../vault/note";
import { loadTaxonomy } from "../vault/taxonomy";

const ALLOWED_EXT = new Set(["txt", "md", "pdf", "doc", "docx", "xlsx"]);

/** Tên file an toàn trong raw-data/: bỏ đường dẫn, chỉ giữ chữ/số/._- và khoảng trắng, thêm ngày ở đầu, không ghi đè. */
export function rawFileName(dir: string, original: string, date: string): string {
  const base = (original.split(/[\\/]/).pop() || "file").normalize("NFC").replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^\.+/, "").slice(-120) || "file";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 1; ; n++) {
    const name = `${date}_${stem}${n > 1 ? `-${n}` : ""}${ext}`;
    if (!existsSync(join(dir, name))) return name;
  }
}

export function conflictView(c: ConflictRow) {
  const letters = c.candidates.filter((x) => !x.old).map((x) => x.label.toLowerCase());
  return {
    id: c.id, type: c.type, versionGroup: c.versionGroup, status: c.status, reasons: c.reasons, candidates: c.candidates, activeNoteId: c.activeNoteId, notificationFile: c.notificationFile,
    decision: c.decision, decidedBy: c.decidedBy, decidedAt: c.decidedAt, createdAt: c.createdAt, remindCount: c.remindCount,
    options: [...letters, ...(c.candidates.some((x) => x.old) ? ["old"] : []), "merge", "drop_all"],
  };
}

export function registerVaultRoutes(
  app: FastifyInstance,
  svc: Services,
  h: { need: (min: AdminRole) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>; actor: (req: FastifyRequest) => Actor; audit: (req: FastifyRequest, action: string, entity: string | null, before: unknown, after: unknown) => Promise<unknown>; now: () => Date },
) {
  const { need, actor, audit, now } = h;
  const repo = svc.vault;
  const rawDir = svc.cfg.RAW_DATA_DIR;
  const taxonomyText = () => loadTaxonomy(svc.cfg.VAULT_DIR);

  /** Tải MỘT file lên (giao diện gửi từng file). Lưu nguyên file vào raw-data/, tạo lượt nạp, xếp job chuyển đổi. */
  app.post("/api/vault/upload", { preHandler: need("admin") }, async (req) => {
    const file = await req.file();
    if (!file) throw new KbError("thiếu tệp: chọn một tệp .txt, .md, .pdf, .doc, .docx hoặc .xlsx");
    const ext = (file.filename.split(".").pop() || "").toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw new KbError(`không nhận tệp ".${ext || "?"}": chỉ nhận .txt, .md, .pdf, .doc, .docx, .xlsx (Excel cũ .xls thì lưu lại thành .xlsx)`, 415);
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new KbError(`tệp vượt quá ${Math.round(MAX_UPLOAD_BYTES / 1_000_000)} MB: tách thành nhiều tệp nhỏ hơn`, 413);
    if (!buf.length) throw new KbError("tệp rỗng: chọn tệp có nội dung");
    mkdirSync(rawDir, { recursive: true });
    const name = rawFileName(rawDir, file.filename, now().toISOString().slice(0, 10));
    writeFileSync(join(rawDir, name), buf);
    const batchId = await repo.createBatch(file.filename, name, actor(req).label);
    await svc.ops.enqueueJob("vault-ingest", { batchId }, { dedupeKey: `vault-ingest:${batchId}` });
    await audit(req, "vault.upload", name, null, { batchId, bytes: buf.length });
    return { batchId, rawFile: name };
  });

  app.get("/api/vault/batches", { preHandler: need("viewer") }, async () => ({ batches: await repo.listBatches(100) }));

  app.get("/api/vault/batches/:id", { preHandler: need("viewer") }, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = await repo.getBatch(id);
    if (!b) throw new KbError("không tìm thấy lượt nạp", 404);
    return { batch: b };
  });

  /** Chạy lại lượt nạp bị lỗi (vd chưa cấu hình AI lúc tải lên). */
  app.post("/api/vault/batches/:id/retry", { preHandler: need("admin") }, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = await repo.getBatch(id);
    if (!b) throw new KbError("không tìm thấy lượt nạp", 404);
    if (b.status === "done") throw new KbError("lượt nạp này đã xong, không cần chạy lại", 409);
    await repo.markBatch(id, "queued");
    await svc.ops.enqueueJob("vault-ingest", { batchId: id }, { dedupeKey: `vault-ingest:${id}` });
    await audit(req, "vault.retry", String(id), null, null);
    return { ok: true };
  });

  app.get("/api/vault/summary", { preHandler: need("viewer") }, async () => ({
    openConflicts: await repo.countOpenConflicts(),
    notes: await repo.countNotes(),
    index: await repo.chunkStats(),
  }));

  app.get("/api/vault/conflicts", { preHandler: need("viewer") }, async (req) => {
    const q = z.object({ status: z.enum(["open", "resolved"]).default("open") }).parse(req.query);
    const rows = await repo.listConflicts(q.status === "open" ? ["open", "sent", "deciding"] : ["resolved"]);
    return { conflicts: rows.map(conflictView) };
  });

  app.get("/api/vault/conflicts/:id", { preHandler: need("viewer") }, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const c = await repo.getConflict(id);
    if (!c) throw new KbError("không tìm thấy xung đột", 404);
    return { conflict: conflictView(c) };
  });

  /** Gộp / nhập lại: AI soạn note từ nội dung admin nhập (đúng chủ đề đang xung đột) để admin XEM TRƯỚC, chưa ghi gì. */
  app.post("/api/vault/conflicts/:id/merge-preview", { preHandler: need("admin") }, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = z.object({ text: z.string().trim().min(10, "nội dung quá ngắn: nhập đầy đủ câu trả lời đúng").max(20_000) }).parse(req.body);
    const c = await repo.getConflict(id);
    if (!c || c.status === "resolved") throw new KbError("xung đột không còn mở", 409);
    const llm = usableLlm(svc.llm);
    if (!llm) throw new KbError("chưa cấu hình AI (Cấu hình → LLM) nên chưa soạn được note gộp", 503);
    const tax = taxonomyText();
    const r = await llm.draftVaultNotes({
      sourceFile: "admin (gộp xung đột)", taxonomy: renderTaxonomyForPrompt(tax), existingGroups: await repo.activeGroups(), fixedVersionGroup: c.versionGroup,
      units: [{ id: "U1", ref: `Admin nhập lại cho xung đột #${c.id}`, text: b.text }],
    });
    const n = r.notes[0];
    if (!n) throw new KbError("AI không soạn được note từ nội dung này: viết rõ hơn rồi thử lại", 422);
    const note = { ...n, version_group: c.versionGroup, units: ["U1"] };
    if (!tax.categories.some((x) => x.key === note.category)) throw new KbError(`AI xếp vào nhóm "${note.category}" không có trong taxonomy: thêm nhóm này vào _meta/taxonomy.md hoặc viết rõ chủ đề rồi thử lại`, 422);
    return { note, body: sectionsToBody(note.sections) };
  });

  app.post("/api/vault/conflicts/:id/decide", { preHandler: need("admin") }, async (req, reply) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = z.object({ decision: z.string().regex(/^([a-z]|old|merge|drop_all)$/), note: VaultDraftNoteSchema.optional() }).parse(req.body);
    const c = await repo.getConflict(id);
    if (!c) throw new KbError("không tìm thấy xung đột", 404);
    const allowed = conflictView(c).options;
    if (!allowed.includes(b.decision)) throw new KbError("lựa chọn không có trong xung đột này: tải lại trang để xem các phương án hiện tại", 400);
    if (b.decision === "merge") {
      if (!b.note) throw new KbError("thiếu nội dung gộp: bấm \"Xem trước\" rồi xác nhận");
      if (b.note.version_group !== c.versionGroup) throw new KbError("nội dung gộp không thuộc chủ đề của xung đột này: soạn lại bằng \"Xem trước\"");
    }
    const result = await claimAndCommitDecision({ repo, ops: svc.ops, enqueue: (t, p, o) => svc.ops.enqueueJob(t, p, o) }, id, b.decision, b.decision === "merge" ? { note: b.note } : null, actor(req).label, now(), "admin-web");
    if (!result.claimed) return reply.code(409).send({ error: `Xung đột này đã được xử lý bởi ${result.decidedBy ?? "người khác"}.` });
    return { ok: true, conflict: conflictView(result.claimed) };
  });
}
