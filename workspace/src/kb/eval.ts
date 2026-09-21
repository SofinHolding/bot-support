/** Chạy bộ câu hỏi mẫu (eval_cases) qua router tầng 0-1 (không LLM) để đo độ chính xác và phát hiện thay đổi khi publish. */
import { DEFAULT_ROUTER_SETTINGS, route, type Outcome, type RouteResult, type RouterSettings } from "../core/router";
import type { Evaluator } from "../core/predicates";
import type { TemplateIndex } from "../core/template-index";
import { normalize } from "../core/text";
import type { VisionScreenType } from "../domain/types";

export interface EvalCase {
  id?: number;
  question: string;
  expected_template_id: string | null; // null = kỳ vọng ESCALATE
  image_type?: string | null;
  lang?: string | null;
}

export interface EvalRow {
  question: string;
  expected: string;
  got: string;
  ok: boolean;
}

export const outcomeKey = (o: Outcome): string => (o.kind === "TEMPLATE" ? o.templateId : o.kind);

export function evalSettings(hosts: Set<string> = new Set()): RouterSettings {
  return { ...DEFAULT_ROUTER_SETTINGS, urlHostWhitelist: hosts };
}

/** Định tuyến một câu hỏi mà không cần LLM/tri thức (tầng 0-1). */
export async function routeOffline(question: string, imageType: string | null | undefined, index: TemplateIndex, evaluator: Evaluator, settings: RouterSettings, lastTemplateId?: string): Promise<RouteResult> {
  return route(
    {
      text: question,
      norm: normalize(question),
      lang: "en",
      vision: imageType ? { screen_type: imageType as VisionScreenType, error_text: "", has_secret: false, readable: true } : undefined,
      hasImage: !!imageType,
      isSticker: false,
      ctx: { lastTemplate: lastTemplateId ? index.get(lastTemplateId) : undefined },
    },
    { index, evaluator, settings },
  );
}

export async function runEval(cases: EvalCase[], index: TemplateIndex, evaluator: Evaluator, settings = evalSettings()): Promise<{ rows: EvalRow[]; correct: number; total: number }> {
  const rows: EvalRow[] = [];
  for (const c of cases) {
    const r = await routeOffline(c.question, c.image_type, index, evaluator, settings);
    const got = outcomeKey(r.outcome);
    const expected = c.expected_template_id ?? "ESCALATE";
    rows.push({ question: c.question, expected, got, ok: got === expected });
  }
  return { rows, correct: rows.filter((r) => r.ok).length, total: rows.length };
}
