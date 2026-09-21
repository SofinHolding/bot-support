/**
 * Router nhiều tầng. Mỗi tầng chỉ ĐỀ XUẤT; DecisionGate quyết định.
 *   Tầng 0  luật (follow-up, lời chào, ảnh)          — 0 token
 *   Tầng 1  từ khoá / rule / ngữ nghĩa + Cổng         — 0 token LLM
 *   Tầng 2  LLM nhỏ, chỉ được chọn trong ứng viên      — ~1-3K token
 *   Tầng 3  tri thức (whitepaper...) — trích nguyên văn hoặc sinh có trích dẫn
 */
import type { Template, Tier, VisionResult } from "../domain/types";
import { ESCALATE_TEMPLATE_ID, GREETING_RETURNING_ID, GREETING_TEMPLATE_ID, HIGH_TRAFFIC_TEMPLATE_ID, IMAGE_UNREADABLE_ID } from "../domain/types";
import { checkOutput, decide, type GateContext, type GateResult, type GateSettings, DEFAULT_GATE_SETTINGS, type GateStep } from "./gate";
import { detectStrongFollowUp, resolveFollowUp, type FollowUpKind } from "./followup";
import { LlmUnavailableError, type ContextPack, type KnowledgePort, type LlmPort } from "./ports";
import type { Evaluator } from "./predicates";
import { makeInput } from "./predicates";
import type { TemplateIndex } from "./template-index";
import { graphemeLength, isEmojiOnly, normalize, wordCount } from "./text";

export interface RouterSettings extends GateSettings {
  tier3Mode: "extractive" | "generative";
  tier3MinScore: number;
  tooShortMaxChars: number;
  urlHostWhitelist: Set<string>;
}

export const DEFAULT_ROUTER_SETTINGS: Omit<RouterSettings, "urlHostWhitelist"> = {
  ...DEFAULT_GATE_SETTINGS,
  tier3Mode: "extractive",
  tier3MinScore: 0.25,
  tooShortMaxChars: 2,
};

export interface RouteContext {
  lastTemplate?: Template;
  pendingIssue?: string;
  parentEscalatedGroup?: string;
  contextPack?: ContextPack;
}

export interface RouteRequest {
  text: string; // đã che dữ liệu nhạy cảm
  norm: string;
  lang: string;
  vision?: VisionResult;
  hasImage: boolean;
  isSticker: boolean;
  ctx: RouteContext;
}

export type Outcome =
  | { kind: "TEMPLATE"; templateId: string; tier: Tier; via: string }
  | { kind: "ESCALATE"; tier: Tier; reason: string; sourceTemplateId?: string }
  | { kind: "GROUNDED"; tier: 3; answer: string; sources: { chunkId: string; docSlug: string; heading: string; url?: string }[]; mode: "extractive" | "generative" }
  | { kind: "OFFTOPIC"; tier: Tier; reason: string };

export interface RouteTrace {
  gates: GateStep[];
  ranked: GateResult["ranked"];
  candidates: string[];
  notes: string[];
  llm?: { action: string };
  followUp?: FollowUpKind;
}

export interface RouteResult {
  outcome: Outcome;
  trace: RouteTrace;
}

export interface RouterDeps {
  index: TemplateIndex;
  evaluator: Evaluator;
  settings: RouterSettings;
  llm?: LlmPort;
  knowledge?: KnowledgePort;
}

export async function route(req: RouteRequest, deps: RouterDeps): Promise<RouteResult> {
  const { index, evaluator, settings } = deps;
  const trace: RouteTrace = { gates: [], ranked: [], candidates: [], notes: [] };
  const last = req.ctx.lastTemplate;
  const matchText = [req.text, req.vision?.error_text].filter(Boolean).join(" ");
  const inp = { text: matchText, norm: req.text === matchText ? req.norm : normalize(matchText), imageType: req.vision?.screen_type, lastTemplateId: last?.id };
  const done = (outcome: Outcome): RouteResult => ({ outcome, trace });

  // --- Ảnh không đọc được (image-reader: chỉ khi ảnh THỰC SỰ không đọc được) ---
  if (req.hasImage && req.vision && !req.vision.readable && !req.norm) {
    return done({ kind: "TEMPLATE", templateId: IMAGE_UNREADABLE_ID, tier: 0, via: "image_unreadable" });
  }
  // Meme / sticker / ảnh không liên quan InterLink -> off-topic (image-reader)
  if (req.hasImage && req.vision?.screen_type === "unrelated" && !req.norm) {
    return done({ kind: "OFFTOPIC", tier: 0, reason: "ảnh không liên quan InterLink" });
  }

  // --- Tầng 0/1: ứng viên xác định ---
  const hits = index.hitsFor(inp);
  trace.candidates = [...new Set(hits.map((h) => h.templateId))];
  const hasOverride = hits.some((h) => h.kind === "override" && !isExcluded(index, evaluator, h.templateId, inp));

  // Follow-up mạnh (trừ khi có template ghi đè ngữ cảnh, vd ảnh KYC — FP-5b "HIGHEST PRIORITY OVERRIDE")
  if (!hasOverride) {
    const kind = detectStrongFollowUp({ text: req.text, norm: req.norm, hasImage: req.hasImage, imageType: req.vision?.screen_type }, evaluator, last);
    if (kind) {
      const target = resolveFollowUp(kind, last);
      trace.followUp = kind;
      if (target === "ESCALATE") return done({ kind: "ESCALATE", tier: 0, reason: `follow-up (${kind}) sau template ${last?.id ?? "-"}`, sourceTemplateId: last?.id });
      if (target && index.get(target)) return done({ kind: "TEMPLATE", templateId: target, tier: 0, via: `follow_up:${kind}` });
    }
  }

  // Tin quá ngắn / sticker / emoji đơn -> FP-1
  if (!req.hasImage && (req.isSticker || (req.norm.length === 0 && isEmojiOnly(req.text)) || graphemeLength(req.text) <= settings.tooShortMaxChars)) {
    return done({ kind: "TEMPLATE", templateId: greeting(req), tier: 0, via: "too_short" });
  }

  const suggestions = hits.length ? [] : await index.suggest(req.text, 5);
  const gate = decide(hits, suggestions, inp, index, evaluator, { lastTemplateId: last?.id, parentEscalatedGroup: req.ctx.parentEscalatedGroup } satisfies GateContext, settings);
  trace.gates = gate.steps;
  trace.ranked = gate.ranked;
  const g = gate.result;

  if (g.verdict === "MATCH_CONFIDENT") {
    const tid = g.templateId === GREETING_TEMPLATE_ID ? greeting(req) : g.templateId;
    return done({ kind: "TEMPLATE", templateId: tid, tier: g.via === "semantic" ? 1 : 0, via: g.via });
  }
  if (g.verdict === "ESCALATE") return done({ kind: "ESCALATE", tier: 1, reason: g.reason, sourceTemplateId: g.sourceTemplateId });

  // --- NO_MATCH: follow-up "khách cung cấp thông tin bot vừa xin" ---
  if (g.verdict === "NO_MATCH" && last?.follow_up.info_provided && (req.hasImage || wordCount(req.norm) > 0)) {
    const target = resolveFollowUp("info_provided", last);
    trace.followUp = "info_provided";
    if (target === "ESCALATE") return done({ kind: "ESCALATE", tier: 0, reason: `khách gửi thông tin theo yêu cầu (template ${last.id})`, sourceTemplateId: last.id });
    if (target && index.get(target)) return done({ kind: "TEMPLATE", templateId: target, tier: 0, via: "follow_up:info_provided" });
  }

  // --- Câu hỏi về tri thức (whitepaper/tokenomics): tầng 3 ---
  const ev = makeInput(matchText, {});
  ev.norm = inp.norm;
  // (không có ứng viên xác định nào; gợi ý ngữ nghĩa yếu không được chặn câu hỏi tri thức rõ ràng)
  if (hits.length === 0 && evaluator.test("knowledge_topic", ev)) return tier3(req, deps, trace, done);

  // --- Tầng 2 ---
  if (!deps.llm) {
    trace.notes.push("không cấu hình LLM: không khớp/mơ hồ -> ESCALATE");
    return done({ kind: "ESCALATE", tier: 1, reason: g.verdict === "NO_MATCH" ? "không khớp template" : "mơ hồ giữa nhiều template", sourceTemplateId: last?.id });
  }
  // Mơ hồ giữa vài template -> chỉ đưa các template đó. Không khớp gì -> đưa danh mục gọn của toàn bộ template
  // (ổn định giữa các lượt nên prompt caching hiệu quả) để không phụ thuộc vào chất lượng embedding.
  const candidates =
    g.verdict === "MATCH_AMBIGUOUS"
      ? g.candidates
          .map((id) => index.get(id))
          .filter((t): t is Template => !!t)
          .map((t) => ({ id: t.id, group: t.group, gist: t.match.examples[0] ?? t.match.keywords[0] ?? t.sets_context.issue ?? t.id }))
      : index.catalogue();
  try {
    const res = await deps.llm.classify({ text: req.text, lang: req.lang, context: req.ctx.contextPack ?? { profile: "", events: [], recent: [] }, candidates });
    trace.llm = { action: res.action };
    if (res.action === "template") {
      const t = index.get(res.template_id);
      const allowed = candidates.some((c) => c.id === res.template_id);
      if (!t || !allowed || t.response_mode !== "EXACT_TEMPLATE" || isExcluded(index, evaluator, t.id, inp)) {
        trace.notes.push(`LLM chọn template không hợp lệ: ${res.template_id}`);
        return done({ kind: "ESCALATE", tier: 2, reason: "LLM chọn template ngoài danh sách cho phép", sourceTemplateId: last?.id });
      }
      return done({ kind: "TEMPLATE", templateId: t.id === GREETING_TEMPLATE_ID ? greeting(req) : t.id, tier: 2, via: "llm" });
    }
    if (res.action === "knowledge") return tier3(req, deps, trace, done);
    if (res.action === "offtopic") return done({ kind: "OFFTOPIC", tier: 2, reason: "LLM phân loại off-topic" });
    return done({ kind: "ESCALATE", tier: 2, reason: "LLM phân loại cần escalate", sourceTemplateId: last?.id });
  } catch (e) {
    if (e instanceof LlmUnavailableError) {
      trace.notes.push(`LLM lỗi: ${e.message}`);
      return done({ kind: "TEMPLATE", templateId: HIGH_TRAFFIC_TEMPLATE_ID, tier: 2, via: "llm_unavailable" });
    }
    throw e;
  }
}

async function tier3(req: RouteRequest, deps: RouterDeps, trace: RouteTrace, done: (o: Outcome) => RouteResult): Promise<RouteResult> {
  const { knowledge, llm, settings } = deps;
  if (!knowledge) return done({ kind: "ESCALATE", tier: 3, reason: "không có kho tri thức" });
  const hits = await knowledge.search(req.text, 4);
  const top = hits[0];
  if (!top || top.score < settings.tier3MinScore) {
    trace.notes.push("tri thức: không tìm thấy đoạn đủ liên quan");
    return done({ kind: "ESCALATE", tier: 3, reason: "không có nguồn tri thức phù hợp" });
  }
  const link = top.url ? `\n\n${top.url}` : "";

  if (settings.tier3Mode === "extractive" || !llm) {
    // SKILL.md: "tìm section khớp → copy nguyên văn. Kèm link"
    const answer = `${top.text}${link}`;
    const chk = checkOutput(answer, { urlHostWhitelist: settings.urlHostWhitelist });
    if (!chk.ok) {
      trace.notes.push(`đầu ra bị chặn: ${chk.problems.join("; ")}`);
      return done({ kind: "ESCALATE", tier: 3, reason: "đoạn tri thức không qua kiểm tra đầu ra" });
    }
    return done({ kind: "GROUNDED", tier: 3, answer, mode: "extractive", sources: [{ chunkId: top.chunkId, docSlug: top.docSlug, heading: top.heading, url: top.url }] });
  }

  try {
    const res = await llm.grounded({ question: req.text, lang: req.lang, chunks: hits.map((h) => ({ id: h.chunkId, heading: h.heading, text: h.text, url: h.url })) });
    const valid = new Set(hits.map((h) => h.chunkId));
    const cited = res.cited.filter((c) => valid.has(c));
    if (!res.answerable || !cited.length) return done({ kind: "ESCALATE", tier: 3, reason: "LLM không tìm được câu trả lời có trích dẫn" });
    const answer = res.answer;
    const chk = checkOutput(answer, { urlHostWhitelist: settings.urlHostWhitelist, forbidFinancialClaims: true });
    if (!chk.ok) {
      trace.notes.push(`đầu ra bị chặn: ${chk.problems.join("; ")}`);
      return done({ kind: "ESCALATE", tier: 3, reason: `câu sinh bị bộ lọc chặn: ${chk.problems.join("; ")}` });
    }
    const src = hits.filter((h) => cited.includes(h.chunkId)).map((h) => ({ chunkId: h.chunkId, docSlug: h.docSlug, heading: h.heading, url: h.url }));
    return done({ kind: "GROUNDED", tier: 3, answer, mode: "generative", sources: src });
  } catch (e) {
    if (e instanceof LlmUnavailableError) return done({ kind: "TEMPLATE", templateId: HIGH_TRAFFIC_TEMPLATE_ID, tier: 3, via: "llm_unavailable" });
    throw e;
  }
}

function greeting(req: RouteRequest): string {
  return req.ctx.pendingIssue ? GREETING_RETURNING_ID : GREETING_TEMPLATE_ID;
}

function isExcluded(index: TemplateIndex, evaluator: Evaluator, templateId: string, inp: { text: string; norm: string; imageType?: VisionResult["screen_type"]; lastTemplateId?: string }): boolean {
  const t = index.get(templateId);
  if (!t) return true;
  const ev = makeInput(inp.text, { imageType: inp.imageType, lastTemplateId: inp.lastTemplateId });
  ev.norm = inp.norm;
  return t.match.excludes.some((c) => evaluator.evalCondition(c, ev));
}

export { ESCALATE_TEMPLATE_ID };
