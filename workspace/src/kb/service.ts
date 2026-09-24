/**
 * Dịch vụ kho tri thức: Draft -> kiểm tra -> Publish (có duyệt hai người với luật bảo mật) -> Rollback.
 * Các bước kiểm tra chạy trước Publish để việc Admin tự nạp dữ liệu không làm lệch hành vi cũ.
 */
import type { Embedder } from "../core/embedding";
import { activeEmbedder, cosine, embedTagged } from "../core/embedding";
import { checkOutput, collectHosts, urlHosts } from "../core/gate";
import { buildIndex } from "../core/bundle";
import { GUIDE_SLUG, guidePolicyProblems, parseGuide, type Guide } from "../core/guide";
import { chunkEmbedText, parseKnowledgeDoc, sha1, type KnowledgeChunk } from "../core/knowledge";
import { makeEvaluator, type PredicateMap } from "../core/predicates";
import { detectKeyLeak } from "../core/sanitize";
import { parseTemplateFile, validateBundle } from "../core/templates";
import { compileItems, ITEM_TOPICS, itemsDocToYaml, parseItemsDoc, type ItemsDoc, type KnowledgeItem } from "../core/items";
import { chunkKey, hasValidDecision, itemKey, orderPair, templateHash, textHash, type PairDecisionKind } from "./pair-decisions";
import { applyReview, type ReviewInput } from "./review-import";
import { GROUP_TOPIC, migrateTemplates } from "./migrate-items";
import { containsPhrase, normalize, wordCount } from "../core/text";
import type { ParseIssue, Template } from "../domain/types";
import type { Db } from "../db/db";
import { kbRepo, type ConflictInput, type KbRepo, type VersionRow } from "../db/repo-kb";
import { opsRepo, type AdminRole, type OpsRepo } from "../db/repo-ops";
import { usableLlm, type LlmPort, type OverlapSide } from "../core/ports";
import { evalSettings, outcomeKey, routeOffline, runEval, type EvalCase } from "./eval";
import type { LiveContent } from "./live-content";
import { findOverlaps, narrowTemplateMatch, probesFromChunks, probesFromTemplates, replaceChunkSection, replaceTemplateAnswer, type OverlapPair, type OverlapRef, type ProbeItem } from "./overlap";
import { CONFUSION_FIX_HINT, confusionKey, confusionsOf, describeConfusion, findConfusions, withExampleCache, type Confusion } from "./routing-check";
import type { Evaluator } from "../core/predicates";
import { TemplateIndex } from "../core/template-index";

export type DocKind = "templates" | "knowledge" | "guide" | "items";
/** Tài liệu dịch ra template đang chạy: template soạn tay (cũ) và mục hỏi đáp (mới, src/core/items.ts). */
const compiled = (k: DocKind) => k === "templates" || k === "items";

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
  /** true = "Hướng dẫn AI làm việc": đổi cách AI phán đoán nên cần người thứ hai duyệt trước khi có hiệu lực */
  guide?: boolean;
  /** Cặp chồng lấn có cấu trúc (kb/overlap.ts) mà bước 3 vừa tính — trợ lý "Nạp nội dung mới" dùng lại để dựng các khung
   * xung đột trên màn hình, không cần quét lại. `undefined` với guide (không quét). */
  overlapPairs?: OverlapPair[];
  /** Mục hỏi đáp của bản nháp giành câu hỏi của đoạn tài liệu mà chưa có quyết định: Admin Web hiện nút "ghi nhận giữ nguyên" */
  hijacks?: ItemHijack[];
}

export interface ItemHijack {
  itemId: string;
  itemTitle: string;
  chunkId: string;
  doc: string;
  heading: string;
}

const needsSecondApproval = (r: ValidationReport): boolean => (r.securityRules?.length ?? 0) > 0 || r.guide === true;

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
  guide?: Guide;
  /** chỉ với kind "items": tài liệu chủ đề gốc (templates ở trên là bản đã dịch) */
  items?: ItemsDoc;
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
  /** false = không cần người thứ hai duyệt (cài đặt approval.second_person tắt) */
  secondApproval?: () => Promise<boolean>;
  /** Chỉ dùng SAU khi publish, để mô tả xung đột cho vài cặp điểm cao nhất (kb_conflicts) — không dùng ở bước 3 lúc kiểm tra bản nháp. */
  llm?: LlmPort;
}

export class KbService {
  constructor(private readonly d: KbServiceDeps) {}
  private now = () => (this.d.now ?? (() => new Date()))();

  // ---------------------------------------------------------------- phân tích
  parse(kind: DocKind, md: string, slugHint?: string): Parsed {
    if (kind === "guide") {
      const r = parseGuide(md);
      return { kind, slug: GUIDE_SLUG, title: r.guide?.title ?? slugHint ?? GUIDE_SLUG, templates: [], chunks: [], guide: r.guide, issues: r.issues };
    }
    if (kind === "knowledge") {
      const r = parseKnowledgeDoc(md, slugHint);
      return { kind, slug: r.doc?.slug ?? slugHint ?? "", title: r.doc?.title ?? slugHint ?? "", templates: [], chunks: r.doc?.chunks ?? [], issues: r.issues };
    }
    if (kind === "items") {
      const r = parseItemsDoc(md);
      return { kind, slug: slugHint ?? "", title: r.doc?.title ?? slugHint ?? "", templates: r.doc ? compileItems(r.doc) : [], chunks: [], issues: r.issues, items: r.doc };
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
    if ((input.kind === "guide") !== (input.slug === GUIDE_SLUG)) throw new KbError(`"Hướng dẫn AI làm việc" là tài liệu duy nhất, slug cố định: ${GUIDE_SLUG}`);
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
      requiresSecondApproval: needsSecondApproval(report),
    });
    return { version, report };
  }

  async updateDraft(versionId: number, md: string): Promise<ValidationReport> {
    const v = await this.mustVersion(versionId);
    if (v.status !== "draft" && v.status !== "rejected") throw new KbError("chỉ sửa được bản Draft");
    const doc = await this.d.kb.getDocument(v.slug);
    const report = await this.validateSource(v.slug, doc!.kind, md);
    await this.d.kb.updateVersion(versionId, { sourceMd: md, status: "draft", report, requiresSecondApproval: needsSecondApproval(report) });
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

    const liveRows = (await this.d.kb.loadPublishedTemplateRows()).filter((r) => !this.replacedBy(kind, parsed.templates, r)); // template cũ bản nháp sẽ thay chỗ: coi như đã không còn
    const others = liveRows.filter((r) => r.docSlug !== slug).map((r) => r.template);

    // 2. Quét an toàn
    const hosts = this.d.live.urlHosts;
    const safety: string[] = [];
    const warnings: string[] = [];
    const allTexts = compiled(kind) ? parsed.templates.flatMap((t) => Object.values(t.answers)) : kind === "guide" ? Object.values(parsed.guide?.sections ?? {}) : parsed.chunks.map((c) => c.text);
    for (const txt of allTexts) {
      if (detectKeyLeak(txt)) safety.push("nội dung chứa chuỗi giống private key / seed phrase");
      if (/<\s*script|javascript:|on\w+\s*=\s*["']/i.test(txt)) safety.push("nội dung chứa HTML/script");
      for (const h of urlHosts(txt)) if (hosts.size && !hosts.has(h)) warnings.push(`URL mới ngoài whitelist hiện tại: ${h} (người duyệt cần xác nhận)`);
    }
    for (const t of parsed.templates) {
      // `answer_from`: câu trả lời THẬT nằm ở template khác (vd các lối tắt esc-* dùng chung câu trả lời của fp-12-escalate),
      // template này CỐ Ý không có `<!-- answer:en -->` riêng. Kiểm ở đây (rỗng, quá dài, URL lạ) sẽ luôn báo sai — template
      // nguồn của answer_from đã được kiểm đầy đủ khi CHÍNH nó là một mục trong `parsed.templates`/`others`.
      if (t.answer_from) continue;
      const chk = checkOutput(Object.values(t.answers).join("\n"), { urlHostWhitelist: new Set([...hosts, ...collectHosts(Object.values(t.answers))]), maxChars: 4096 * Math.max(1, Object.keys(t.answers).length) });
      if (!chk.ok) safety.push(...chk.problems.map((p) => `[${t.id}] ${p}`));
      for (const [lang, text] of Object.entries(t.answers)) if (text.length > 4096) safety.push(`[${t.id}] bản ${lang} vượt 4096 ký tự (giới hạn Telegram)`);
    }
    steps.push({ name: "2. Quét an toàn", status: safety.length ? "error" : warnings.length ? "warning" : "ok", details: [...new Set([...safety, ...warnings])] });

    // Bộ tìm kiếm SAU khi đưa bản nháp lên (chỉ template): dùng cho bước 3 (hỏi thử bot) lẫn bước 5 (hồi quy), dựng một lần.
    let afterIdx: TemplateIndex | undefined;
    let afterEvaluator: Evaluator | undefined;
    const docOfLive = new Map(liveRows.map((r) => [r.template.id, r.docSlug]));

    // 3. Trùng lặp và mâu thuẫn (template và mục hỏi đáp)
    if (compiled(kind)) {
      const predicates = await this.predicateMap();
      const union = [...others, ...parsed.templates];
      afterEvaluator = makeEvaluator(predicates);
      afterIdx = await buildIndex({ templates: union, evaluator: afterEvaluator }, this.d.embedder);
      const cross = validateBundle(union, afterEvaluator.names()).filter((i) => i.level === "error");
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
      // Máy quét tìm nội dung GIỐNG CHỮ trong toàn kho (template lẫn đoạn tri thức), rồi HỎI THỬ bot để chỉ báo chỗ bot trả lời
      // nhầm thật (kb/routing-check.ts) — giống chữ mà bot vẫn phân biệt đúng thì không làm phiền người dùng.
      const pairs = await this.overlapPairs(probesFromTemplates(parsed.templates, slug), slug, liveRows);
      const docOfAfter = new Map([...docOfLive, ...parsed.templates.map((t) => [t.id, slug] as const)]);
      const check = await this.routingCheck(pairs, { draftIds: new Set(parsed.templates.map((t) => t.id)), afterIdx, afterEvaluator, docOf: docOfAfter });
      report.overlapPairs = check.pairs;
      // Mục hỏi đáp: xung đột phải được xử lý XONG trước khi publish (không chỉ cảnh báo như template cũ).
      const gate = kind === "items" ? await this.itemGate(parsed, others, afterIdx, check.confusions) : { messages: [], hijacks: [] };
      const blocking = gate.messages;
      if (gate.hijacks.length) report.hijacks = gate.hijacks;
      steps.push({ name: "3. Trùng và mâu thuẫn", status: dup.length || blocking.length ? "error" : conflictWarn.length || check.warn ? "warning" : "ok", details: [...dup, ...blocking, ...conflictWarn, ...check.details] });
    } else if (kind === "guide") {
      // Hướng dẫn không được CHO PHÉP điều hệ thống cấm (dự đoán giá, lộ công thức HCS, xin seed/mật khẩu, dùng kiến thức chung, bỏ qua luật)
      const bad = parsed.guide ? guidePolicyProblems(parsed.guide) : [];
      steps.push({ name: "3. Trùng và mâu thuẫn", status: bad.length ? "error" : "ok", details: bad });
    } else {
      // Tài liệu tri thức mới: so từng đoạn với template + đoạn tri thức đang publish bằng CHÍNH bộ tìm kiếm lúc chạy thật (kb/overlap.ts).
      // Sự cố thật: login-help (mới) bị lối tắt cũ esc-login-fail giành mất vì bước này trước đây không so tài liệu tri thức với template.
      const probes = probesFromChunks(parsed.chunks, slug);
      const pairs = await this.overlapPairs(probes, slug, liveRows);
      const check = this.d.live.index
        ? await this.routingCheck(pairs, { draftIds: new Set(), afterIdx: this.d.live.index, afterEvaluator: this.d.live.evaluator, docOf: docOfLive, draftChunks: probes.map((p) => ({ ref: p.ref, heading: p.ref.title })) })
        : { pairs, details: [], warn: false, confusions: [] as Confusion[] };
      report.overlapPairs = check.pairs;
      steps.push({ name: "3. Trùng và mâu thuẫn", status: check.warn ? "warning" : "ok", details: check.details });
    }

    // 4. Bản dịch
    const trans: string[] = [];
    if (compiled(kind)) {
      const langs = new Set(parsed.templates.flatMap((t) => Object.keys(t.answers)));
      langs.delete("en");
      for (const t of parsed.templates.filter((x) => x.response_mode !== "SECURITY_RULE")) {
        const missing = [...langs].filter((l) => !t.answers[l]);
        if (missing.length) trans.push(`[${t.id}] thiếu bản dịch ${missing.join(", ")} (sẽ được dịch một lần khi cần và chờ duyệt)`);
      }
    }
    // Câu mẫu (match.examples) là thứ được embedding để tìm theo ngữ nghĩa; thiếu hoặc chỉ chép lại từ khoá thì khách diễn đạt khác đi sẽ không tìm thấy
    const weak: string[] = [];
    if (kind === "templates") {
      for (const t of parsed.templates.filter((x) => x.response_mode === "EXACT_TEMPLATE" && (x.match.keywords.length || x.match.rules.length))) {
        const kw = new Set(t.match.keywords.map(normalize));
        const real = t.match.examples.filter((e) => !kw.has(normalize(e)) && wordCount(normalize(e)) >= 4);
        if (!t.match.examples.length) weak.push(`[${t.id}] không có câu mẫu (match.examples): chỉ tìm được khi khách dùng đúng từ khoá`);
        else if (!real.length) weak.push(`[${t.id}] câu mẫu chỉ chép lại từ khoá / quá ngắn: nên thêm 3-5 câu khách thật hay nhắn (đủ một câu, diễn đạt khác từ khoá)`);
      }
    }
    steps.push({ name: "4. Bản dịch", status: trans.length || weak.length ? "warning" : "ok", details: [...trans.slice(0, 20), ...weak.slice(0, 20)] });

    // 5. Hồi quy + 6. Replay (chỉ template)
    if (compiled(kind) && afterIdx && afterEvaluator) {
      const evaluator = afterEvaluator;
      const beforeIdx = this.d.live.index;
      const cases = await this.d.kb.listEvalCases();
      const settings = evalSettings(this.d.live.urlHosts);
      const before = beforeIdx ? await runEval(cases as EvalCase[], beforeIdx, this.d.live.evaluator, settings) : { rows: [], correct: 0, total: 0 };
      const after = await runEval(cases as EvalCase[], afterIdx, evaluator, settings);
      const changed = before.rows.map((b, i) => ({ q: b.question, before: b.got, after: after.rows[i]?.got ?? "?" })).filter((x) => x.before !== x.after).map((x) => ({ question: x.q, before: x.before, after: x.after }));
      report.regression = { total: cases.length, accuracyBefore: cases.length ? before.correct / cases.length : 1, accuracyAfter: cases.length ? after.correct / cases.length : 1, changed: changed.slice(0, 50) };
      // Chặn khi BẤT KỲ câu mẫu đang đúng trở thành sai, kể cả khi tổng độ chính xác không giảm (một câu khác được sửa đúng không bù được).
      const broken = before.rows.filter((b, i) => b.ok && after.rows[i] && !after.rows[i]!.ok).map((b) => b.question);
      const drop = broken.length > 0 || report.regression.accuracyAfter < report.regression.accuracyBefore - 1e-9;
      steps.push({ name: "5. Test hồi quy", status: drop ? "error" : changed.length ? "warning" : "ok", details: [`độ chính xác ${(report.regression.accuracyBefore * 100).toFixed(1)}% → ${(report.regression.accuracyAfter * 100).toFixed(1)}% trên ${cases.length} câu`, ...(broken.length ? [`${broken.length} câu đang ĐÚNG sẽ bị trả lời SAI: ${broken.slice(0, 5).map((q) => `"${q}"`).join(", ")}. Sửa bản nháp, hoặc nếu đây là thay đổi có chủ ý thì cập nhật đáp án kỳ vọng ở Bộ câu hỏi mẫu (có ghi nhật ký) rồi kiểm tra lại.`] : []), ...changed.slice(0, 10).map((c) => `"${c.question}": ${c.before} → ${c.after}`)] });

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
      const na = kind === "guide" ? "hướng dẫn AI: không áp dụng (tầng 0-1 không dùng AI)" : "tài liệu tri thức: không áp dụng";
      steps.push({ name: "5. Test hồi quy", status: "ok", details: [na] });
      steps.push({ name: "6. Replay tin nhắn thật (14 ngày)", status: "ok", details: [na] });
      if (kind === "guide") report.guide = true;
    }

    report.ok = steps.every((s) => s.status !== "error");
    return report;
  }

  /** Ngưỡng độ giống để đưa một mục đang publish vào danh sách HỎI THỬ lúc kiểm bản nháp (cao hơn 0.55 của quét toàn kho: giữ
   * lời gọi ít và giữ tín hiệu từ khoá — điểm bằng ngưỡng — đủ mạnh để cho ra cụm "Gỡ máy móc"). Câu của CHÍNH bản nháp bị trả lời
   * nhầm sang bất kỳ mục nào thì vẫn luôn bị bắt, không phụ thuộc ngưỡng này. */
  private static readonly DRAFT_OVERLAP_MIN = 0.7;
  /** Tối đa bao nhiêu câu nhầm được liệt kê chi tiết ở bước 3 — nhiều hơn là một cục chữ không ai đọc hết được. */
  private static readonly DRAFT_CONFUSION_TOP = 8;

  /**
   * Ứng viên chồng lấn của bản nháp với TOÀN BỘ kho đang publish (kb/overlap.ts, chỉ CODE). Đây chỉ là danh sách nội bộ
   * "giống chữ" để biết cần HỎI THỬ những mục nào — không hiện thẳng cho người dùng (xem `routingCheck`).
   */
  private async overlapPairs(probes: ProbeItem[], slug: string, liveRows: { docSlug: string; template: Template }[]): Promise<OverlapPair[]> {
    const index = this.d.live.index as typeof this.d.live.index | undefined;
    if (!probes.length || !index) return [];
    try {
      const docOf = new Map(liveRows.map((r) => [r.template.id, r.docSlug]));
      const pairs = await findOverlaps({ index, kb: this.d.kb, embedder: this.d.embedder, docOf }, probes, { excludeDoc: slug, maxPairs: 40, minScore: KbService.DRAFT_OVERLAP_MIN });
      // template cũ bị bản nháp mục hỏi đáp thay chỗ (không có trong liveRows) không còn là "mục khác" để so
      const gone = (r: OverlapRef) => r.kind === "template" && r.doc !== slug && !docOf.has(r.id);
      return pairs.filter((p) => !gone(p.a) && !gone(p.b));
    } catch {
      return [];
    }
  }

  /**
   * HỎI THỬ bot (kb/routing-check.ts) trước và sau khi đưa bản nháp lên, trên các mục của bản nháp + các mục giống chữ với
   * nó. Chỉ báo chỗ bot SẼ trả lời nhầm do bản nháp này gây ra, viết thành câu dễ hiểu (câu nào, của mục nào, bị trả lời bằng
   * mục nào). Cặp chỉ giống chữ mà bot vẫn trả lời đúng gộp thành MỘT dòng "không cần sửa". Chỉ cảnh báo, không chặn Publish
   * — admin quyết (xem `syncConflictsAfterPublish`: nếu vẫn Publish, chỗ nhầm được ghi lại để hiện trên danh sách Tài liệu).
   */
  private async routingCheck(
    pairs: OverlapPair[],
    ctx: { draftIds: Set<string>; afterIdx: TemplateIndex; afterEvaluator: Evaluator; docOf: Map<string, string>; draftChunks?: { ref: OverlapRef; heading: string }[] },
  ): Promise<{ pairs: OverlapPair[]; details: string[]; warn: boolean; confusions: Confusion[] }> {
    const settings = evalSettings(this.d.live.urlHosts);
    const draftChunkIds = new Set((ctx.draftChunks ?? []).map((c) => c.ref.id));
    const partnerIds = new Set(pairs.flatMap((p) => [p.a, p.b]).filter((r) => r.kind === "template").map((r) => r.id));
    // Từ khoá của bản nháp nằm trong câu của mục khác => mục đó có thể bị giành câu hỏi (vd từ khoá quá chung "KYC" giành
    // "how to KYC"), dù hai mục không giống chữ đủ để vào danh sách trên — cũng phải được hỏi thử.
    const draftKeywords = [...ctx.draftIds].flatMap((id) => ctx.afterIdx.get(id)?.match.keywords ?? []).map(normalize).filter(Boolean);
    for (const t of ctx.afterIdx.templates) {
      if (ctx.draftIds.has(t.id) || partnerIds.has(t.id)) continue;
      const phrases = [...t.match.examples, ...t.match.keywords, ...t.match.exact].map(normalize);
      if (draftKeywords.some((k) => phrases.some((p) => containsPhrase(p, k)))) partnerIds.add(t.id);
    }
    const ids = new Set([...ctx.draftIds, ...partnerIds]);
    const liveChunks = [...new Map(pairs.flatMap((p) => [p.a, p.b]).filter((r) => r.kind === "chunk" && !draftChunkIds.has(r.id)).map((r) => [r.id, { ref: r, heading: r.title }])).values()];
    let after: Confusion[] = [];
    let before: Confusion[] = [];
    try {
      after = await findConfusions(ctx.afterIdx, ctx.afterEvaluator, this.d.embedder, settings, { onlyIds: ids, docOf: ctx.docOf, chunks: [...(ctx.draftChunks ?? []), ...liveChunks] });
      const beforeIdx = this.d.live.index as TemplateIndex | undefined;
      if (beforeIdx) before = await findConfusions(beforeIdx, this.d.live.evaluator, this.d.embedder, settings, { onlyIds: ids, docOf: ctx.docOf, chunks: liveChunks });
    } catch {
      /* không hỏi thử được: vẫn còn bước 5 (hồi quy) và 6 (replay) bắt lỗi định tuyến */
    }
    const beforeKeys = new Set(before.map(confusionKey));
    const fresh = after.filter((c) => !beforeKeys.has(confusionKey(c)));
    const old = after.filter((c) => beforeKeys.has(confusionKey(c)));
    const titleOf = (id: string) => ctx.afterIdx.get(id)?.sets_context.issue ?? id;

    const annotated: OverlapPair[] = pairs.map((p) => ({ ...p, confusions: confusionsOf(p, after) }));
    // chỗ nhầm không nằm trong cặp giống chữ nào (vd từ khoá quá chung giành câu của một mục không giống chữ): vẫn phải hiện
    for (const c of after) {
      if (annotated.some((p) => p.confusions!.includes(c))) continue;
      const t = ctx.afterIdx.get(c.got)!;
      annotated.push({ a: c.owner, b: { kind: "template", id: t.id, doc: ctx.docOf.get(t.id) ?? "", title: `${t.group} — ${titleOf(t.id)}` }, score: 0, signals: [], confusions: [c] });
    }
    annotated.sort((x, y) => Number(!!y.confusions!.length) - Number(!!x.confusions!.length) || y.score - x.score);

    const details: string[] = [];
    for (const c of fresh.slice(0, KbService.DRAFT_CONFUSION_TOP)) details.push(`⚠ ${describeConfusion(c, titleOf, "sẽ")}`);
    if (fresh.length > KbService.DRAFT_CONFUSION_TOP) details.push(`... và ${fresh.length - KbService.DRAFT_CONFUSION_TOP} câu nữa bị trả lời nhầm tương tự.`);
    const near = annotated.filter((p) => p.updateHint);
    for (const p of near.slice(0, 3)) details.push(`⚠ Đoạn "${p.a.title}" gần như trùng nguyên văn với đoạn "${p.b.title}" của tài liệu ${p.b.doc}. ${p.updateHint}`);
    if (old.length) details.push(`Đã có từ trước (không do bản này gây ra): ${old.slice(0, 3).map((c) => describeConfusion(c, titleOf)).join(" ")}`);
    if (fresh.length || old.length) details.push(CONFUSION_FIX_HINT);
    const quiet = annotated.filter((p) => !p.confusions!.length && !p.updateHint).length;
    if (quiet) details.push(`${quiet} mục khác chỉ giống chữ với nội dung này — đã hỏi thử, bot vẫn trả lời đúng mục của từng câu, không cần sửa.`);
    return { pairs: annotated, details, warn: fresh.length > 0 || near.length > 0, confusions: after };
  }

  /**
   * Luật CHẶN PUBLISH riêng của mục hỏi đáp (src/core/items.ts): mọi xung đột dữ liệu phải được xử lý xong trước khi áp dụng —
   * không chỉ cảnh báo như template cũ. Trả về các dòng lỗi viết cho người không rành kỹ thuật (có cách xử lý kèm theo).
   *  1. Cụm nhận biết trùng với mục ở tài liệu khác.
   *  2. "Khác với mục X" trỏ tới mục không tồn tại.
   *  3. Hỏi thử bot: câu hỏi của mục này bị trả lời bằng mục khác / khớp ngang hàng với mục khác, mà hai mục CHƯA khai báo là
   *     khác nhau (kèm câu hỏi lại khách) — khai báo rồi thì hợp lệ: khi mơ hồ, bot hỏi lại khách thay vì đoán.
   *  4. Hỏi thử bot: câu hỏi về một đoạn tài liệu bị mục hỏi đáp này giành mất, mà chưa có quyết định còn hiệu lực
   *     (kb_pair_decisions — hết hiệu lực khi một trong hai bên đổi nội dung).
   */
  private async itemGate(parsed: Parsed, others: Template[], afterIdx: TemplateIndex, confusions: Confusion[]): Promise<{ messages: string[]; hijacks: ItemHijack[] }> {
    const out: string[] = [];
    const hijacks: ItemHijack[] = [];
    const draft = parsed.templates.filter((t) => t.item && t.item.step === 0);
    const draftIds = new Set(parsed.templates.map((t) => t.id));
    const meta = (id: string) => afterIdx.get(id)?.item;
    const titleOf = (id: string) => meta(id)?.title ?? afterIdx.get(id)?.sets_context.issue ?? id;
    const name = (id: string) => `"${titleOf(id)}"`;

    const phraseOwner = new Map<string, string>();
    for (const t of others) for (const k of t.match.keywords) phraseOwner.set(normalize(k), t.id);
    for (const t of draft)
      for (const k of t.match.keywords) {
        const o = phraseOwner.get(normalize(k));
        if (o && o !== t.id) out.push(`Cụm nhận biết "${k}" của mục ${name(t.id)} trùng với mục ${name(o)} — mỗi cụm chỉ được thuộc một mục.`);
      }

    for (const t of draft) for (const d of t.item!.distinct_from) if (!afterIdx.get(d.item)) out.push(`Mục ${name(t.id)} khai báo khác với "${d.item}" nhưng không có mục nào mã này.`);

    const linked = (a: string, b: string) => !!(meta(a)?.distinct_from.some((d) => d.item === b) || meta(b)?.distinct_from.some((d) => d.item === a));
    const hijack = confusions.some((c) => c.owner.kind === "chunk");
    const decisions = hijack ? await this.d.kb.listPairDecisions() : [];
    const chunkRows = new Map(hijack ? (await this.d.kb.listPublishedChunks()).map((c) => [c.chunkId, c]) : []);
    for (const c of confusions) {
      const touchesDraft = draftIds.has(c.got) || (c.owner.kind === "template" && draftIds.has(c.owner.id));
      if (!touchesDraft) continue;
      if (c.owner.kind === "template") {
        if (linked(c.owner.id, c.got)) continue;
        out.push(`${describeConfusion(c, titleOf, "sẽ")} Cần xử lý: nếu hai mục là một tình huống thì gộp lại; nếu là hai tình huống khác nhau thì khai báo "khác với" ở một trong hai mục, ghi khác nhau ở điểm nào và câu hỏi lại khách.`);
      } else {
        const chunk = chunkRows.get(c.owner.id);
        const heading = chunk?.heading ?? c.owner.title;
        const got = afterIdx.get(c.got);
        if (got && hasValidDecision(decisions, { key: itemKey(c.got), hash: templateHash(got) }, { key: chunkKey(c.owner.doc, heading), hash: textHash(chunk?.text ?? "") })) continue;
        if (!hijacks.some((h) => h.itemId === c.got && h.chunkId === c.owner.id)) hijacks.push({ itemId: c.got, itemTitle: titleOf(c.got), chunkId: c.owner.id, doc: c.owner.doc, heading });
        out.push(`${describeConfusion(c, titleOf, "sẽ")} Cần xử lý: sửa cách hỏi / cụm nhận biết của mục ${name(c.got)} để câu hỏi về đoạn tài liệu này tới được tài liệu, hoặc ghi nhận quyết định giữ nguyên có chủ ý.`);
      }
    }
    return { messages: [...new Set(out)], hijacks };
  }

  // ---------------------------------------------------------------- mục hỏi đáp (Admin Web dạng form)
  /** Template cũ (tài liệu "templates") sẽ bị mục hỏi đáp của bản nháp thay chỗ khi publish (cùng mã) — xem loadPublishedTemplateRows. */
  private replacedBy(kind: DocKind, draft: Template[], row: { kind: string; template: Template }): boolean {
    return kind === "items" && row.kind === "templates" && draft.some((t) => t.id === row.template.id);
  }


  /** Mỗi chủ đề là một tài liệu loại "items", slug cố định theo chủ đề. */
  static itemsSlug = (topic: string) => `items-${topic}`;

  /** Bản mới nhất CÒN SỬA ĐƯỢC của một tài liệu mục hỏi đáp: bản nháp nếu có, không thì bản đang chạy, không thì tài liệu rỗng. */
  async editableItems(slug: string, topicHint?: string): Promise<{ doc: ItemsDoc; draft?: VersionRow; published?: VersionRow; pending?: VersionRow }> {
    const versions = await this.d.kb.listVersions(slug);
    const latest = versions[0];
    const published = versions.find((v) => v.status === "published");
    const draft = latest && (latest.status === "draft" || latest.status === "rejected") ? latest : undefined;
    const pending = latest?.status === "pending_approval" ? latest : undefined;
    const base = draft ?? pending ?? published;
    const topic = topicHint ?? slug.replace(/^items-/, "");
    const doc = base ? parseItemsDoc(base.source_md).doc : undefined;
    return { doc: doc ?? { topic, title: ITEM_TOPICS[topic] ?? topic, items: [] }, draft, published, pending };
  }

  /**
   * Toàn bộ nội dung bot đang dùng, cho MỘT danh sách duy nhất ở Kho tri thức: câu trả lời (mục hỏi đáp và template cũ chưa
   * chuyển, gom theo chủ đề) và đoạn tài liệu tham khảo (gom theo tài liệu), cùng các bản nháp đang chờ xử lý. Người dùng không
   * cần biết nội dung nằm ở loại tài liệu nào.
   */
  async listContent() {
    const index = this.d.live.index as TemplateIndex;
    const docs = await this.d.kb.listDocuments();
    const docTitle = new Map(docs.map((d) => [d.slug, d.kind === "items" ? ITEM_TOPICS[d.slug.replace(/^items-/, "")] ?? d.title : d.title]));
    const rows = await this.d.kb.loadPublishedTemplateRows();
    const docOf = new Map(rows.map((r) => [r.template.id, r.docSlug]));
    const topics = new Map<string, { topic: string; title: string; answers: unknown[] }>();
    for (const [topic, title] of Object.entries(ITEM_TOPICS)) topics.set(topic, { topic, title, answers: [] });
    for (const t of index.templates) {
      if (t.item && t.item.step > 0) continue; // bước sau của một mục: hiện cùng mục đó
      const topic = t.item?.topic ?? GROUP_TOPIC[t.group] ?? "general";
      const kind = t.item?.kind ?? (index.isEscalateShortcut(t.id) ? "handoff" : t.response_mode !== "EXACT_TEMPLATE" || ["System", "AntiSpam", "Security", "Image", "FollowUp"].includes(t.group) ? "system" : "answer");
      const steps = t.item ? index.templates.filter((x) => x.item?.id === t.item!.id).sort((a, b) => a.item!.step - b.item!.step).map((x) => index.resolveAnswerSource(x).answers.en ?? "") : [index.resolveAnswerSource(t).answers.en ?? ""];
      topics.get(topic)!.answers.push({
        key: `item:${t.id}`,
        id: t.id,
        title: t.item?.title ?? t.sets_context.issue ?? t.id,
        kind,
        converted: !!t.item,
        docSlug: docOf.get(t.id) ?? null,
        docTitle: docTitle.get(docOf.get(t.id) ?? "") ?? null,
        questions: t.match.examples,
        appliesWhen: t.item?.applies_when ?? null,
        steps,
        handoff: kind === "handoff",
      });
    }
    const chunks = await this.d.kb.listPublishedChunks();
    const documents = new Map<string, { slug: string; title: string; sections: unknown[] }>();
    for (const c of chunks) {
      if (!documents.has(c.docSlug)) documents.set(c.docSlug, { slug: c.docSlug, title: docTitle.get(c.docSlug) ?? c.docSlug, sections: [] });
      documents.get(c.docSlug)!.sections.push({ key: chunkKey(c.docSlug, c.heading), chunkId: c.chunkId, heading: c.heading, text: c.text, url: c.url ?? null });
    }
    const pending = [];
    for (const d of docs) {
      if (d.kind === "guide") continue;
      const latest = (await this.d.kb.listVersions(d.slug))[0];
      if (!latest || !["draft", "rejected", "pending_approval"].includes(latest.status)) continue;
      const rep = latest.report as ValidationReport | null;
      const title = d.kind === "items" ? ITEM_TOPICS[d.slug.replace(/^items-/, "")] ?? d.title : d.title; // tên chủ đề, không phải mã tài liệu
      pending.push({ slug: d.slug, title, versionId: latest.id, version: latest.version, status: latest.status, ok: !!rep?.ok, author: latest.author, createdAt: latest.created_at });
    }
    return { topics: [...topics.values()].filter((t) => t.answers.length), documents: [...documents.values()], pending, kbVersion: this.d.live.version };
  }

  /**
   * Nội dung của một phiên bản, viết cho người đọc (không Markdown/YAML): từng câu trả lời / đoạn tài liệu, đánh dấu so với bản
   * đang chạy của cùng tài liệu — mới, thay đổi, giữ nguyên, bị bỏ. Người duyệt xem bản nháp định đổi gì trước khi publish.
   */
  async versionUnits(v: VersionRow, kind: DocKind) {
    if (kind === "guide") return [];
    const published = v.status === "published" ? undefined : (await this.d.kb.listVersions(v.slug)).find((x) => x.status === "published");
    const unitsOf = (md: string) => {
      const p = this.parse(kind, md, v.slug);
      if (kind === "knowledge") return p.chunks.map((c) => ({ key: `chunk:${v.slug}#${c.heading}`, kind: "document" as const, title: c.heading, questions: [] as string[], steps: [c.text], sig: c.text }));
      const byItem = new Map<string, Template[]>();
      for (const t of p.templates) {
        const id = t.item?.id ?? t.id;
        byItem.set(id, [...(byItem.get(id) ?? []), t]);
      }
      return [...byItem.entries()].map(([id, ts]) => {
        const first = ts.find((t) => !t.item || t.item.step === 0) ?? ts[0]!;
        const steps = ts.sort((a, b) => (a.item?.step ?? 0) - (b.item?.step ?? 0)).map((t) => t.answers.en ?? (t.answer_from ? "(câu chuyển nhân viên chuẩn)" : ""));
        return { key: `item:${id}`, kind: (first.item?.kind ?? "answer") as string, title: first.item?.title ?? first.sets_context.issue ?? id, questions: first.match.examples, steps, sig: JSON.stringify([first.match.examples, first.match.keywords, steps, first.item?.applies_when, first.item?.distinct_from]) };
      });
    };
    const now = unitsOf(v.source_md);
    const before = published ? new Map(unitsOf(published.source_md).map((u) => [u.key, u])) : new Map();
    const out = now.map(({ sig, ...u }) => ({ ...u, change: !published ? "new" : !before.has(u.key) ? "new" : before.get(u.key)!.sig === sig ? "same" : "changed" }));
    const nowKeys = new Set(now.map((u) => u.key));
    for (const [key, u] of before) if (!nowKeys.has(key)) out.push({ key, kind: u.kind, title: u.title, questions: u.questions, steps: u.steps, change: "removed" });
    return out;
  }

  /**
   * Sửa một tài liệu mục hỏi đáp: đọc bản còn sửa được (nháp, không thì bản đang chạy), áp `mutate`, lưu thành bản nháp và chạy đủ
   * các bước kiểm tra. Mọi thay đổi nội dung đều đi qua đây (nạp nội dung mới, sửa trong khung xung đột, áp quyết định của khách).
   */
  async mutateItemsDoc(slug: string, topic: string, mutate: (doc: ItemsDoc) => void, author: Actor): Promise<{ versionId: number; report: ValidationReport; doc: ItemsDoc }> {
    const e = await this.editableItems(slug, topic);
    if (e.pending) throw new KbError(`chủ đề "${e.doc.title}" đang có bản chờ người thứ hai duyệt — duyệt hoặc từ chối bản đó trước`, 409);
    const doc = structuredClone(e.doc);
    mutate(doc);
    const md = itemsDocToYaml(doc);
    if (e.draft) return { versionId: e.draft.id, report: await this.updateDraft(e.draft.id, md), doc };
    const r = await this.createDraft({ slug, kind: "items", title: doc.title, md, author });
    return { versionId: r.version.id, report: r.report, doc };
  }

  /**
   * "Thêm nội dung": các mục hỏi đáp AI vừa tách từ văn bản người dùng đưa vào -> thêm vào bản nháp của đúng chủ đề.
   * `target` = mục đang có mà người dùng muốn thay bằng nội dung mới: giữ mã, thay câu trả lời, gộp thêm cách hỏi.
   * Trả về các bản nháp đã tạo/cập nhật và mã các mục mới (để tìm quan hệ của riêng phần mới).
   */
  async addIntakeItems(entries: { topic: string; item: KnowledgeItem }[], author: Actor, target?: string) {
    const byTopic = new Map<string, KnowledgeItem[]>();
    for (const e of entries) byTopic.set(e.topic, [...(byTopic.get(e.topic) ?? []), e.item]);
    if (target) {
      // sửa mục có sẵn: nội dung mới thay câu trả lời của đúng mục đó, dù AI xếp chủ đề nào
      const rows = await this.d.kb.loadPublishedTemplateRows();
      const row = rows.find((r) => r.template.id === target);
      const topic = row?.template.item?.topic ?? GROUP_TOPIC[row?.template.group ?? ""] ?? entries[0]?.topic ?? "general";
      const fresh = entries[0]?.item;
      if (!fresh) throw new KbError("AI không tách được nội dung trả lời từ văn bản này");
      const r = await this.mutateItemsDoc(KbService.itemsSlug(topic), topic, (doc) => {
        let cur = doc.items.find((i) => i.id === target);
        if (!cur && row && !row.template.item) {
          // template cũ chưa chuyển: tạo mục cùng mã (mục hỏi đáp thay chỗ template cũ khi publish)
          cur = migrateTemplates([row.template]).docs[0]?.items[0];
          if (cur) doc.items.push(cur);
        }
        if (!cur) throw new KbError(`không tìm thấy nội dung đang sửa: ${target}`, 404);
        if (cur.kind === "system") throw new KbError("tin hệ thống do code gửi: nội dung giữ nguyên từng chữ, không sửa qua đây");
        const seen = new Set(cur.questions.map(normalize));
        for (const q of fresh.questions) if (!seen.has(normalize(q))) (cur.questions.push(q), seen.add(normalize(q)));
        if (cur.kind === "answer") {
          if (!cur.steps.length) cur.steps.push({ say: {} });
          cur.steps[0]!.say = { ...fresh.steps[0]!.say }; // câu gốc đổi: bản dịch cũ không còn đúng
        }
      }, author);
      return { drafts: [{ topic, slug: KbService.itemsSlug(topic), ...r }], newIds: [target] };
    }
    const taken = new Set((await this.d.kb.loadPublishedTemplateRows()).map((r) => r.template.id.replace(/--b\d+$/, "")));
    const drafts: { topic: string; slug: string; versionId: number; report: ValidationReport; doc: ItemsDoc }[] = [];
    const newIds: string[] = [];
    for (const [topic, items] of byTopic) {
      const r = await this.mutateItemsDoc(KbService.itemsSlug(topic), topic, (doc) => {
        for (const x of doc.items) taken.add(x.id);
        for (const it of items) {
          const base = it.id || "muc";
          let id = base;
          for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
          taken.add(id);
          newIds.push(id);
          doc.items.push({ ...it, id, source: `intake:${author.label}` });
        }
      }, author);
      drafts.push({ topic, slug: KbService.itemsSlug(topic), ...r });
    }
    return { drafts, newIds };
  }

  /**
   * Quan hệ của RIÊNG phần nội dung mới với toàn kho (kể cả mục cùng chủ đề — `overlapPairs` của bước kiểm tra chỉ so với tài
   * liệu khác), để dựng các khung "cần bạn quyết" ở màn hình Thêm nội dung. Như bước kiểm tra: tìm cặp giống nhau, rồi HỎI THỬ
   * bot trên bộ nội dung sau khi đưa bản nháp `draftTemplates` lên (routing-check) — cặp nào bot trả lời nhầm thật mang theo
   * `confusions`, và chỗ nhầm không nằm trong cặp giống chữ nào cũng được thêm vào. Không gọi AI.
   */
  async relationsForNew(templates: Template[], slug: string, draftTemplates: Template[] = templates): Promise<OverlapPair[]> {
    const index = this.d.live.index as TemplateIndex | undefined;
    if (!templates.length || !index) return [];
    const ids = new Set(templates.map((t) => t.id));
    const touchesNew = (p: OverlapPair) => [p.a, p.b].some((r) => r.kind === "template" && ids.has(r.id));
    try {
      const rows = await this.d.kb.loadPublishedTemplateRows();
      const found = await findOverlaps({ index, kb: this.d.kb, embedder: this.d.embedder, docOf: new Map(rows.map((r) => [r.template.id, r.docSlug])) }, probesFromTemplates(templates, slug), { maxPairs: 40, minScore: KbService.DRAFT_OVERLAP_MIN });
      // bỏ cặp "mục mới ↔ chính nó" (sửa mục có sẵn) và cặp giữa hai mục mới với nhau
      const pairs = found.filter((p) => !(p.a.kind === "template" && p.b.kind === "template" && ((ids.has(p.a.id) && ids.has(p.b.id)) || p.a.id === p.b.id)));
      const liveRows = rows.filter((r) => r.docSlug !== slug && !this.replacedBy("items", draftTemplates, r));
      const afterEvaluator = makeEvaluator(await this.predicateMap());
      const afterIdx = await buildIndex({ templates: [...liveRows.map((r) => r.template), ...draftTemplates], evaluator: afterEvaluator }, this.d.embedder);
      const docOf = new Map([...liveRows.map((r) => [r.template.id, r.docSlug] as const), ...draftTemplates.map((t) => [t.id, slug] as const)]);
      const check = await this.routingCheck(pairs, { draftIds: ids, afterIdx, afterEvaluator, docOf });
      return check.pairs.filter(touchesNew);
    } catch {
      return [];
    }
  }

  /**
   * "Thử hỏi bot": câu này sẽ được trả lời bằng mục nào — trên bộ đang chạy, hoặc trên bộ SAU KHI đưa bản nháp `versionId` lên.
   * Chỉ tầng không dùng AI (luật, cụm từ, so nghĩa) + các mục gần nghĩa nhất mà AI sẽ được chọn trong đó. Không gọi AI.
   */
  async tryQuestion(question: string, versionId?: number) {
    let index = this.d.live.index as TemplateIndex;
    let evaluator = this.d.live.evaluator;
    if (versionId) {
      const v = await this.mustVersion(versionId);
      const doc = await this.d.kb.getDocument(v.slug);
      if (!doc || !compiled(doc.kind)) throw new KbError("chỉ thử được với bản nháp mục hỏi đáp / template");
      const parsed = this.parse(doc.kind, v.source_md, v.slug);
      const union = [...(await this.d.kb.loadPublishedTemplateRows()).filter((r) => r.docSlug !== v.slug && !this.replacedBy(doc.kind, parsed.templates, r)).map((r) => r.template), ...parsed.templates];
      evaluator = makeEvaluator(await this.predicateMap());
      // vector câu mẫu: dùng lại của bộ đang chạy (cùng câu), rồi bộ nhớ đệm embedding; chỉ embed câu thật sự mới
      const vecByText = new Map<string, number[]>();
      for (const t of index.templates) {
        const vs = index.vectorsOf(t.id);
        if (vs.length === t.match.examples.length) t.match.examples.forEach((ex, i) => vecByText.set(ex, vs[i]!));
      }
      const model = index.vectorsModel;
      const missing = [...new Set(union.flatMap((t) => t.match.examples).filter((ex) => !vecByText.has(ex)))];
      if (model && missing.length) {
        const cached = await this.d.kb.getEmbeddings(missing.map((ex) => sha1(ex)), model);
        for (const ex of missing) if (cached.has(sha1(ex))) vecByText.set(ex, cached.get(sha1(ex))!);
        const todo = missing.filter((ex) => !vecByText.has(ex));
        if (todo.length) {
          try {
            const t = await embedTagged(this.d.embedder, todo);
            if (t.model === model) {
              todo.forEach((ex, i) => vecByText.set(ex, t.vectors[i]!));
              await this.d.kb.putEmbeddings(todo.map((ex, i) => ({ hash: sha1(ex), vector: t.vectors[i]! })), model);
            }
          } catch {
            /* không embed được: mục mới chỉ tìm được bằng cụm nhận biết */
          }
        }
      }
      const vectors = new Map<string, number[][]>();
      for (const t of union) {
        const vs = t.match.examples.map((ex) => vecByText.get(ex));
        if (vs.length && vs.every(Boolean)) vectors.set(t.id, vs as number[][]);
      }
      index = withExampleCache(new TemplateIndex(union, evaluator, undefined, vectors, index.vectorsModel), evaluator, this.d.embedder);
    }
    const r = await routeOffline(question, null, index, evaluator, evalSettings(this.d.live.urlHosts));
    const titleOf = (id: string) => index.get(id)?.item?.title ?? index.get(id)?.sets_context.issue ?? id;
    const o = r.outcome;
    const tid = o.kind === "TEMPLATE" ? o.templateId : undefined;
    const t = tid ? index.get(tid) : undefined;
    const suggestions = (await index.suggest(question, 5)).map((s) => ({ id: s.templateId, title: titleOf(s.templateId), score: s.score }));
    return {
      result: o.kind,
      itemId: tid ?? null,
      title: tid ? titleOf(tid) : null,
      answer: t ? (index.resolveAnswerSource(t).answers.en ?? null) : null,
      via: o.kind === "TEMPLATE" ? o.via : o.kind === "ESCALATE" ? o.reason : null,
      ranked: r.trace.ranked.map((x) => ({ id: x.templateId, title: titleOf(x.templateId) })),
      suggestions,
    };
  }

  /**
   * Áp file rà soát khách hàng trả về (đã đọc thành `input`) lên bản sửa được của MỌI chủ đề mục hỏi đáp: chủ đề nào đổi thì
   * lưu thành bản nháp (chạy đủ kiểm tra). Quyết định "giữ nguyên" cho cặp mục ↔ đoạn tài liệu được lưu gắn với nội dung của
   * bản nháp vừa tạo. Không publish. Sửa đoạn tài liệu tham khảo chỉ được liệt kê (sửa ở tài liệu gốc).
   */
  async applyReviewToDrafts(input: ReviewInput, author: Actor) {
    const topics = Object.keys(ITEM_TOPICS);
    const before = new Map<string, { slug: string; yaml: string; pending: boolean }>();
    const docs: ItemsDoc[] = [];
    for (const topic of topics) {
      const slug = KbService.itemsSlug(topic);
      if (!(await this.d.kb.getDocument(slug))) continue;
      const e = await this.editableItems(slug, topic);
      before.set(topic, { slug, yaml: itemsDocToYaml(e.doc), pending: !!e.pending });
      docs.push(e.doc);
    }
    if (!docs.length) throw new KbError("chưa có chủ đề mục hỏi đáp nào — chuyển dữ liệu cũ sang trước (scripts/migrate-to-items.ts)");
    const res = applyReview(docs, input);
    const drafts: { topic: string; title: string; versionId: number; ok: boolean }[] = [];
    const todo = [...res.todo];
    for (const d of res.docs) {
      const b = before.get(d.topic)!;
      const yaml = itemsDocToYaml(d);
      if (yaml === b.yaml) continue;
      if (b.pending) {
        todo.push(`chủ đề "${d.title}" đang có bản chờ duyệt — thay đổi của chủ đề này chưa được lưu, duyệt/từ chối bản đó rồi nhập lại file`);
        continue;
      }
      const e = await this.editableItems(b.slug, d.topic);
      const r = e.draft ? { id: e.draft.id, report: await this.updateDraft(e.draft.id, yaml) } : await this.createDraft({ slug: b.slug, kind: "items", title: d.title, md: yaml, author }).then((x) => ({ id: x.version.id, report: x.report }));
      drafts.push({ topic: d.topic, title: d.title, versionId: r.id, ok: r.report.ok });
    }
    // quyết định cặp mục ↔ đoạn tài liệu: gắn với nội dung hiện tại của bản nháp (hoặc bản đang chạy) và của đoạn
    const chunks = await this.d.kb.listPublishedChunks();
    const compiledNow = new Map(res.docs.flatMap((d) => compileItems(d)).map((t) => [t.id, t]));
    let saved = 0;
    for (const pd of res.pairDecisions) {
      const sides = [pd.a, pd.b].map((k) => {
        if (k.startsWith("item:")) {
          const t = compiledNow.get(k.slice(5));
          return t ? { key: itemKey(t.id), hash: templateHash(t) } : undefined;
        }
        const c = chunks.find((x) => chunkKey(x.docSlug, x.heading) === k);
        return c ? { key: k, hash: textHash(c.text) } : undefined;
      });
      if (!sides[0] || !sides[1]) {
        todo.push(`${pd.from}: không tìm thấy một trong hai bên để lưu quyết định`);
        continue;
      }
      await this.d.kb.savePairDecision({ ...orderPair(sides[0], sides[1]), decision: pd.decision, note: pd.note, decidedBy: `${author.label} (file rà soát, ${pd.from})` });
      saved++;
    }
    // bản nháp đã kiểm tra TRƯỚC khi lưu quyết định cặp: kiểm tra lại để các chặn "giành đoạn tài liệu" đã quyết được gỡ
    if (saved) for (const d of drafts) d.ok = (await this.revalidate(d.versionId)).ok;
    return { drafts, applied: res.applied, todo, chunkChanges: res.chunkChanges, decisionsSaved: saved };
  }

  /** Ghi nhận quyết định cho cặp mục hỏi đáp (trong bản nháp `versionId`) ↔ đoạn tài liệu đang chạy, gắn với nội dung hiện tại của hai bên. */
  async decideItemChunk(input: { versionId: number; itemId: string; chunkId: string; decision: PairDecisionKind; note?: string }, author: Actor): Promise<ValidationReport> {
    const v = await this.mustVersion(input.versionId);
    const doc = await this.d.kb.getDocument(v.slug);
    if (doc?.kind !== "items") throw new KbError("chỉ áp dụng cho bản nháp mục hỏi đáp");
    const t = this.parse("items", v.source_md, v.slug).templates.find((x) => x.id === input.itemId);
    const chunk = (await this.d.kb.listPublishedChunks()).find((c) => c.chunkId === input.chunkId);
    if (!t || !chunk) throw new KbError("không tìm thấy mục hoặc đoạn tài liệu", 404);
    const p = orderPair({ key: itemKey(t.id), hash: templateHash(t) }, { key: chunkKey(chunk.docSlug, chunk.heading), hash: textHash(chunk.text) });
    await this.d.kb.savePairDecision({ ...p, decision: input.decision, note: input.note ?? null, decidedBy: author.label });
    return this.revalidate(v.id);
  }

  /** Bao nhiêu cặp điểm cao nhất được hỏi AI mô tả khi CHỐT xung đột lúc publish (xem `syncConflictsAfterPublish`). Có giới hạn để một lần Publish không gọi AI hàng chục lần. */
  private static readonly CONFLICT_AI_TOP = 5;

  /**
   * Sau khi MỘT tài liệu đã publish (không phải mỗi lần lưu bản nháp): tính lại chồng lấn của tài liệu đó với phần còn
   * lại của kho hiện có, hỏi AI (SKILL review-overlap) mô tả cho vài cặp điểm cao nhất, rồi chốt vào bảng kb_conflicts —
   * nguồn cho dấu chấm đỏ + tooltip + gợi ý "Gỡ máy móc" trên danh sách Tài liệu. Lỗi ở bước này (mạng, chưa cấu hình LLM)
   * KHÔNG được làm hỏng việc publish đã xong — chỉ là ghi lại để hiển thị, không phải điều kiện. Publish lại tài liệu này
   * (kể cả khi đã sửa hết xung đột) sẽ tự dọn các dòng cũ không còn đúng (xem KbRepo.syncConflicts).
   */
  private async syncConflictsAfterPublish(slug: string, kind: DocKind, md: string): Promise<void> {
    if (kind === "guide") return;
    try {
      const parsed = this.parse(kind, md, slug);
      const probes = compiled(kind) ? probesFromTemplates(parsed.templates, slug) : probesFromChunks(parsed.chunks, slug);
      if (!probes.length) return void (await this.d.kb.syncConflicts(slug, []));
      const index = this.d.live.index;
      if (!index) return;
      const liveRows = await this.d.kb.loadPublishedTemplateRows(); // đã publish, gồm cả tài liệu vừa lên
      const docOf = new Map(liveRows.map((r) => [r.template.id, r.docSlug]));
      const raw = await findOverlaps({ index, kb: this.d.kb, embedder: this.d.embedder, docOf }, probes, { maxPairs: 40 });
      // HỎI THỬ bot (kb/routing-check.ts): cặp nào bot thật sự trả lời nhầm / không phân định được thì chắc chắn là vấn đề thật.
      const ids = new Set([...parsed.templates.map((t) => t.id), ...raw.flatMap((p) => [p.a, p.b]).filter((r) => r.kind === "template").map((r) => r.id)]);
      const chunkSides = [...new Map(raw.flatMap((p) => [p.a, p.b]).filter((r) => r.kind === "chunk").map((r) => [r.id, { ref: r, heading: r.title }])).values()];
      const confusions = await findConfusions(index, this.d.live.evaluator, this.d.embedder, evalSettings(this.d.live.urlHosts), { onlyIds: ids, docOf, chunks: chunkSides }).catch(() => [] as Confusion[]);
      const titleOf = (id: string) => index.get(id)?.sets_context.issue ?? id;
      const confirmed = (p: OverlapPair) => !!p.confusions?.length || !!p.updateHint;
      // cặp nhầm thật lên trước để luôn được AI mô tả; sau đó mới tới cặp chỉ giống chữ, điểm cao trước
      const pairs = raw.map((p) => ({ ...p, confusions: confusionsOf(p, confusions) })).sort((x, y) => Number(confirmed(y)) - Number(confirmed(x)) || y.score - x.score);
      const llm = usableLlm(this.d.llm);
      const chunkText = new Map((await this.d.kb.listPublishedChunks()).map((c) => [c.chunkId, c]));
      const sideOf = (ref: OverlapRef): OverlapSide => {
        if (ref.kind === "template") {
          const t = index.get(ref.id);
          return { kind: "template", id: ref.id, doc: ref.doc, title: ref.title, keywords: t?.match.keywords ?? [], examples: t?.match.examples ?? [], text: t ? this.answerOf(t) : "" };
        }
        const c = chunkText.get(ref.id);
        return { kind: "chunk", id: ref.id, doc: ref.doc, title: ref.title, keywords: [], examples: [], text: c?.text ?? "" };
      };
      const inputs: ConflictInput[] = [];
      for (const [i, p] of pairs.entries()) {
        let verdict: string | null = null;
        let reason: string | null = null;
        let suggestion: string | null = null;
        if (llm && i < KbService.CONFLICT_AI_TOP) {
          try {
            const v = await llm.reviewOverlap({ a: sideOf(p.a), b: sideOf(p.b), signals: p.signals.slice(0, 5) });
            verdict = v.verdict;
            reason = v.reason ?? null;
            suggestion = v.suggestion ?? null;
          } catch {
            /* AI chỉ mô tả thêm: dòng xung đột vẫn được ghi lại (không có verdict), publish không chờ và không chặn */
          }
        }
        // Chỉ GHI LẠI (hiện dấu đỏ trên danh sách Tài liệu) vấn đề thật: bot trả lời nhầm / đoạn trùng nguyên văn, hoặc AI thấy hai
        // bên nói MÂU THUẪN / TRÙNG hẳn nhau. Cặp chỉ giống chữ mà bot vẫn phân biệt đúng thì không làm phiền người dùng.
        if (!confirmed(p) && verdict !== "conflict" && verdict !== "duplicate") continue;
        const said = (p.confusions ?? []).slice(0, 3).map((c) => describeConfusion(c, titleOf));
        inputs.push({ a: p.a, b: p.b, score: p.score, signals: [...said, ...p.signals], narrow: p.narrow ?? null, verdict, reason, suggestion });
      }
      await this.d.kb.syncConflicts(slug, inputs);
    } catch {
      /* ghi nhận xung đột là tính năng phụ trợ: publish đã xong rồi, không lùi lại vì bước này lỗi */
    }
  }

  /**
   * Tính lại danh sách xung đột đã ghi (kb_conflicts) của MỌI tài liệu đang publish theo cách kiểm tra hiện tại — dùng sau khi
   * đổi cách phát hiện xung đột, để các dòng cũ (ghi theo cách cũ, chỉ dựa trên độ giống chữ) được thay bằng kết quả hỏi thử.
   * Không đổi nội dung nào, không publish gì.
   */
  async resyncAllConflicts(): Promise<{ docs: number; docsWithConflicts: number }> {
    const docs = (await this.d.kb.listDocuments()).filter((d) => d.published_version && d.kind !== "guide");
    for (const d of docs) {
      const v = await this.d.kb.getPublished(d.slug);
      if (v) await this.syncConflictsAfterPublish(d.slug, d.kind, v.source_md);
    }
    return { docs: docs.length, docsWithConflicts: (await this.d.kb.listOpenConflictCounts()).size };
  }

  /**
   * Gỡ máy móc một mục khớp (`phrase`, đúng chuỗi từ `ConflictRow.narrow`) khỏi một template — sửa văn bản Markdown gốc
   * của tài liệu chứa nó rồi tạo BẢN NHÁP mới (KHÔNG tự publish: vẫn cần Lưu → Publish → một quản trị viên khác duyệt
   * như luật hiện có). "Đồng ý" trên Admin Web nghĩa là điền sẵn bản sửa cho admin xem lại trước khi đưa lên, không phải
   * bỏ qua kiểm duyệt.
   */
  async applyNarrow(templateId: string, phrase: string, actor: Actor): Promise<{ version: VersionRow; report: ValidationReport }> {
    const rows = await this.d.kb.loadPublishedTemplateRows();
    const row = rows.find((r) => r.template.id === templateId);
    if (!row) throw new KbError(`không tìm thấy template đang publish: ${templateId}`, 404);
    const published = (await this.d.kb.listVersions(row.docSlug)).find((v) => v.status === "published");
    if (!published) throw new KbError(`tài liệu ${row.docSlug} hiện không có bản đang publish`, 404);
    if (row.kind === "items") {
      const topic = row.template.item?.topic ?? row.docSlug.replace(/^items-/, "");
      let removed = false;
      const r = await this.mutateItemsDoc(row.docSlug, topic, (doc) => {
        const it = doc.items.find((i) => i.id === templateId);
        if (!it) return;
        const before = it.phrases.length;
        it.phrases = it.phrases.filter((p) => normalize(p) !== normalize(phrase));
        removed = it.phrases.length !== before;
      }, actor);
      if (!removed) throw new KbError(`không còn thấy "${phrase}" trong ${templateId} — có thể đã được sửa rồi`, 409);
      const version = (await this.d.kb.getVersion(r.versionId))!;
      return { version, report: r.report };
    }
    const { md, removed } = narrowTemplateMatch(published.source_md, templateId, phrase);
    if (!removed) throw new KbError(`không còn thấy "${phrase}" trong ${templateId} — có thể đã được sửa rồi`, 409);
    return this.createDraft({ slug: row.docSlug, kind: "templates", md, author: actor });
  }

  /**
   * Sửa tự do (văn xuôi) một khung xung đột ở trợ lý "Nạp nội dung mới" — dùng khi KHÔNG biết chính xác một cụm để gỡ
   * máy móc (`applyNarrow`), ví dụ chồng lấn giữa hai đoạn tri thức, hoặc admin muốn viết lại hẳn câu trả lời của một
   * template thay vì chỉ bớt từ khoá. Chỉ tạo BẢN NHÁP mới, không tự publish — như `applyNarrow`.
   */
  async applyBoxEdit(input: { targetDoc: string; kind: "template" | "chunk"; templateId?: string; lang?: string; chunkHeading?: string; newText: string }, actor: Actor): Promise<{ version: VersionRow; report: ValidationReport }> {
    const doc = await this.d.kb.getDocument(input.targetDoc);
    if (!doc) throw new KbError(`không có tài liệu này: ${input.targetDoc}`, 404);
    if (doc.kind === "guide") throw new KbError(`"${GUIDE_SLUG}" là tài liệu bắt buộc duy nhất, không sửa qua luồng này`, 403);
    const published = (await this.d.kb.listVersions(input.targetDoc)).find((v) => v.status === "published");
    if (!published) throw new KbError(`tài liệu ${input.targetDoc} hiện không có bản đang publish`, 404);
    if (doc.kind === "items") {
      if (input.kind !== "template" || !input.templateId) throw new KbError("thiếu mã mục");
      const r = await this.mutateItemsDoc(input.targetDoc, input.targetDoc.replace(/^items-/, ""), (d) => {
        const it = d.items.find((i) => i.id === input.templateId);
        if (!it) throw new KbError(`không tìm thấy mục ${input.templateId} trong ${input.targetDoc}`, 404);
        if (it.kind !== "answer") throw new KbError("chỉ sửa được câu trả lời của mục loại trả lời");
        if (!it.steps.length) it.steps.push({ say: {} });
        it.steps[0]!.say = { en: input.newText.trim() };
      }, actor);
      return { version: (await this.d.kb.getVersion(r.versionId))!, report: r.report };
    }
    let result: { md: string; replaced: boolean };
    if (input.kind === "template") {
      if (!input.templateId) throw new KbError("thiếu templateId");
      result = replaceTemplateAnswer(published.source_md, input.templateId, input.lang || "en", input.newText);
      if (!result.replaced) throw new KbError(`không tìm thấy template ${input.templateId} trong ${input.targetDoc}`, 404);
    } else {
      if (!input.chunkHeading) throw new KbError("thiếu chunkHeading");
      result = replaceChunkSection(published.source_md, input.chunkHeading, input.newText);
      if (!result.replaced) throw new KbError(`không tìm thấy mục "${input.chunkHeading}" trong ${input.targetDoc}`, 404);
    }
    return this.createDraft({ slug: input.targetDoc, kind: doc.kind, md: result.md, author: actor });
  }

  private answerOf(t: Template): string {
    return t.answers.en ?? t.answer_from ?? "";
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

    const protectedContent = needsSecondApproval(report) && ((await this.d.secondApproval?.()) ?? true);
    if (protectedContent) {
      // luật bảo mật: chỉ owner đề xuất. Hướng dẫn AI: admin cũng đề xuất được, nhưng luôn cần một người KHÁC duyệt.
      if ((report.securityRules?.length ?? 0) > 0 && actor.role !== "owner") throw new KbError("nội dung có luật bảo mật (SECURITY_RULE): chỉ owner được đề xuất", 403);
      await this.d.kb.updateVersion(versionId, { status: "pending_approval", requiresSecondApproval: true });
      await this.d.ops.proposeChange("kb_publish", { versionId, slug: v.slug }, actor.id);
      await this.d.ops.audit(actor.label, "kb.propose_publish", v.slug, null, { versionId, securityRules: report.securityRules, guide: report.guide ?? false });
      return "pending_approval";
    }
    await this.activate(v, doc.kind, actor.label);
    await this.d.ops.audit(actor.label, "kb.publish", v.slug, { published: (await this.d.kb.getPublished(v.slug))?.version ?? null }, { version: v.version });
    await this.syncConflictsAfterPublish(v.slug, doc.kind, v.source_md);
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
    await this.syncConflictsAfterPublish(v.slug, doc.kind, v.source_md);
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

  /**
   * Xoá hẳn một tài liệu — MỌI trạng thái, kể cả đang publish (Admin Web bắt người dùng xác nhận trước khi gọi).
   * Xoá cả các phiên bản (cascade DB xoá theo: kb_chunks -> kb_chunk_embeddings của từng phiên bản, xem 001_init.sql),
   * tức dữ liệu vector của tài liệu này biến mất cùng lúc. Nếu tài liệu đang publish, bot ngừng dùng nội dung này NGAY
   * (rebuild live content) — không đợi tới lần publish/khởi động lại kế tiếp.
   * "Hướng dẫn AI làm việc" là tài liệu bắt buộc duy nhất, không cho xoá (không có gì để tạo lại nó ngoài seed ban đầu).
   */
  async deleteDocument(slug: string, actor: Actor): Promise<void> {
    if (slug === GUIDE_SLUG) throw new KbError(`"${GUIDE_SLUG}" là tài liệu bắt buộc duy nhất, không xoá được`);
    const doc = await this.d.kb.getDocument(slug);
    if (!doc) throw new KbError("không có tài liệu này", 404);
    const versions = await this.d.kb.listVersions(slug);
    const wasLive = versions.some((v) => v.status === "published");
    await this.d.kb.deleteDocument(slug);
    await this.d.kb.syncConflicts(slug, []); // tài liệu không còn: mọi xung đột đang mở chạm tới nó cũng hết
    await this.d.ops.audit(actor.label, "kb.delete_document", slug, null, { kind: doc.kind, versions: versions.length, wasLive });
    if (wasLive) await this.d.live.rebuild();
  }

  /** Kích hoạt một phiên bản: ghi template/chunk, đánh dấu published, tăng kb_version để bot nạp lại. */
  private async activate(v: VersionRow, kind: DocKind, by: string): Promise<void> {
    const parsed = this.parse(kind, v.source_md, v.slug);
    let chunkRows: { index: number; heading: string; text: string; url?: string; searchText: string; hash: string; lang?: string; embedding?: number[]; embeddingModel?: string }[] = [];
    if (kind === "knowledge") {
      // Vector luôn đi kèm model THẬT đã tạo ra nó (embedTagged): API lỗi giữa chừng -> phần còn lại do model cục bộ tạo và được gắn nhãn đúng
      let model = (await activeEmbedder(this.d.embedder)).version;
      // khoá cache = hash của câu dùng để embed (không phải của câu gửi khách): đổi cách embed thì tự tính lại vector
      const key = (c: KnowledgeChunk) => sha1(c.embedText);
      const cache = await this.d.kb.getEmbeddings(parsed.chunks.map(key), model);
      const missing = parsed.chunks.filter((c) => !cache.has(key(c)));
      const tagged = new Map<string, string>(); // hash -> model của vector trong cache
      for (const c of parsed.chunks) if (cache.has(key(c))) tagged.set(key(c), model);
      if (missing.length) {
        try {
          const t = await embedTagged(this.d.embedder, missing.map((c) => c.embedText));
          const entries = missing.map((c, i) => ({ hash: key(c), vector: t.vectors[i]! }));
          await this.d.kb.putEmbeddings(entries, t.model);
          for (const e of entries) {
            cache.set(e.hash, e.vector);
            tagged.set(e.hash, t.model);
          }
          model = t.model;
        } catch {
          /* không có embedding: chunk vẫn tìm được bằng từ khoá; worker bổ sung vector sau */
        }
      }
      chunkRows = parsed.chunks.map((c) => ({ ...c, embedding: cache.get(key(c)), embeddingModel: tagged.get(key(c)) }));
    } else {
      // kiểm tra chéo với phần còn lại của kho trước khi kích hoạt
      const live = (await this.d.kb.loadPublishedTemplateRows()).filter((r) => r.docSlug !== v.slug && !this.replacedBy(kind, parsed.templates, r)).map((r) => r.template);
      const predicates = await this.predicateMap();
      const errs = validateBundle([...live, ...parsed.templates], makeEvaluator(predicates).names()).filter((i) => i.level === "error");
      if (errs.length) throw new KbError("không nhất quán với phần còn lại của kho: " + errs.map((e) => e.message).join("; "));
    }
    const at = this.now();
    await this.d.db.tx(async (tx) => {
      const kb = kbRepo(tx);
      const ops = opsRepo(tx);
      await kb.activateVersion(v.id, v.slug, by, at);
      if (compiled(kind)) await kb.replaceTemplates(v.id, v.slug, parsed.templates);
      else if (kind === "knowledge") await kb.replaceChunks(v.id, v.slug, chunkRows); // guide: nội dung nằm ở source_md của phiên bản, LiveContent đọc lại
      await kb.clearArchivedContent(v.slug); // dọn template/chunk/vector của các phiên bản archived, đỡ tích rác qua nhiều lần publish
      await ops.bumpKbVersion(by);
    });
    await this.d.live.rebuild();
    if (compiled(kind)) await this.autoRegisterEvalCases(parsed.templates);
  }

  /**
   * Tự động thêm câu kiểm tra hồi quy ("Câu hỏi mẫu") cho template CHƯA có câu nào bảo vệ, ngay lúc publish — người
   * dùng không cần tự tay vào mục Câu hỏi mẫu thêm dòng nào. Lấy 1 câu có sẵn trong `examples` của chính template
   * (không gọi thêm AI, không tốn token). Bỏ qua template đã có ít nhất 1 câu, để không chèn thêm mỗi lần publish.
   * Lỗi ở bước phụ này không được làm hỏng việc publish đã thành công (đã publish xong mới chạy tới đây).
   */
  private async autoRegisterEvalCases(templates: Template[]): Promise<void> {
    try {
      const cases = await this.d.kb.listEvalCases();
      const covered = new Set(cases.map((c) => c.expected_template_id).filter((x): x is string => !!x));
      for (const t of templates) {
        if (covered.has(t.id)) continue;
        const example = t.match.examples.find((e) => e.trim().length >= 4);
        if (!example) continue;
        await this.d.kb.addEvalCase({ question: example, expected: t.id, source: "auto" });
        covered.add(t.id);
      }
    } catch {
      /* không để lỗi ở bước phụ này làm hỏng publish */
    }
  }

  /**
   * Embed lại các chunk đang publish (KHÔNG phải draft) chưa có vector của model ĐANG CHỌN. Lặp lại an toàn: hết việc thì không làm gì.
   * Lựa chọn được đọc lại mỗi lô: API lỗi giữa chừng -> SelectedEmbedder đã chuyển hẳn sang cục bộ, các lô sau đánh chỉ mục cho cục bộ.
   */
  async reindexChunks(batch = 16): Promise<{ updated: number; remaining: number; models: string[] }> {
    let updated = 0;
    let remaining = 0;
    const models = new Set<string>();
    for (let guard = 0; guard < 10_000; guard++) {
      const e = await activeEmbedder(this.d.embedder);
      models.add(e.version);
      const stale = await this.d.kb.listStaleChunks(e.version, batch);
      if (!stale.length) break;
      let t: { vectors: number[][]; model: string };
      try {
        t = await embedTagged(this.d.embedder, stale.map((c) => chunkEmbedText(c.heading, c.text)));
      } catch {
        remaining += stale.length; // cả model đang chọn cũng lỗi (vd dịch vụ cục bộ chưa lên): lần chạy sau làm tiếp
        break;
      }
      for (const [i, c] of stale.entries()) await this.d.kb.setChunkEmbedding(c.id, t.vectors[i]!, t.model);
      updated += stale.length;
      // đã bị chuyển model giữa chừng: vòng sau sẽ tính lại "còn thiếu" theo model mới
    }
    return { updated, remaining, models: [...models] };
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
      let chunkRows: { index: number; heading: string; text: string; url?: string; searchText: string; hash: string; lang?: string; embedding?: number[]; embeddingModel?: string }[] = [];
      if (kind === "knowledge") {
        let vecs: number[][] = [];
        let model = "";
        try {
          const t = await embedTagged(this.d.embedder, p.chunks.map((c) => c.embedText));
          vecs = t.vectors;
          model = t.model;
        } catch {
          vecs = [];
        }
        chunkRows = p.chunks.map((c, i) => ({ ...c, embedding: vecs[i], embeddingModel: vecs[i] ? model : undefined }));
      }
      await this.d.db.tx(async (tx) => {
        const kb = kbRepo(tx);
        await kb.activateVersion(v.id, d.slug, author, this.now());
        if (compiled(kind)) await kb.replaceTemplates(v.id, d.slug, p.templates);
        else if (kind === "knowledge") await kb.replaceChunks(v.id, d.slug, chunkRows);
      });
    }
    await this.d.ops.bumpKbVersion(author);
    await this.d.live.rebuild();
  }
}
