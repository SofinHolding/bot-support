/**
 * Router nhiều tầng. Mỗi tầng chỉ ĐỀ XUẤT; DecisionGate quyết định.
 *   Tầng 0  luật (follow-up, lời chào, ảnh)          — 0 token
 *   Tầng 1  từ khoá / rule / ngữ nghĩa + Cổng         — 0 token LLM
 *   Tầng 2  LLM nhỏ, chỉ được chọn trong ứng viên      — ~1-3K token
 *   Tầng 3  tri thức (whitepaper...) — trích nguyên văn hoặc sinh có trích dẫn
 */
import type { Template, Tier, VisionResult } from "../domain/types";
import { ESCALATE_TEMPLATE_ID, GREETING_RETURNING_ID, GREETING_TEMPLATE_ID, IMAGE_UNREADABLE_ID, THANKS_TEMPLATE_ID } from "../domain/types";
import { checkOutput, decide, type GateContext, type GateResult, type GateSettings, DEFAULT_GATE_SETTINGS, type GateStep } from "./gate";
import { detectStrongFollowUp, resolveFollowUp, type FollowUpKind } from "./followup";
import { contentTokens } from "./knowledge";
import { scriptProblem, sourceLangOf } from "./language";
import { numbersNotIn, queryProblems } from "./translate";
import { sha1 } from "./knowledge";
import { LlmUnavailableError, type ContextPack, type KnowledgeHit, type KnowledgePort, type LlmPort } from "./ports";
import type { Evaluator } from "./predicates";
import { makeInput } from "./predicates";
import { maskSensitive } from "./sanitize";
import type { TemplateIndex } from "./template-index";
import { graphemeLength, isEmojiOnly, normalize, wordCount } from "./text";

export interface RouterSettings extends GateSettings {
  tier3Mode: "extractive" | "generative";
  tier3MinScore: number;
  /** Điểm truy xuất không nói lên đoạn đó có TRẢ LỜI câu hỏi hay không (đo với bge-m3: không ngưỡng nào tách được). true = cần LLM xác nhận. */
  tier3Verify: boolean;
  /** Ngôn ngữ chính của kho tri thức: câu hỏi của khách được dịch sang ngôn ngữ này để tìm (SKILL translate-query) */
  knowledgeLang: string;
  tooShortMaxChars: number;
  urlHostWhitelist: Set<string>;
  /** Cho AI hỏi lại khách 1 lần khi câu hỏi mơ hồ giữa hai mục hỏi đáp đã khai báo là khác nhau (setting episode.ask_when_unclear) */
  askWhenUnclear?: boolean;
}

export const DEFAULT_ROUTER_SETTINGS: Omit<RouterSettings, "urlHostWhitelist"> = {
  ...DEFAULT_GATE_SETTINGS,
  tier3Mode: "extractive",
  tier3MinScore: 0.25,
  tier3Verify: true,
  knowledgeLang: "en",
  tooShortMaxChars: 2,
  askWhenUnclear: false,
};

export interface RouteContext {
  lastTemplate?: Template;
  pendingIssue?: string;
  parentEscalatedGroup?: string;
  contextPack?: ContextPack;
  /** Lượt trước bot đã hỏi lại khách để phân biệt các mục này: lượt này chỉ chọn trong đây, không rõ nữa thì chuyển nhân viên */
  pendingClarify?: { items: string[] };
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
  | { kind: "GROUNDED"; tier: 3; answer: string; /** ngôn ngữ thật của `answer` (khác ngôn ngữ khách => phải dịch trước khi gửi) */ sourceLang: string; /** sha1 của đoạn nguồn chính: khoá lưu câu trả lời đã gửi cho admin xem */ sourceHash?: string; sources: { chunkId: string; docSlug: string; heading: string; url?: string }[]; mode: "extractive" | "generative" }
  | { kind: "OFFTOPIC"; tier: Tier; reason: string }
  /** Hỏi lại khách (tối đa 1 lần) để phân biệt các mục đã khai báo là khác nhau. `question` là câu hỏi lại đã duyệt, tiếng Anh. */
  /** `items`: các ứng viên được hỏi ("T:<id>" câu trả lời, "K:<chunkId>" đoạn tài liệu); `question`: câu hỏi lại dựng từ dữ liệu đã duyệt, tiếng Anh. */
  | { kind: "CLARIFY"; tier: 2; question: string; items: string[] }
  /** Không gọi được LLM (mất kết nối, quá tải, chưa cấu hình, hết ngân sách): gửi câu cố định tiếng Anh (core/fixed-messages.ts),
   * KHÔNG lấy nội dung trong kho trả thẳng cho khách. */
  | { kind: "UNAVAILABLE"; tier: Tier; reason: string };

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
  /** Luồng "AI hiểu trước": ngôn ngữ trả lời do AI xác định (code đã kiểm lại). Không có = dùng ngôn ngữ do code nhận diện. */
  lang?: string;
  /** Bản tiếng Anh của câu hỏi do AI viết lại (đã qua kiểm tra): dùng để trích giá trị khách nêu khi ngôn ngữ gốc không trích được */
  queryEn?: string;
}

export interface RouterDeps {
  index: TemplateIndex;
  evaluator: Evaluator;
  settings: RouterSettings;
  llm?: LlmPort;
  knowledge?: KnowledgePort;
  /** Cặp nội dung đang xung đột CHƯA giải quyết ("template:<id>|chunk:<id>", sắp theo thứ tự) — không được hỏi lại khách giữa chúng. */
  conflicts?: ReadonlySet<string>;
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
  // Từ khoá của template viết bằng tiếng Anh/Việt. Với ngôn ngữ khác (Đức, Hàn...), vài từ mượn trùng khớp ("token", "app") tạo ra một nhóm
  // "mơ hồ" KHÔNG đáng tin và có thể thiếu template đúng => đưa cả danh mục cho LLM thay vì ép nó chọn trong nhóm đó.
  const keywordsReliable = req.lang === "en" || req.lang === "vi";
  const candidates =
    g.verdict === "MATCH_AMBIGUOUS" && keywordsReliable
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
      if (!t || !allowed || t.response_mode !== "EXACT_TEMPLATE" || isExcluded(index, evaluator, t.id, inp) || missingRequires(index, evaluator, t.id, inp)) {
        trace.notes.push(`LLM chọn template không hợp lệ: ${res.template_id}`);
        return done({ kind: "ESCALATE", tier: 2, reason: "LLM chọn template ngoài danh sách cho phép", sourceTemplateId: last?.id });
      }
      // Cổng ngữ cảnh áp dụng cho MỌI đường: khách quay lại chủ đề đã chuyển support thì không lặp lại chuỗi template.
      if (req.ctx.parentEscalatedGroup && t.group === req.ctx.parentEscalatedGroup) {
        return done({ kind: "ESCALATE", tier: 2, reason: `khách quay lại chủ đề "${t.group}" đã được chuyển support trước đó`, sourceTemplateId: t.id });
      }
      return done({ kind: "TEMPLATE", templateId: t.id === GREETING_TEMPLATE_ID ? greeting(req) : t.id, tier: 2, via: "llm" });
    }
    if (res.action === "knowledge") return tier3(req, deps, trace, done);
    if (res.action === "offtopic") return done({ kind: "OFFTOPIC", tier: 2, reason: "LLM phân loại off-topic" });
    return done({ kind: "ESCALATE", tier: 2, reason: "LLM phân loại cần escalate", sourceTemplateId: last?.id });
  } catch (e) {
    return done(llmFailure(e, 2, trace, last?.id));
  }
}

/**
 * LLM không cho kết quả dùng được. Mất kết nối / quá tải -> UNAVAILABLE (câu báo mất kết nối cố định, tiếng Anh; khách thử lại).
 * Mọi trường hợp khác (từ chối, đầu ra sai schema, lỗi bất ngờ) -> chuyển người thật: không đoán, không bỏ rơi khách.
 */
export function llmFailure(e: unknown, tier: Tier, trace: RouteTrace, sourceTemplateId?: string): Outcome {
  const msg = e instanceof Error ? e.message : String(e);
  trace.notes.push(`LLM lỗi: ${msg.slice(0, 200)}`);
  if (e instanceof LlmUnavailableError && !e.badOutput) return { kind: "UNAVAILABLE", tier, reason: `không gọi được LLM: ${msg.slice(0, 120)}` };
  return { kind: "ESCALATE", tier, reason: "LLM không trả được kết quả hợp lệ", sourceTemplateId };
}

const noLlm = (trace: RouteTrace): RouteResult => {
  trace.notes.push("không có LLM dùng được (chưa cấu hình hoặc hết ngân sách): không trả lời thẳng từ kho");
  return { outcome: { kind: "UNAVAILABLE", tier: 0, reason: "không có LLM dùng được" }, trace };
};

/**
 * SKILL translate-query: dịch câu hỏi của khách sang ngôn ngữ của kho tri thức và làm nó đứng độc lập ("còn cái kia?" -> thực thể cụ thể).
 * Chạy khi khách hỏi bằng ngôn ngữ khác kho, hoặc khi có ngữ cảnh để giải "nó / cái đó". Đầu ra là chữ của LLM nên CHỈ dùng để TÌM
 * (không bao giờ gửi cho khách) và phải qua kiểm tra bằng code; không đạt hoặc LLM lỗi thì bỏ, tìm bằng câu gốc như thường.
 */
async function translateQuery(req: RouteRequest, deps: RouterDeps, trace: RouteTrace): Promise<string | undefined> {
  const { llm, settings } = deps;
  const pack = req.ctx.contextPack;
  const hasContext = !!pack && !!(pack.summary || pack.recent.length || pack.facts?.length);
  // Cùng ngôn ngữ với kho thì chỉ cần khi câu ngắn có ngữ cảnh ("còn cái kia?", "vậy sau đó?"): câu dài tự đứng độc lập, khỏi tốn một lời gọi LLM
  const shortFollowUp = hasContext && wordCount(req.norm) <= 6;
  if (!llm || (req.lang === settings.knowledgeLang && !shortFollowUp)) return undefined;
  try {
    const r = await llm.translateQuery({ text: req.text, from: req.lang, to: settings.knowledgeLang, context: pack });
    const query = maskSensitive(r.query).replace(/\s+/g, " ").trim().slice(0, 200);
    const ctxText = pack ? [pack.summary ?? "", ...(pack.facts ?? []), ...pack.events, ...pack.recent.map((m) => m.text)].join(" ") : "";
    const problems = queryProblems(req.text, query, ctxText, settings.knowledgeLang);
    if (problems.length) {
      trace.notes.push(`SKILL translate-query: bỏ câu dịch (${problems.join("; ")}); tìm bằng câu gốc`);
      return undefined;
    }
    if (normalize(query) === normalize(req.text)) return undefined;
    trace.notes.push(`SKILL translate-query (${req.lang}->${settings.knowledgeLang}): "${query}"`);
    return query;
  } catch (e) {
    trace.notes.push(`SKILL translate-query lỗi (${(e as Error).message.slice(0, 80)}); tìm bằng câu gốc`);
    return undefined;
  }
}

async function tier3(req: RouteRequest, deps: RouterDeps, trace: RouteTrace, done: (o: Outcome) => RouteResult): Promise<RouteResult> {
  const { knowledge, llm, settings } = deps;
  if (!knowledge) return done({ kind: "ESCALATE", tier: 3, reason: "không có kho tri thức" });
  const query = await translateQuery(req, deps, trace);
  // Tìm bằng câu gốc VÀ câu đã dịch (nếu có), gộp theo đoạn, lấy điểm cao nhất: dịch hỏng vẫn còn câu gốc, dịch tốt giúp khớp từ khoá của kho.
  // Truyền ngôn ngữ của từng truy vấn để chấm điểm đúng khi truy vấn và đoạn khác ngôn ngữ.
  const lists = await Promise.all([knowledge.search(req.text, 4, req.lang), ...(query ? [knowledge.search(query, 4, settings.knowledgeLang)] : [])]);
  const merged = new Map<string, KnowledgeHit>();
  for (const h of lists.flat()) if (!merged.has(h.chunkId) || merged.get(h.chunkId)!.score < h.score) merged.set(h.chunkId, h);
  const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 4);
  const rewritten = query;
  const top = hits[0];
  if (!top || top.score < settings.tier3MinScore) {
    trace.notes.push("tri thức: không tìm thấy đoạn đủ liên quan");
    return done({ kind: "ESCALATE", tier: 3, reason: "không có nguồn tri thức phù hợp" });
  }
  if (settings.tier3Mode === "extractive" || !llm) {
    // SKILL.md: "tìm section khớp → copy nguyên văn. Kèm link". LLM (nếu bật xác nhận) chỉ PHÁN ĐOÁN đoạn nào trả lời được câu hỏi;
    // câu gửi cho khách luôn là nguyên văn đoạn đã duyệt, không phải chữ của LLM.
    // Đoạn khác ngôn ngữ với khách thì điểm truy xuất chỉ là điểm vector (không có tín hiệu từ khoá) và câu gửi phải qua bản dịch:
    // luôn bắt LLM xác nhận đoạn đó trả lời đúng câu hỏi, bất kể `tier3Verify`.
    const crossLanguage = hitLang(top) !== req.lang;
    let chosen = top;
    if (settings.tier3Verify || crossLanguage) {
      if (!llm) {
        trace.notes.push("tri thức: không có LLM để xác nhận đoạn tìm được trả lời đúng câu hỏi");
        return done({ kind: "ESCALATE", tier: 3, reason: "không có nguồn tri thức được xác nhận là trả lời đúng câu hỏi" });
      }
      try {
        const v = await llm.grounded({ question: req.text, standalone: rewritten, verifyOnly: true, lang: "en", chunks: hits.map((h) => ({ id: h.chunkId, heading: h.heading, text: h.text, url: h.url })) });
        const pick = v.answerable ? hits.find((h) => v.cited.includes(h.chunkId)) : undefined;
        if (!pick) {
          trace.notes.push("tri thức: các đoạn tìm được không trả lời câu hỏi");
          return done({ kind: "ESCALATE", tier: 3, reason: "không có nguồn tri thức phù hợp" });
        }
        chosen = pick;
      } catch (e) {
        return done(llmFailure(e, 3, trace));
      }
    }
    const answer = `${chosen.text}${chosen.url ? `\n\n${chosen.url}` : ""}`;
    const chk = checkOutput(answer, { urlHostWhitelist: settings.urlHostWhitelist });
    if (!chk.ok) {
      trace.notes.push(`đầu ra bị chặn: ${chk.problems.join("; ")}`);
      return done({ kind: "ESCALATE", tier: 3, reason: "đoạn tri thức không qua kiểm tra đầu ra" });
    }
    return done({ kind: "GROUNDED", tier: 3, answer, mode: "extractive", sourceLang: hitLang(chosen), sources: [{ chunkId: chosen.chunkId, docSlug: chosen.docSlug, heading: chosen.heading, url: chosen.url }] });
  }

  try {
    const res = await llm.grounded({ question: req.text, standalone: rewritten, lang: req.lang, chunks: hits.map((h) => ({ id: h.chunkId, heading: h.heading, text: h.text, url: h.url })) });
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
    // LLM được yêu cầu viết bằng ngôn ngữ của khách; nếu nó lỡ viết tiếng Việt thì sourceLang = "vi" và pipeline sẽ dịch/chặn
    return done({ kind: "GROUNDED", tier: 3, answer, mode: "generative", sourceLang: sourceLangOf(answer, scriptProblem(answer, req.lang) ? undefined : req.lang), sources: src });
  } catch (e) {
    return done(llmFailure(e, 3, trace));
  }
}

/**
 * Câu hỏi lại khách, DỰNG BẰNG CODE từ nội dung đã duyệt của chính các trường hợp tìm thấy (yêu cầu §2 — không để AI viết,
 * không có điều kiện nghiệp vụ nào ngoài dữ liệu): hai câu trả lời có câu hỏi lại do người duyệt khai ("khác với") thì dùng
 * câu đó; không thì liệt kê từng trường hợp bằng câu khách hay hỏi đã duyệt của mục (đoạn tài liệu: tiêu đề của đoạn).
 * Tiếng Anh; pipeline dịch trung thành sang ngôn ngữ của khách như mọi câu đã duyệt.
 */
export function clarifyQuestion(refs: string[], templates: Template[], chunks: KnowledgeHit[], index: TemplateIndex): string {
  if (refs.length === 2 && refs.every((r) => r.startsWith("T:"))) {
    const decl = index.distinctPair(refs[0]!.slice(2), refs[1]!.slice(2));
    if (decl?.clarify) return decl.clarify;
  }
  const label = (r: string) => {
    if (r.startsWith("T:")) {
      const t = templates.find((x) => x.id === r.slice(2)) ?? index.get(r.slice(2));
      return t?.match.examples[0] ?? t?.item?.title ?? t?.sets_context.issue ?? r.slice(2);
    }
    const c = chunks.find((x) => x.chunkId === r.slice(2));
    return c ? c.heading.split(" › ").pop()!.trim() : r.slice(2);
  };
  return ["To help you correctly, which of these is your case?", ...refs.map((r, i) => `${i + 1}) ${label(r)}`)].join("\n");
}

/**
 * Ứng viên gửi cho SKILL select-answer. Mục hỏi đáp mang thêm ngữ cảnh áp dụng và các lời khai "khác với" giữa các ứng viên
 * trong CÙNG danh sách — AI dựa vào đó để phân biệt, hoặc trả CLARIFY:<A>,<B> khi không phân biệt được.
 */
function selectCandidates(templates: Template[], chunks: KnowledgeHit[], index: TemplateIndex) {
  const topicOf = (t: Template): string => {
    if (!t.item) return `${t.group} — ${t.match.examples[0] ?? t.match.keywords[0] ?? t.sets_context.issue ?? t.id}`;
    const diffs = templates.filter((o) => o.id !== t.id).flatMap((o) => {
      const d = index.distinctPair(t.id, o.id);
      return d ? [`differs from T:${o.id}: ${d.difference}`] : [];
    });
    return [t.item.title, t.item.applies_when ? `applies when: ${t.item.applies_when}` : "", ...diffs].filter(Boolean).join(" — ");
  };
  return [
    ...templates.map((t) => ({ ref: `T:${t.id}`, topic: topicOf(t), text: (index.resolveAnswerSource(t).answers.en ?? "").slice(0, 600) })),
    ...chunks.map((c) => ({ ref: `K:${c.chunkId}`, topic: `${c.docSlug} — ${c.heading}`, text: c.text.slice(0, 1800) })),
  ];
}

/** Ngôn ngữ thật của một đoạn tri thức (đoạn có dấu tiếng Việt luôn là "vi" dù lời khai ghi gì). */
const hitLang = (h: KnowledgeHit): string => sourceLangOf(h.text, h.lang);

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

function missingRequires(index: TemplateIndex, evaluator: Evaluator, templateId: string, inp: { text: string; norm: string; imageType?: VisionResult["screen_type"]; lastTemplateId?: string }): boolean {
  const t = index.get(templateId);
  if (!t) return true;
  const ev = makeInput(inp.text, { imageType: inp.imageType, lastTemplateId: inp.lastTemplateId });
  ev.norm = inp.norm;
  return t.match.requires.some((c) => !evaluator.evalCondition(c, ev));
}

export { ESCALATE_TEMPLATE_ID };

// =====================================================================================================================
// Luồng "AI HIỂU TRƯỚC" (router.mode = llm_first)
//   khách -> [AI] hiểu: ngôn ngữ + ý định + câu truy vấn (en + ngôn ngữ của kho)
//         -> [CODE] tìm trong kho: template (từ khoá + ngữ nghĩa) và đoạn tri thức, lọc qua requires/excludes
//         -> [AI] chọn ứng viên ĐÚNG (chỉ được chọn ref có trong danh sách; không có thì chuyển nhân viên)
//         -> [CODE] kiểm tra đầu ra -> (pipeline) dịch trung thành sang ngôn ngữ của khách -> gửi
// AI không bao giờ viết câu trả lời: khách luôn nhận nguyên văn nội dung đã duyệt. Mọi đầu ra của AI được code kiểm lại.
// AI không dùng được (mất kết nối, quá tải, chưa cấu hình) -> UNAVAILABLE (câu báo mất kết nối cố định, tiếng Anh); đầu ra hỏng -> chuyển nhân viên.
// KHÔNG có đường nào gửi thẳng nội dung trong kho mà chưa qua SKILL AI (`route()` chỉ còn là bước sinh ứng viên cho FAST PATH / luật ảnh).
// =====================================================================================================================

// =====================================================================================================================
// Luồng HAI NHÁNH (router.mode = hybrid) — theo sơ đồ workflow:
//   PRECHECK (code, ở pipeline) -> XÁC ĐỊNH NGÔN NGỮ (AI; câu không phải Anh/Việt được dịch về tiếng Anh) -> ROUTER
//     -> FAST PATH : khớp CHẮC CHẮN bằng luật / điều kiện / từ khoá trên câu ĐÃ CHUẨN HOÁ (không thêm lời gọi AI)
//     -> AI / RAG  : mọi trường hợp còn lại (truy vấn đã chuẩn hoá -> tìm -> AI kiểm tra grounding và chọn nội dung)
// Bài học từ lần chạy thật: khớp từ khoá trong câu DÀI dễ trả sai nội dung ("cơ chế đào token..." -> template giảm 50%; câu chèn lệnh có
// chữ "HCS formula" -> template HCS). Nên từ khoá chỉ được đi FAST PATH khi cụm khớp chiếm phần lớn nội dung câu hỏi.
// =====================================================================================================================

const FAST_KEYWORD_MIN_COVERAGE = 0.5;
const KEYWORD_LANGS = new Set(["en", "vi"]); // ngôn ngữ mà luật và từ khoá của template được soạn

/** Vì sao một kết quả của luồng luật/từ khoá ĐƯỢC đi FAST PATH; undefined = phải qua AI/RAG. `req.text` là câu đã chuẩn hoá (Anh/Việt). */
function fastPathReason(req: RouteRequest, r: RouteResult, index: TemplateIndex): string | undefined {
  const o = r.outcome;
  if (r.trace.followUp) return `luật nối tiếp (${r.trace.followUp})`;
  if (o.kind === "OFFTOPIC" && o.tier === 0) return "ảnh không liên quan";
  if (o.kind === "ESCALATE") return o.tier === 1 && !/không khớp|mơ hồ/.test(o.reason) ? "cổng ngữ cảnh/điều kiện" : undefined; // vd khách quay lại chủ đề đã chuyển nhân viên
  if (o.kind !== "TEMPLATE" || o.tier !== 0) return undefined; // khớp ngữ nghĩa (tầng 1) không phải "từ khoá, luật, điều kiện" -> AI/RAG
  if (o.via !== "keyword") return `luật (${o.via})`; // exact, rule, image, override, too_short, image_unreadable
  const top = r.trace.ranked[0];
  const matchText = [req.text, req.vision?.error_text].filter(Boolean).join(" ");
  const hit = top && index.hitsFor({ text: matchText, norm: normalize(matchText), imageType: req.vision?.screen_type, lastTemplateId: req.ctx.lastTemplate?.id }).find((h) => h.templateId === top.templateId && h.kind === "keyword");
  if (!hit?.phrase || hit.loose) return undefined;
  const content = contentTokens(req.text);
  const coverage = content.length ? Math.min(1, contentTokens(hit.phrase).length / content.length) : 1;
  return coverage >= FAST_KEYWORD_MIN_COVERAGE ? `từ khoá "${hit.phrase}" chiếm ${Math.round(coverage * 100)}% nội dung câu hỏi` : undefined;
}

/**
 * Luồng hai nhánh của workflow. MỌI câu trả lời lấy từ kho đều phải qua SKILL AI đánh giá trong lượt này (verify-answer ở
 * FAST PATH, select-answer ở nhánh AI/RAG): không có AI -> UNAVAILABLE, không bao giờ trả thẳng kết quả khớp từ khoá.
 */
export async function routeHybrid(req: LlmFirstRequest, deps: RouterDeps): Promise<RouteResult> {
  if (!deps.llm) return noLlm({ gates: [], ranked: [], candidates: [], notes: [] });
  return routeLlmFirst(req, deps, { fastPath: true });
}

const MAX_TEMPLATE_CANDIDATES = 8;
const MAX_CHUNK_CANDIDATES = 4;
const NON_LATIN_LANGS = new Set(["ko", "ja", "zh", "ru", "uk", "ar", "fa", "th", "hi"]);

/** Ngôn ngữ trả lời: AI xác định, code kiểm lại. Chữ viết của tin nhắn (Hàn, Nhật, Nga...) là bằng chứng chắc chắn nên thắng khi AI nói khác. */
function resolveReplyLang(aiLang: string, codeLang: string, codeDetected: string | null, trace: RouteTrace): string {
  const ai = aiLang.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(ai)) return codeLang; // "unknown" / sai định dạng -> ngôn ngữ do code xác định (đã lưu hoặc mặc định)
  if (codeDetected && NON_LATIN_LANGS.has(codeDetected) && ai !== codeDetected && !NON_LATIN_LANGS.has(ai)) {
    trace.notes.push(`ngôn ngữ: AI nói "${ai}" nhưng chữ viết của tin là "${codeDetected}" -> dùng "${codeDetected}"`);
    return codeDetected;
  }
  return ai;
}

export interface LlmFirstRequest extends RouteRequest {
  /** kết quả nhận diện bằng code của CHÍNH tin này (null = không kết luận được) — dùng để kiểm lại AI */
  codeDetectedLang: string | null;
}

export async function routeLlmFirst(req: LlmFirstRequest, deps: RouterDeps, opts: { fastPath?: boolean } = {}): Promise<RouteResult> {
  const { index, evaluator, settings, knowledge } = deps;
  const llm = deps.llm;
  if (!llm) return noLlm({ gates: [], ranked: [], candidates: [], notes: [] });
  const last = req.ctx.lastTemplate;
  const matchText = [req.text, req.vision?.error_text].filter(Boolean).join(" ");
  const inp = { text: matchText, norm: req.text === matchText ? req.norm : normalize(matchText), imageType: req.vision?.screen_type, lastTemplateId: last?.id };

  const trace: RouteTrace = { gates: [], ranked: [], candidates: [], notes: [opts.fastPath ? "luồng: workflow hai nhánh (AI xác định ngôn ngữ -> router)" : "luồng: AI hiểu trước"] };
  let queryEnOut: string | undefined;
  const done = (outcome: Outcome, lang?: string): RouteResult => ({ outcome, trace, lang, queryEn: queryEnOut });

  /** SKILL verify-answer: câu trả lời đã duyệt này có trả lời đúng tin của khách không. Lỗi LLM -> Outcome thất bại để trả về ngay. */
  const verifyTemplate = async (templateId: string, why: string | undefined, queryEn?: string): Promise<"ok" | "no" | Outcome> => {
    const t = index.get(templateId);
    const answerText = t ? index.resolveAnswerSource(t).answers.en ?? "" : "";
    try {
      // Câu mẫu của template là cách quản trị viên mô tả các tình huống câu trả lời này dành cho (một template có thể gom nhiều tình huống)
      const intended = t ? [t.item?.title ?? t.group, t.item?.applies_when ?? t.sets_context.issue, ...t.match.examples.slice(0, 6)].filter(Boolean).join(" · ") : undefined;
      const matched = why?.startsWith("từ khoá") ? /từ khoá "([^"]+)"/.exec(why)?.[1] : undefined;
      const text = [req.text, req.vision?.error_text ? `(screenshot text: ${req.vision.error_text})` : ""].filter(Boolean).join(" ");
      const v = await llm.verify({ text, queryEn, lang: req.lang, answer: { id: templateId, text: answerText }, intended, matched, lastAnswer: last ? { id: last.id, text: index.resolveAnswerSource(last).answers.en ?? "" } : undefined, facts: req.ctx.contextPack?.facts });
      trace.notes.push(v.ok ? `kiểm duyệt: AI xác nhận ${templateId} trả lời đúng tin của khách` : `kiểm duyệt: AI KHÔNG xác nhận ${templateId}${v.reason ? ` (${v.reason.slice(0, 100)})` : ""}`);
      return v.ok ? "ok" : "no";
    } catch (e) {
      if (e instanceof LlmUnavailableError && !e.badOutput) return llmFailure(e, 2, trace, last?.id);
      trace.notes.push(`kiểm duyệt lỗi (${(e as Error).message.slice(0, 80)})`);
      return "no";
    }
  };

  // ---- Sticker / emoji / tin quá ngắn: SKILL understand vẫn phải chạy (mất kết nối -> báo mất kết nối); được thì chào như cũ ----
  const noWords = !req.hasImage && (req.isSticker || (req.norm.length === 0 && isEmojiOnly(req.text)) || graphemeLength(req.text) <= settings.tooShortMaxChars);
  if (noWords) {
    try {
      const u0 = await llm.understand({ text: req.text || "(sticker)", knowledgeLang: settings.knowledgeLang, context: req.ctx.contextPack });
      trace.llm = { action: `understand:${u0.intent}` };
      const lang0 = resolveReplyLang(u0.language, req.lang, req.codeDetectedLang, trace);
      trace.notes.push("tin không có nội dung câu hỏi (sticker/emoji/quá ngắn): AI đã đọc, gửi lời chào");
      return done({ kind: "TEMPLATE", templateId: greeting(req), tier: 2, via: "too_short" }, lang0);
    } catch (e) {
      return done(llmFailure(e, 2, trace, last?.id));
    }
  }

  // ---- Luật theo LOẠI ẢNH (vision là SKILL AI đã đọc ảnh): có kèm chữ thì câu trả lời còn phải qua verify-answer ----
  const imageRule = req.hasImage && (!req.norm || index.hitsFor(inp).some((h) => (h.kind === "override" || h.kind === "image") && !isExcluded(index, evaluator, h.templateId, inp)));
  if (imageRule) {
    const r = await route(req, { ...deps, llm: undefined, knowledge: undefined });
    r.trace.notes.unshift("luật theo loại ảnh (ảnh đã được SKILL đọc ảnh phân loại)");
    if (r.outcome.kind !== "TEMPLATE" || !req.norm) return r;
    trace.notes.push(...r.trace.notes);
    const v = await verifyTemplate(r.outcome.templateId, undefined);
    if (v === "ok") return { ...r, trace: { ...r.trace, notes: trace.notes } };
    if (v !== "no") return done(v);
    trace.notes.push("luật theo loại ảnh không được AI xác nhận với lời khách viết kèm -> tìm tiếp bằng AI");
  }

  // ---- 1. AI HIỂU ----
  let u;
  try {
    const lastAnswer = last ? { id: last.id, text: index.resolveAnswerSource(last).answers.en ?? "" } : undefined;
    u = await llm.understand({ text: req.text, imageText: req.vision?.error_text || undefined, knowledgeLang: settings.knowledgeLang, lastAnswer, context: req.ctx.contextPack });
  } catch (e) {
    // KHÔNG quay về khớp từ khoá: nội dung trong kho không bao giờ được gửi thẳng khi AI không đánh giá được
    return done(llmFailure(e, 2, trace, last?.id));
  }
  const lang = resolveReplyLang(u.language, req.lang, req.codeDetectedLang, trace);
  trace.llm = { action: `understand:${u.intent}${u.follow_up !== "none" ? `/${u.follow_up}` : ""}` };
  trace.notes.push(`AI hiểu: ngôn ngữ=${u.language} ý định=${u.intent}${u.follow_up !== "none" ? ` nối tiếp=${u.follow_up}` : ""}`);

  if (u.intent === "offtopic") return done({ kind: "OFFTOPIC", tier: 2, reason: "AI xác định tin ngoài phạm vi InterLink" }, lang);
  if (u.intent === "greeting") return done({ kind: "TEMPLATE", templateId: greeting(req), tier: 2, via: "llm_understand:greeting" }, lang);
  if (u.intent === "unclear") return done({ kind: "ESCALATE", tier: 2, reason: "AI không hiểu được tin nhắn", sourceTemplateId: last?.id }, lang);

  // Tin nối tiếp: AI nhận ra LOẠI phản hồi (mọi ngôn ngữ), luật nghiệp vụ của template quyết định bước tiếp theo
  // Khách đang trả lời câu hỏi lại của bot: ứng viên là đúng các trường hợp đã hỏi (mã cũ không có tiền tố = câu trả lời)
  const pendingRefs = (req.ctx.pendingClarify?.items ?? []).map((x) => (/^[TK]:/.test(x) ? x : `T:${x}`));
  const pending = pendingRefs.filter((r) => r.startsWith("T:")).map((r) => index.get(r.slice(2))).filter((t): t is Template => !!t);
  const pendingChunkIds = pendingRefs.filter((r) => r.startsWith("K:")).map((r) => r.slice(2));
  const clarifying = pendingRefs.length > 0;
  if (u.intent === "follow_up" && u.follow_up !== "none" && (last || u.follow_up === "thanks") && !clarifying) {
    const target = resolveFollowUp(u.follow_up, last);
    trace.followUp = u.follow_up;
    if (target === "ESCALATE") return done({ kind: "ESCALATE", tier: 2, reason: `follow-up (${u.follow_up}) sau template ${last?.id ?? "-"}`, sourceTemplateId: last?.id }, lang);
    if (target && index.get(target)) {
      const v = target === THANKS_TEMPLATE_ID ? "ok" : await verifyTemplate(target, undefined, u.query_en);
      if (v === "ok") return done({ kind: "TEMPLATE", templateId: target, tier: 2, via: `llm_follow_up:${u.follow_up}` }, lang);
      if (v !== "no") return done(v, lang);
    }
    trace.followUp = undefined; // template không có luật cho loại phản hồi này, hoặc AI không xác nhận -> coi như câu hỏi, tìm tiếp
  }

  // Câu truy vấn của AI chỉ dùng để TÌM; vẫn phải qua kiểm tra bằng code (con số, tên sản phẩm, chữ viết). Không đạt -> dùng câu gốc.
  const pack = req.ctx.contextPack;
  const ctxText = pack ? [pack.summary ?? "", ...(pack.facts ?? []), ...pack.events, ...pack.recent.map((m) => m.text)].join(" ") : "";
  const checked = (q: string, qLang: string): string | undefined => {
    const s = maskSensitive(q).replace(/\s+/g, " ").trim().slice(0, 200);
    if (s.length < 3) return undefined;
    const problems = queryProblems(req.text, s, ctxText, qLang);
    if (problems.length) {
      trace.notes.push(`bỏ câu truy vấn ${qLang} của AI (${problems.join("; ")})`);
      return undefined;
    }
    return s;
  };
  const queryEn = checked(u.query_en, "en");
  const queryKb = settings.knowledgeLang === "en" ? queryEn : checked(u.query_kb, settings.knowledgeLang);
  queryEnOut = queryEn;
  if (queryEn) trace.notes.push(`truy vấn (en): "${queryEn}"`);
  if (queryKb && queryKb !== queryEn) trace.notes.push(`truy vấn (${settings.knowledgeLang}): "${queryKb}"`);

  if (clarifying) trace.notes.push(`khách trả lời câu hỏi lại giữa: ${pendingRefs.join(", ")} — chỉ chọn trong các trường hợp này`);

  // ---- ROUTER (chỉ ở luồng hai nhánh): FAST PATH nếu khớp CHẮC CHẮN bằng luật/điều kiện/từ khoá trên câu đã chuẩn hoá ----
  // Khách viết tiếng Anh/Việt: dùng nguyên câu. Ngôn ngữ khác: dùng bản tiếng Anh do AI dịch (đã qua kiểm tra con số, tên sản phẩm).
  // Không có bản chuẩn hoá đạt kiểm tra thì không được đi FAST PATH.
  if (opts.fastPath && !clarifying) {
    const fastText = KEYWORD_LANGS.has(lang) ? req.text : queryEn;
    if (fastText) {
      const fastReq: RouteRequest = { ...req, text: fastText, norm: normalize(fastText), lang: KEYWORD_LANGS.has(lang) ? lang : "en" };
      const fast = await route(fastReq, { ...deps, llm: undefined, knowledge: undefined }); // chỉ luật + từ khoá: không AI, không tìm tri thức
      let why = fastPathReason(fastReq, fast, index);
      // KIỂM DUYỆT (SKILL verify-answer) — BẮT BUỘC với mọi câu trả lời lấy từ kho ở FAST PATH (từ khoá, luật, exact, tin nối tiếp):
      // khớp chỉ nói "có từ trùng", chưa nói "trả lời đúng ý". "no" -> sang nhánh AI/RAG; mất kết nối -> báo mất kết nối.
      if (why && fast.outcome.kind === "TEMPLATE") {
        const v = await verifyTemplate(fast.outcome.templateId, why, queryEn);
        if (v === "no") why = undefined;
        else if (v !== "ok") return done(v, lang);
      }
      if (why) {
        fast.trace.notes.unshift(...trace.notes, `nhánh: FAST PATH — ${why}${fastText === req.text ? "" : ` (khớp trên bản tiếng Anh: "${fastText}")`}`);
        fast.trace.llm = trace.llm;
        return { ...fast, lang, queryEn };
      }
      trace.notes.push(`nhánh: AI/RAG${fast.outcome.kind === "TEMPLATE" ? ` (luật/từ khoá gợi ý ${fast.outcome.templateId} nhưng chưa đủ chắc chắn)` : ""}`);
    } else trace.notes.push("nhánh: AI/RAG (không có bản chuẩn hoá đạt kiểm tra để khớp luật/từ khoá)");
  }

  // ---- 2. TÌM TRONG KHO (code) — khi đang hỏi lại: ứng viên là đúng các trường hợp đã hỏi ----
  const texts = [...new Set([req.text, queryEn].filter((x): x is string => !!x))];
  const scores = new Map<string, number>();
  for (const t of texts) {
    for (const h of index.hitsFor({ text: t, norm: normalize(t), imageType: req.vision?.screen_type, lastTemplateId: last?.id })) scores.set(h.templateId, Math.max(scores.get(h.templateId) ?? 0, 1));
    for (const s of await index.suggest(t, MAX_TEMPLATE_CANDIDATES)) if (s.score >= settings.semanticSuggest) scores.set(s.templateId, Math.max(scores.get(s.templateId) ?? 0, s.score));
  }
  // Cổng requires/excludes áp dụng cho mọi ứng viên, xét trên cả câu gốc lẫn câu tiếng Anh (điều kiện viết bằng tiếng Anh/Việt)
  const gateText = texts.join(" ");
  const gateInp = { ...inp, text: gateText, norm: normalize(gateText) };
  if (clarifying) scores.clear();
  const templates = clarifying ? pending : [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => index.get(id))
    .filter((t): t is Template => !!t && t.response_mode === "EXACT_TEMPLATE" && !isExcluded(index, evaluator, t.id, gateInp) && !missingRequires(index, evaluator, t.id, gateInp))
    .slice(0, MAX_TEMPLATE_CANDIDATES);

  const chunkById = new Map<string, KnowledgeHit>();
  if (clarifying) {
    for (const h of pendingChunkIds.length && knowledge?.byIds ? await knowledge.byIds(pendingChunkIds) : []) chunkById.set(h.chunkId, h);
  } else if (knowledge) {
    const searches: [string, string][] = [[req.text, lang]];
    if (queryKb) searches.push([queryKb, settings.knowledgeLang]);
    if (queryEn && queryEn !== queryKb) searches.push([queryEn, "en"]);
    for (const list of await Promise.all(searches.map(([q, l]) => knowledge.search(q, MAX_CHUNK_CANDIDATES, l)))) {
      for (const h of list) if (h.score >= settings.tier3MinScore && (chunkById.get(h.chunkId)?.score ?? -1) < h.score) chunkById.set(h.chunkId, h);
    }
  }
  const chunks = [...chunkById.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CHUNK_CANDIDATES);

  trace.candidates = [...templates.map((t) => t.id), ...chunks.map((c) => `K:${c.chunkId}`)];
  if (!templates.length && !chunks.length) {
    trace.notes.push("không tìm thấy ứng viên nào trong kho");
    return done({ kind: "ESCALATE", tier: 2, reason: "không tìm được nội dung phù hợp trong kho", sourceTemplateId: last?.id }, lang);
  }

  // ---- 3. AI CHỌN KẾT QUẢ ĐÚNG ----
  const candidates = selectCandidates(templates, chunks, index);
  let pick;
  try {
    pick = await llm.select({ text: req.text, queryEn: queryEn ?? "", lang, candidates, context: pack });
  } catch (e) {
    return done(llmFailure(e, 2, trace, last?.id), lang);
  }
  trace.notes.push(`AI chọn: ${pick.ref}${pick.reason ? ` — ${pick.reason.slice(0, 120)}` : ""}`);
  const ref = pick.ref.trim();
  if (clarifying && !candidates.some((c) => c.ref === ref)) {
    // không hỏi lại lần 2: khách vẫn chưa làm rõ được -> chuyển nhân viên
    return done({ kind: "ESCALATE", tier: 2, reason: "đã hỏi lại khách nhưng vẫn chưa phân biệt được khách cần mục nào", sourceTemplateId: pending[0]?.id ?? last?.id }, lang);
  }
  if (ref === "OFFTOPIC") return done({ kind: "OFFTOPIC", tier: 2, reason: "AI xác định tin ngoài phạm vi InterLink" }, lang);
  if (ref === "ESCALATE") return done({ kind: "ESCALATE", tier: 2, reason: "AI: không tìm được ứng viên nào trả lời đúng câu hỏi", sourceTemplateId: last?.id }, lang);
  if (/^CLARIFY:/i.test(ref)) {
    const refs = [...new Set(ref.slice(8).split(",").map((x) => x.trim()).filter(Boolean).map((x) => (/^[TK]:/.test(x) ? x : `T:${x}`)))];
    const refused = (why: string) => {
      trace.notes.push(`AI muốn hỏi lại khách nhưng ${why} -> chuyển nhân viên`);
      return done({ kind: "ESCALATE", tier: 2, reason: "mơ hồ giữa nhiều template", sourceTemplateId: last?.id }, lang);
    };
    if (!settings.askWhenUnclear) return refused("tính năng hỏi lại đang tắt (episode.ask_when_unclear)");
    if (refs.length < 2 || refs.length > 4) return refused(`số trường hợp không hợp lệ (${refs.length})`);
    if (!refs.every((r) => candidates.some((c) => c.ref === r))) return refused("có trường hợp không nằm trong kết quả tìm kiếm");
    const conflictKey = (r: string) => (r.startsWith("T:") ? `template:${r.slice(2)}` : `chunk:${r.slice(2)}`);
    for (let i = 0; i < refs.length; i++)
      for (let k = i + 1; k < refs.length; k++) {
        const pair = [conflictKey(refs[i]!), conflictKey(refs[k]!)].sort().join("|");
        if (deps.conflicts?.has(pair)) return refused("các trường hợp này đang xung đột chưa giải quyết (không được đưa dữ liệu mâu thuẫn cho khách chọn)");
      }
    return done({ kind: "CLARIFY", tier: 2, question: clarifyQuestion(refs, templates, chunks, index), items: refs }, lang);
  }

  const t = ref.startsWith("T:") ? templates.find((x) => `T:${x.id}` === ref) : undefined;
  const c = ref.startsWith("K:") ? chunks.find((x) => `K:${x.chunkId}` === ref) : undefined;
  if (t) {
    // Cổng ngữ cảnh áp dụng cho MỌI đường: khách quay lại chủ đề đã chuyển support thì không lặp lại chuỗi template.
    if (req.ctx.parentEscalatedGroup && t.group === req.ctx.parentEscalatedGroup) return done({ kind: "ESCALATE", tier: 2, reason: `khách quay lại chủ đề "${t.group}" đã được chuyển support trước đó`, sourceTemplateId: t.id }, lang);
    return done({ kind: "TEMPLATE", templateId: t.id === GREETING_TEMPLATE_ID ? greeting(req) : t.id, tier: 2, via: clarifying ? "clarified" : "llm_select" }, lang);
  }
  if (!c) {
    trace.notes.push(`AI chọn ref không có trong danh sách: ${ref.slice(0, 60)}`);
    return done({ kind: "ESCALATE", tier: 2, reason: "LLM chọn template ngoài danh sách cho phép", sourceTemplateId: last?.id }, lang);
  }
  const answer = `${c.text}${c.url ? `\n\n${c.url}` : ""}`;
  const chk = checkOutput(answer, { urlHostWhitelist: settings.urlHostWhitelist });
  if (!chk.ok) {
    trace.notes.push(`đầu ra bị chặn: ${chk.problems.join("; ")}`);
    return done({ kind: "ESCALATE", tier: 3, reason: "đoạn tri thức không qua kiểm tra đầu ra" }, lang);
  }
  // Chế độ sinh: AI VIẾT câu trả lời bằng ngôn ngữ của khách từ đoạn đã chọn (và các đoạn ứng viên khác), có trích dẫn.
  // Code kiểm: phải trích đúng đoạn đã chọn, không số liệu ngoài nguồn, không dự đoán giá/ROI, link trong danh sách, đúng chữ viết của ngôn ngữ khách.
  // Không đạt -> gửi nguyên văn đoạn đã chọn (dịch trung thành) như chế độ trích.
  if (settings.tier3Mode === "generative") {
    try {
      const g = await llm.grounded({ question: req.text, standalone: queryEn, lang, chunks: [c, ...chunks.filter((x) => x.chunkId !== c.chunkId)].map((h) => ({ id: h.chunkId, heading: h.heading, text: h.text, url: h.url })) });
      const validIds = new Set(chunks.map((h) => h.chunkId));
      const cited = g.cited.filter((id) => validIds.has(id));
      const problems: string[] = [];
      if (!g.answerable || !g.answer.trim()) problems.push("AI không viết được câu trả lời từ tài liệu");
      if (!cited.length) problems.push("câu trả lời không trích đoạn nào trong danh sách ứng viên");
      else if (!cited.includes(c.chunkId)) trace.notes.push(`AI viết dựa trên đoạn ${cited.join(",")} thay vì đoạn đã chọn ${c.chunkId} (đều là tài liệu đã duyệt)`);
      const chk = checkOutput(g.answer, { urlHostWhitelist: settings.urlHostWhitelist, forbidFinancialClaims: true });
      if (!chk.ok) problems.push(...chk.problems);
      const invented = numbersNotIn(g.answer, chunks.filter((h) => cited.includes(h.chunkId)).map((h) => `${h.heading}\n${h.text}\n${h.url ?? ""}`));
      if (invented.length) problems.push(`số liệu không có trong tài liệu: ${invented.join(", ")}`);
      const script = scriptProblem(g.answer, lang);
      if (script) problems.push(script);
      if (!problems.length) {
        trace.notes.push(`AI viết câu trả lời từ ${cited.length} đoạn (đã kiểm: trích dẫn, số liệu, link, ngôn ngữ)`);
        const src = chunks.filter((h) => cited.includes(h.chunkId)).map((h) => ({ chunkId: h.chunkId, docSlug: h.docSlug, heading: h.heading, url: h.url }));
        return done({ kind: "GROUNDED", tier: 3, answer: g.answer, mode: "generative", sourceLang: lang, sourceHash: sha1(c.text), sources: src }, lang);
      }
      trace.notes.push(`câu AI viết bị chặn (${problems.join("; ")}) -> gửi nguyên văn đoạn đã chọn`);
    } catch (e) {
      trace.notes.push(`AI viết câu trả lời lỗi (${(e as Error).message.slice(0, 80)}) -> gửi nguyên văn đoạn đã chọn`);
    }
  }
  return done({ kind: "GROUNDED", tier: 3, answer, mode: "extractive", sourceLang: hitLang(c), sourceHash: sha1(c.text), sources: [{ chunkId: c.chunkId, docSlug: c.docSlug, heading: c.heading, url: c.url }] }, lang);
}
