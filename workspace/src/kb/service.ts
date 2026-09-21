/**
 * Dịch vụ kho tri thức: Draft -> kiểm tra -> Publish (có duyệt hai người với luật bảo mật) -> Rollback.
 * Các bước kiểm tra chạy trước Publish để việc Admin tự nạp dữ liệu không làm lệch hành vi cũ.
 */
import type { Embedder } from "../core/embedding";
import { cosine } from "../core/embedding";
import { checkOutput, collectHosts, urlHosts } from "../core/gate";
import { buildIndex } from "../core/bundle";
import { parseKnowledgeDoc, type KnowledgeChunk } from "../core/knowledge";
import { makeEvaluator, type PredicateMap } from "../core/predicates";
import { detectKeyLeak } from "../core/sanitize";
import { parseTemplateFile, validateBundle } from "../core/templates";
import { normalize } from "../core/text";
import type { ParseIssue, Template } from "../domain/types";
import type { Db } from "../db/db";
import { kbRepo, type KbRepo, type VersionRow } from "../db/repo-kb";
import { opsRepo, type AdminRole, type OpsRepo } from "../db/repo-ops";
import { evalSettings, outcomeKey, routeOffline, runEval, type EvalCase } from "./eval";
import type { LiveContent } from "./live-content";

export type DocKind = "templates" | "knowledge";

export interface Actor {
  id: number;
  role: AdminRole;
  label: string;
}

export interface ReportStep {
  name: string;
  status: "ok" | "warning" | "error";
  details: string[];
}

export interface ValidationReport {
  ok: boolean;
  steps: ReportStep[];
  regression?: { total: number; accuracyBefore: number; accuracyAfter: number; changed: { question: string; before: string; after: string }[] };
  replay?: { total: number; changed: number; samples: { text: string; before: string; after: string }[] };
  templateCount?: number;
  chunkCount?: number;
  securityRules?: string[];
}

export class KbError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface Parsed {
  kind: DocKind;
  slug: string;
  title: string;
  templates: Template[];
  chunks: KnowledgeChunk[];
  issues: ParseIssue[];
}

export interface KbServiceDeps {
  db: Db;
  kb: KbRepo;
  ops: OpsRepo;
  embedder: Embedder;
  live: LiveContent;
  predicatesFallback: () => PredicateMap;
  now?: () => Date;
}

export class KbService {
  constructor(private readonly d: KbServiceDeps) {}
  private now = () => (this.d.now ?? (() => new Date()))();

  // ---------------------------------------------------------------- phân tích
  parse(kind: DocKind, md: string, slugHint?: string): Parsed {
    if (kind === "knowledge") {
      const r = parseKnowledgeDoc(md, slugHint);
      return { kind, slug: r.doc?.slug ?? slugHint ?? "", title: r.doc?.title ?? slugHint ?? "", templates: [], chunks: r.doc?.chunks ?? [], issues: r.issues };
    }
    const r = parseTemplateFile(md, slugHint);
    return { kind, slug: slugHint ?? "", title: slugHint ?? "", templates: r.templates, chunks: [], issues: r.issues };
  }

  private async predicateMap(): Promise<PredicateMap> {
    const prot = await this.d.ops.getProtected();
    const p = prot.predicates as PredicateMap | undefined;
    // bản rỗng sẽ xoá sạch mọi điều kiện của template: coi như chưa cấu hình và dùng bản mặc định
    return p && Object.keys(p).length ? p : this.d.predicatesFallback();
  }

  // ---------------------------------------------------------------- Draft + kiểm tra
  async createDraft(input: { slug: string; kind: DocKind; title?: string; md: string; author: Actor | string }): Promise<{ version: VersionRow; report: ValidationReport }> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.slug)) throw new KbError("slug chỉ gồm chữ thường, số, gạch ngang");
    const existing = await this.d.kb.getDocument(input.slug);
    if (existing && existing.kind !== input.kind) throw new KbError(`tài liệu ${input.slug} đã tồn tại với loại ${existing.kind}`);
    await this.d.kb.upsertDocument(input.slug, input.title ?? existing?.title ?? input.slug, input.kind);
    const author = typeof input.author === "string" ? input.author : input.author.label;
    const report = await this.validateSource(input.slug, input.kind, input.md);
    const version = await this.d.kb.createVersion({
      slug: input.slug,
      sourceMd: input.md,
      status: "draft",
      author,
      report,
      requiresSecondApproval: (report.securityRules?.length ?? 0) > 0,
    });
    return { version, report };
  }

  async updateDraft(versionId: number, md: string): Promise<ValidationReport> {
    const v = await this.mustVersion(versionId);
    if (v.status !== "draft" && v.status !== "rejected") throw new KbError("chỉ sửa được bản Draft");
    const doc = await this.d.kb.getDocument(v.slug);
    const report = await this.validateSource(v.slug, doc!.kind, md);
    await this.d.kb.updateVersion(versionId, { sourceMd: md, status: "draft", report, requiresSecondApproval: (report.securityRules?.length ?? 0) > 0 });
    return report;
  }

  async revalidate(versionId: number): Promise<ValidationReport> {
    const v = await this.mustVersion(versionId);
    const doc = await this.d.kb.getDocument(v.slug);
    const report = await this.validateSource(v.slug, doc!.kind, v.source_md);
    await this.d.kb.updateVersion(versionId, { report });
    return report;
  }

  /** Sáu bước kiểm tra trước khi cho Publish. */
  async validateSource(slug: string, kind: DocKind, md: string): Promise<ValidationReport> {
    const steps: ReportStep[] = [];
    const parsed = this.parse(kind, md, slug);
    const push = (name: string, issues: string[], level: "warning" | "error" = "error") => steps.push({ name, status: issues.length ? level : "ok", details: issues });

    // 1. Cấu trúc
    push("1. Cấu trúc", parsed.issues.filter((i) => i.level === "error").map((i) => (i.templateId ? `[${i.templateId}] ` : "") + i.message));
    for (const w of parsed.issues.filter((i) => i.level === "warning")) steps[0]!.details.push(`cảnh báo: ${w.message}`);
    const report: ValidationReport = { ok: false, steps, templateCount: parsed.templates.length, chunkCount: parsed.chunks.length };
    if (steps[0]!.status === "error") {
      report.ok = false;
      return report;
    }

    const liveRows = await this.d.kb.loadPublishedTemplateRows();
    const others = liveRows.filter((r) => r.docSlug !== slug).map((r) => r.template);

    // 2. Quét an toàn
    const hosts = this.d.live.urlHosts;
    const safety: string[] = [];
    const warnings: string[] = [];
    const allTexts = kind === "templates" ? parsed.templates.flatMap((t) => Object.values(t.answers)) : parsed.chunks.map((c) => c.text);
    for (const txt of allTexts) {
      if (detectKeyLeak(txt)) safety.push("nội dung chứa chuỗi giống private key / seed phrase");
      if (/<\s*script|javascript:|on\w+\s*=\s*["']/i.test(txt)) safety.push("nội dung chứa HTML/script");
      for (const h of urlHosts(txt)) if (hosts.size && !hosts.has(h)) warnings.push(`URL mới ngoài whitelist hiện tại: ${h} (người duyệt cần xác nhận)`);
    }
    for (const t of parsed.templates) {
      const chk = checkOutput(Object.values(t.answers).join("\n"), { urlHostWhitelist: new Set([...hosts, ...collectHosts(Object.values(t.answers))]), maxChars: 4096 * Math.max(1, Object.keys(t.answers).length) });
      if (!chk.ok) safety.push(...chk.problems.map((p) => `[${t.id}] ${p}`));
      for (const [lang, text] of Object.entries(t.answers)) if (text.length > 4096) safety.push(`[${t.id}] bản ${lang} vượt 4096 ký tự (giới hạn Telegram)`);
    }
    steps.push({ name: "2. Quét an toàn", status: safety.length ? "error" : warnings.length ? "warning" : "ok", details: [...new Set([...safety, ...warnings])] });

    // 3. Trùng lặp và mâu thuẫn (chỉ template)
    if (kind === "templates") {
      const predicates = await this.predicateMap();
      const union = [...others, ...parsed.templates];
      const cross = validateBundle(union, makeEvaluator(predicates).names()).filter((i) => i.level === "error");
      const dup: string[] = cross.map((i) => `[${i.templateId ?? "-"}] ${i.message}`);
      const conflictWarn: string[] = [];
      const kwOwner = new Map<string, Template>();
      for (const t of others) for (const k of t.match.keywords) kwOwner.set(normalize(k), t);
      for (const t of parsed.templates) {
        for (const k of t.match.keywords) {
          const o = kwOwner.get(normalize(k));
          if (o && o.id !== t.id && this.answerOf(o) !== this.answerOf(t)) conflictWarn.push(`từ khoá "${k}" của ${t.id} trùng với ${o.id} nhưng đáp án khác nhau (ưu tiên: ${t.priority} so với ${o.priority})`);
        }
      }
      const embWarn = await this.similarExamples(parsed.templates, others);
      steps.push({ name: "3. Trùng và mâu thuẫn", status: dup.length ? "error" : conflictWarn.length || embWarn.length ? "warning" : "ok", details: [...dup, ...conflictWarn, ...embWarn] });
    } else {
      steps.push({ name: "3. Trùng và mâu thuẫn", status: "ok", details: [] });
    }

    // 4. Bản dịch
    const trans: string[] = [];
    if (kind === "templates") {
      const langs = new Set(parsed.templates.flatMap((t) => Object.keys(t.answers)));
      langs.delete("en");
      for (const t of parsed.templates.filter((x) => x.response_mode !== "SECURITY_RULE")) {
        const missing = [...langs].filter((l) => !t.answers[l]);
        if (missing.length) trans.push(`[${t.id}] thiếu bản dịch ${missing.join(", ")} (sẽ được dịch một lần khi cần và chờ duyệt)`);
      }
    }
    steps.push({ name: "4. Bản dịch", status: trans.length ? "warning" : "ok", details: trans.slice(0, 20) });

    // 5. Hồi quy + 6. Replay (chỉ template)
    if (kind === "templates") {
      const predicates = await this.predicateMap();
      const evaluator = makeEvaluator(predicates);
      const beforeIdx = this.d.live.index;
      const draftTemplates = [...others, ...parsed.templates];
      const afterIdx = await buildIndex({ templates: draftTemplates, evaluator }, this.d.embedder);
      const cases = await this.d.kb.listEvalCases();
      const settings = evalSettings(this.d.live.urlHosts);
      const before = beforeIdx ? await runEval(cases as EvalCase[], beforeIdx, this.d.live.evaluator, settings) : { rows: [], correct: 0, total: 0 };
      const after = await runEval(cases as EvalCase[], afterIdx, evaluator, settings);
      const changed = before.rows.map((b, i) => ({ q: b.question, before: b.got, after: after.rows[i]?.got ?? "?" })).filter((x) => x.before !== x.after).map((x) => ({ question: x.q, before: x.before, after: x.after }));
      report.regression = { total: cases.length, accuracyBefore: cases.length ? before.correct / cases.length : 1, accuracyAfter: cases.length ? after.correct / cases.length : 1, changed: changed.slice(0, 50) };
      const drop = report.regression.accuracyAfter < report.regression.accuracyBefore - 1e-9;
      steps.push({ name: "5. Test hồi quy", status: drop ? "error" : changed.length ? "warning" : "ok", details: [`độ chính xác ${(report.regression.accuracyBefore * 100).toFixed(1)}% → ${(report.regression.accuracyAfter * 100).toFixed(1)}% trên ${cases.length} câu`, ...changed.slice(0, 10).map((c) => `"${c.question}": ${c.before} → ${c.after}`)] });

      const replayMsgs = await this.d.ops.messagesForReplay(new Date(this.now().getTime() - 14 * 86_400_000), 300);
      let changedN = 0;
      const samples: { text: string; before: string; after: string }[] = [];
      for (const m of replayMsgs) {
        const a = outcomeKey((await routeOffline(m.text, m.imageType, beforeIdx, this.d.live.evaluator, settings)).outcome);
        const b = outcomeKey((await routeOffline(m.text, m.imageType, afterIdx, evaluator, settings)).outcome);
        if (a !== b) {
          changedN++;
          if (samples.length < 20) samples.push({ text: m.text.slice(0, 120), before: a, after: b });
        }
      }
      report.replay = { total: replayMsgs.length, changed: changedN, samples };
      steps.push({ name: "6. Replay tin nhắn thật (14 ngày)", status: changedN ? "warning" : "ok", details: [`${changedN}/${replayMsgs.length} tin sẽ đổi câu trả lời`, ...samples.slice(0, 5).map((s) => `"${s.text}": ${s.before} → ${s.after}`)] });
      report.securityRules = parsed.templates.filter((t) => t.response_mode === "SECURITY_RULE").map((t) => t.id);
    } else {
      steps.push({ name: "5. Test hồi quy", status: "ok", details: ["tài liệu tri thức: không áp dụng"] });
      steps.push({ name: "6. Replay tin nhắn thật (14 ngày)", status: "ok", details: ["tài liệu tri thức: không áp dụng"] });
    }

    report.ok = steps.every((s) => s.status !== "error");
    return report;
  }

  private answerOf(t: Template): string {
    return t.answers.en ?? t.answer_from ?? "";
  }

  private async similarExamples(draft: Template[], others: Template[]): Promise<string[]> {
    const out: string[] = [];
    const pairs: { id: string; text: string }[] = [];
    for (const t of draft) for (const e of t.match.examples) pairs.push({ id: t.id, text: e });
    const otherPairs: { id: string; text: string }[] = [];
    for (const t of others) for (const e of t.match.examples) otherPairs.push({ id: t.id, text: e });
    if (!pairs.length || !otherPairs.length) return out;
    try {
      const vecs = await this.d.embedder.embed([...pairs.map((p) => p.text), ...otherPairs.map((p) => p.text)]);
      const a = vecs.slice(0, pairs.length);
      const b = vecs.slice(pairs.length);
      const seen = new Set<string>();
      a.forEach((va, i) =>
        b.forEach((vb, j) => {
          if (pairs[i]!.id !== otherPairs[j]!.id && cosine(va, vb) >= 0.93) {
            const key = `${pairs[i]!.id}|${otherPairs[j]!.id}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push(`ví dụ của ${pairs[i]!.id} ("${pairs[i]!.text}") gần trùng với ${otherPairs[j]!.id} ("${otherPairs[j]!.text}")`);
            }
          }
        }),
      );
    } catch {
      /* không có embedding: bỏ qua bước này */
    }
    return out.slice(0, 10);
  }

  // ---------------------------------------------------------------- Publish
  private async mustVersion(id: number): Promise<VersionRow> {
    const v = await this.d.kb.getVersion(id);
    if (!v) throw new KbError("không tìm thấy phiên bản", 404);
    return v;
  }

  /**
   * Publish: nếu có luật bảo mật (SECURITY_RULE) thì chỉ owner được đề xuất và cần người thứ hai duyệt.
   * Trả về 'published' hoặc 'pending_approval'.
   */
  async publish(versionId: number, actor: Actor): Promise<"published" | "pending_approval"> {
    if (actor.role === "viewer") throw new KbError("không đủ quyền", 403);
    const v = await this.mustVersion(versionId);
    if (v.status !== "draft") throw new KbError(`phiên bản đang ở trạng thái ${v.status}`);
    const doc = (await this.d.kb.getDocument(v.slug))!;
    const report = await this.validateSource(v.slug, doc.kind, v.source_md);
    await this.d.kb.updateVersion(versionId, { report });
    if (!report.ok) throw new KbError("bản Draft chưa qua kiểm tra: " + report.steps.filter((s) => s.status === "error").map((s) => s.name).join(", "));

    const protectedContent = (report.securityRules?.length ?? 0) > 0;
    if (protectedContent) {
      if (actor.role !== "owner") throw new KbError("nội dung có luật bảo mật (SECURITY_RULE): chỉ owner được đề xuất", 403);
      await this.d.kb.updateVersion(versionId, { status: "pending_approval", requiresSecondApproval: true });
      await this.d.ops.proposeChange("kb_publish", { versionId, slug: v.slug }, actor.id);
      await this.d.ops.audit(actor.label, "kb.propose_publish", v.slug, null, { versionId, securityRules: report.securityRules });
      return "pending_approval";
    }
    await this.activate(v, doc.kind, actor.label);
    await this.d.ops.audit(actor.label, "kb.publish", v.slug, { published: (await this.d.kb.getPublished(v.slug))?.version ?? null }, { version: v.version });
    return "published";
  }

  async approve(changeId: number, actor: Actor): Promise<void> {
    if (actor.role === "viewer") throw new KbError("không đủ quyền", 403);
    const ch = await this.d.ops.getChange(changeId);
    if (!ch || ch.status !== "pending" || ch.kind !== "kb_publish") throw new KbError("không có thay đổi chờ duyệt", 404);
    if (ch.proposed_by === actor.id) throw new KbError("người đề xuất không thể tự duyệt: cần một người khác", 403);
    const v = await this.mustVersion(Number(ch.payload.versionId));
    const doc = (await this.d.kb.getDocument(v.slug))!;
    await this.activate(v, doc.kind, actor.label);
    await this.d.ops.decideChange(changeId, "approved", actor.id);
    await this.d.ops.audit(actor.label, "kb.approve_publish", v.slug, null, { version: v.version, proposedBy: ch.proposed_by });
  }

  async reject(changeId: number, actor: Actor): Promise<void> {
    const ch = await this.d.ops.getChange(changeId);
    if (!ch || ch.status !== "pending") throw new KbError("không có thay đổi chờ duyệt", 404);
    await this.d.ops.decideChange(changeId, "rejected", actor.id);
    if (ch.kind === "kb_publish") await this.d.kb.updateVersion(Number(ch.payload.versionId), { status: "rejected" });
    await this.d.ops.audit(actor.label, "kb.reject_publish", String(ch.payload.slug ?? ""), null, { changeId });
  }

  /** Rollback: tạo phiên bản mới từ nội dung của phiên bản cũ rồi publish (giữ lịch sử, không ghi đè). */
  async rollback(slug: string, toVersion: number, actor: Actor): Promise<"published" | "pending_approval"> {
    const versions = await this.d.kb.listVersions(slug);
    const old = versions.find((v) => v.version === toVersion);
    if (!old) throw new KbError("không có phiên bản này", 404);
    const doc = (await this.d.kb.getDocument(slug))!;
    const { version } = await this.createDraft({ slug, kind: doc.kind, md: old.source_md, author: actor });
    await this.d.ops.audit(actor.label, "kb.rollback", slug, null, { toVersion, newVersion: version.version });
    return this.publish(version.id, actor);
  }

  /** Kích hoạt một phiên bản: ghi template/chunk, đánh dấu published, tăng kb_version để bot nạp lại. */
  private async activate(v: VersionRow, kind: DocKind, by: string): Promise<void> {
    const parsed = this.parse(kind, v.source_md, v.slug);
    let chunkRows: { index: number; heading: string; text: string; url?: string; searchText: string; hash: string; embedding?: number[]; embeddingModel?: string }[] = [];
    if (kind === "knowledge") {
      const cache = await this.d.kb.getEmbeddings(parsed.chunks.map((c) => c.hash), this.d.embedder.version);
      const missing = parsed.chunks.filter((c) => !cache.has(c.hash));
      if (missing.length) {
        try {
          const vecs = await this.d.embedder.embed(missing.map((c) => c.text));
          const entries = missing.map((c, i) => ({ hash: c.hash, vector: vecs[i]! }));
          await this.d.kb.putEmbeddings(entries, this.d.embedder.version);
          for (const e of entries) cache.set(e.hash, e.vector);
        } catch {
          /* không có embedding: chunk vẫn tìm được bằng từ khoá */
        }
      }
      chunkRows = parsed.chunks.map((c) => ({ ...c, embedding: cache.get(c.hash), embeddingModel: cache.get(c.hash) ? this.d.embedder.version : undefined }));
    } else {
      // kiểm tra chéo với phần còn lại của kho trước khi kích hoạt
      const live = (await this.d.kb.loadPublishedTemplateRows()).filter((r) => r.docSlug !== v.slug).map((r) => r.template);
      const predicates = await this.predicateMap();
      const errs = validateBundle([...live, ...parsed.templates], makeEvaluator(predicates).names()).filter((i) => i.level === "error");
      if (errs.length) throw new KbError("không nhất quán với phần còn lại của kho: " + errs.map((e) => e.message).join("; "));
    }
    const at = this.now();
    await this.d.db.tx(async (tx) => {
      const kb = kbRepo(tx);
      const ops = opsRepo(tx);
      await kb.activateVersion(v.id, v.slug, by, at);
      if (kind === "templates") await kb.replaceTemplates(v.id, v.slug, parsed.templates);
      else await kb.replaceChunks(v.id, v.slug, chunkRows);
      await ops.bumpKbVersion(by);
    });
    await this.d.live.rebuild();
  }

  // ---------------------------------------------------------------- Gộp nhiều tài liệu (seed / import)
  /** Publish nhiều tài liệu một lần (kiểm tra chéo trên tập hợp đầy đủ). Dùng cho seed lần đầu. */
  async publishBundle(docs: { slug: string; kind: DocKind; title: string; md: string }[], author: string): Promise<void> {
    const parsed = docs.map((d) => ({ d, p: this.parse(d.kind, d.md, d.slug) }));
    const errors = parsed.flatMap(({ d, p }) => p.issues.filter((i) => i.level === "error").map((i) => `${d.slug}: ${i.message}`));
    const predicates = await this.predicateMap();
    const allTemplates = parsed.flatMap(({ p }) => p.templates);
    errors.push(...validateBundle(allTemplates, makeEvaluator(predicates).names()).filter((i) => i.level === "error").map((i) => `[${i.templateId ?? "-"}] ${i.message}`));
    if (errors.length) throw new KbError("Bộ nội dung không hợp lệ:\n" + errors.join("\n"));

    for (const { d } of parsed) {
      await this.d.kb.upsertDocument(d.slug, d.title, d.kind);
      const v = await this.d.kb.createVersion({ slug: d.slug, sourceMd: d.md, status: "draft", author, report: { ok: true, steps: [], note: "seed" }, requiresSecondApproval: false });
      // bỏ qua kiểm tra chéo từng tài liệu (đã kiểm tra trên toàn bộ tập)
      const kind = d.kind;
      const p = this.parse(kind, d.md, d.slug);
      let chunkRows: { index: number; heading: string; text: string; url?: string; searchText: string; hash: string; embedding?: number[]; embeddingModel?: string }[] = [];
      if (kind === "knowledge") {
        let vecs: number[][] = [];
        try {
          vecs = await this.d.embedder.embed(p.chunks.map((c) => c.text));
        } catch {
          vecs = [];
        }
        chunkRows = p.chunks.map((c, i) => ({ ...c, embedding: vecs[i], embeddingModel: vecs[i] ? this.d.embedder.version : undefined }));
      }
      await this.d.db.tx(async (tx) => {
        const kb = kbRepo(tx);
        await kb.activateVersion(v.id, d.slug, author, this.now());
        if (kind === "templates") await kb.replaceTemplates(v.id, d.slug, p.templates);
        else await kb.replaceChunks(v.id, d.slug, chunkRows);
      });
    }
    await this.d.ops.bumpKbVersion(author);
    await this.d.live.rebuild();
  }
}
