/**
 * Cổng quyết định (Decision Gate). Router chỉ ĐỀ XUẤT ứng viên; module này quyết định ứng viên nào được phép gửi.
 * Các bước là cổng đúng/sai theo thứ tự, ghi lại lý do để Admin xem "vì sao bot trả lời thế này".
 *
 *   1 Bảo mật (do pipeline xử lý trước: FP-0, chặn spam)   4 response_mode
 *   2 requires / excludes                                    5 xếp hạng -> CONFIDENT | AMBIGUOUS | NO_MATCH
 *   3 tương thích ngữ cảnh                                   6 kiểm tra đầu ra (checkOutput)
 */
import type { Condition, Template } from "../domain/types";
import { makeInput, type Evaluator } from "./predicates";
import type { Hit, IndexInput, Suggestion, TemplateIndex } from "./template-index";

export interface GateSettings {
  semanticConfident: number; // điểm tối thiểu để tin một ứng viên chỉ-ngữ-nghĩa
  semanticMargin: number; // chênh lệch tối thiểu với ứng viên kế tiếp
  semanticSuggest: number; // dưới mức này coi là không có ứng viên
}

export const DEFAULT_GATE_SETTINGS: GateSettings = { semanticConfident: 0.82, semanticMargin: 0.08, semanticSuggest: 0.35 };

export interface GateContext {
  lastTemplateId?: string;
  /** topic_group của episode cha đã escalate gần đây (khách quay lại cùng chủ đề) */
  parentEscalatedGroup?: string;
}

export interface GateStep {
  gate: number;
  name: string;
  removed: { templateId: string; reason: string }[];
}

export type GateVerdict =
  | { verdict: "MATCH_CONFIDENT"; templateId: string; via: string; ticketFromParent?: boolean }
  | { verdict: "MATCH_AMBIGUOUS"; candidates: string[] }
  | { verdict: "NO_MATCH" }
  | { verdict: "ESCALATE"; reason: string; sourceTemplateId?: string };

export interface GateResult {
  result: GateVerdict;
  steps: GateStep[];
  ranked: { templateId: string; kind: string; priority: number; phraseLen: number }[];
}

const NON_TOPIC_GROUPS = new Set(["Greeting", "FollowUp", "System", "Image", "Security", "AntiSpam", "Escalate"]);

function describe(c: Condition): string {
  return typeof c === "string" ? c : JSON.stringify(c);
}

export function decide(
  hits: Hit[],
  suggestions: Suggestion[],
  inp: IndexInput,
  index: TemplateIndex,
  evaluator: Evaluator,
  ctx: GateContext,
  settings: GateSettings = DEFAULT_GATE_SETTINGS,
): GateResult {
  const steps: GateStep[] = [];
  const evalInp = makeInput(inp.text, { imageType: inp.imageType, lastTemplateId: ctx.lastTemplateId ?? inp.lastTemplateId });
  evalInp.norm = inp.norm;

  // ---- Cổng 2: requires / excludes ----
  const g2: GateStep = { gate: 2, name: "requires/excludes", removed: [] };
  let alive: Hit[] = [];
  for (const h of hits) {
    const t = index.get(h.templateId)!;
    const excluded = t.match.excludes.find((c) => evaluator.evalCondition(c, evalInp));
    if (excluded !== undefined) {
      g2.removed.push({ templateId: t.id, reason: `excludes: ${describe(excluded)}` });
      continue;
    }
    // requires chỉ áp cho khớp theo từ khoá; rule/ảnh/exact đã tự mang điều kiện của chúng.
    if (h.kind === "keyword") {
      const missing = t.match.requires.find((c) => !evaluator.evalCondition(c, evalInp));
      if (missing !== undefined) {
        g2.removed.push({ templateId: t.id, reason: `requires chưa thoả: ${describe(missing)}` });
        continue;
      }
    }
    alive.push(h);
  }
  steps.push(g2);

  // ---- Cổng 3: ngữ cảnh ----
  const g3: GateStep = { gate: 3, name: "ngữ cảnh", removed: [] };
  const hasOverride = alive.some((h) => h.kind === "override");
  if (ctx.parentEscalatedGroup && !hasOverride) {
    const sameTopic = alive.find((h) => {
      const t = index.get(h.templateId)!;
      return t.group === ctx.parentEscalatedGroup && !NON_TOPIC_GROUPS.has(t.group);
    });
    if (sameTopic) {
      return {
        result: { verdict: "ESCALATE", reason: `khách quay lại chủ đề "${ctx.parentEscalatedGroup}" đã được chuyển support trước đó`, sourceTemplateId: sameTopic.templateId },
        steps: [...steps, g3],
        ranked: [],
      };
    }
  }
  steps.push(g3);

  // ---- Cổng 4: response_mode ----
  const g4: GateStep = { gate: 4, name: "response_mode", removed: [] };
  alive = alive.filter((h) => {
    const t = index.get(h.templateId)!;
    if (t.response_mode !== "EXACT_TEMPLATE") {
      g4.removed.push({ templateId: t.id, reason: `response_mode=${t.response_mode} không được gửi qua đường template` });
      return false;
    }
    return true;
  });
  steps.push(g4);

  // ---- Cổng 5: xếp hạng ----
  const rank = (a: Hit, b: Hit) => Number(b.kind === "override") - Number(a.kind === "override") || Number(!!a.loose) - Number(!!b.loose) || b.priority - a.priority || b.phraseLen - a.phraseLen;
  const perTemplate = new Map<string, Hit>();
  for (const h of [...alive].sort(rank)) if (!perTemplate.has(h.templateId)) perTemplate.set(h.templateId, h);
  const ranked = [...perTemplate.values()].sort(rank);
  const rankedView = ranked.map((h) => ({ templateId: h.templateId, kind: h.kind, priority: h.priority, phraseLen: h.phraseLen }));

  if (ranked.length > 0) {
    const [top, second] = ranked;
    const tie = second && top!.kind !== "override" && second.kind === top!.kind && !!second.loose === !!top!.loose && second.priority === top!.priority && second.phraseLen === top!.phraseLen;
    if (tie) return { result: { verdict: "MATCH_AMBIGUOUS", candidates: ranked.slice(0, 5).map((h) => h.templateId) }, steps, ranked: rankedView };
    return { result: { verdict: "MATCH_CONFIDENT", templateId: top!.templateId, via: top!.kind }, steps, ranked: rankedView };
  }

  // Không có ứng viên xác định -> chỉ còn xếp hạng ngữ nghĩa (chỉ gợi ý; chỉ tin khi rất rõ ràng)
  const eligible = suggestions.filter((s) => {
    const t = index.get(s.templateId)!;
    if (t.match.excludes.some((c) => evaluator.evalCondition(c, evalInp))) return false;
    return t.response_mode === "EXACT_TEMPLATE" && t.match.examples.length > 0;
  });
  const [s1, s2] = eligible;
  if (s1 && s1.score >= settings.semanticConfident && (!s2 || s1.score - s2.score >= settings.semanticMargin)) {
    return { result: { verdict: "MATCH_CONFIDENT", templateId: s1.templateId, via: "semantic" }, steps, ranked: [{ templateId: s1.templateId, kind: "semantic", priority: 0, phraseLen: 0 }] };
  }
  if (s1 && s1.score >= settings.semanticSuggest) {
    return { result: { verdict: "MATCH_AMBIGUOUS", candidates: eligible.slice(0, 5).map((s) => s.templateId) }, steps, ranked: [] };
  }
  return { result: { verdict: "NO_MATCH" }, steps, ranked: [] };
}

// ---- Cổng 6: kiểm tra đầu ra ----
export const TELEGRAM_MAX_CHARS = 4096;

export interface OutputCheckOptions {
  urlHostWhitelist: Set<string>;
  maxChars?: number;
  /** Cấm số liệu giá/ROI/công thức HCS trong câu do LLM sinh (SKILL.md: KHÔNG dự đoán giá / ROI / lợi nhuận). */
  forbidFinancialClaims?: boolean;
}

const URL_RE = /\bhttps?:\/\/[^\s)>\]"']+/gi;
const PRICE_CLAIM = /(\$\s?\d[\d.,]*\s*(?:per|\/)\s*(?:itl|itlg)|\b(?:itl|itlg)\b[^.\n]{0,40}\b(?:will|sẽ)\b[^.\n]{0,30}\$\s?\d|\broi\b|\b\d+\s?x\b\s*(?:return|lợi nhuận)|guaranteed (?:profit|return)|lợi nhuận chắc chắn)/i;
const HCS_FORMULA = /\bhcs\b[^.\n]{0,80}(?:=|formula|công thức)[^.\n]{0,80}[+*/×]/i;

export function urlHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    try {
      hosts.push(new URL(m[0].replace(/[.,;:!?]+$/, "")).hostname.toLowerCase());
    } catch {
      /* URL hỏng: bị bắt ở checkOutput */
    }
  }
  return hosts;
}

export function checkOutput(text: string, opt: OutputCheckOptions): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!text.trim()) problems.push("câu trả lời rỗng");
  if (text.length > (opt.maxChars ?? TELEGRAM_MAX_CHARS)) problems.push(`vượt ${opt.maxChars ?? TELEGRAM_MAX_CHARS} ký tự`);
  for (const h of urlHosts(text)) if (!opt.urlHostWhitelist.has(h)) problems.push(`URL ngoài whitelist: ${h}`);
  if (opt.forbidFinancialClaims) {
    if (PRICE_CLAIM.test(text)) problems.push("có dự đoán giá/ROI/lợi nhuận");
    if (HCS_FORMULA.test(text)) problems.push("có công thức HCS");
  }
  return { ok: problems.length === 0, problems };
}

/** Các host xuất hiện trong nội dung đã duyệt => tạo thành whitelist tự động. */
export function collectHosts(texts: string[]): Set<string> {
  const s = new Set<string>();
  for (const t of texts) for (const h of urlHosts(t)) s.add(h);
  return s;
}

export type { Template };
