/**
 * Render Markdown ĐÚNG cú pháp hệ thống từ kết quả có cấu trúc của SKILL intake-draft (src/core/ports.ts IntakeDraftResult).
 * Cố ý KHÔNG để AI tự viết Markdown/YAML — một lỗi thụt lề/thiếu dấu ngoặc là hỏng cả file; ở đây AI chỉ trả về các trường
 * (id, group, keywords, examples, answer_en / heading, body), code lắp ráp bằng đúng serializer đã có (`templatesToMarkdown`,
 * dùng chung với trình soạn thảo hiện có) nên luôn ra cú pháp hợp lệ.
 */
import { stringify as stringifyYaml } from "yaml";
import { templatesToMarkdown } from "../core/templates";
import type { Template } from "../domain/types";
import type { IntakeDraftResult } from "../core/ports";

const EMPTY_MATCH: Pick<Template["match"], "exact" | "image_types" | "rules" | "requires" | "excludes" | "overrides_context"> = {
  exact: [],
  image_types: [],
  rules: [],
  requires: [],
  excludes: [],
  overrides_context: false,
};

/** Ưu tiên mặc định cho template mới từ luồng nạp nội dung: dưới mọi FP/esc có sẵn (900-750), trên mức "chưa ai chỉnh" (0). */
export const INTAKE_DEFAULT_PRIORITY = 300;

export function renderTemplateMarkdown(r: IntakeDraftResult): string {
  const templates: Template[] = r.templates.map((t) => ({
    id: t.id,
    group: t.group,
    response_mode: "EXACT_TEMPLATE",
    priority: INTAKE_DEFAULT_PRIORITY,
    match: { keywords: t.keywords, examples: t.examples, ...EMPTY_MATCH },
    answers: { en: t.answer_en },
    follow_up: {},
    sets_context: { status: "pending" },
  }));
  return templatesToMarkdown(templates);
}

export function renderKnowledgeMarkdown(r: IntakeDraftResult): string {
  const k = r.knowledge;
  if (!k) throw new Error("renderKnowledgeMarkdown: thiếu trường knowledge (kind phải là \"knowledge\")");
  const front = stringifyYaml({ slug: r.slug, title: r.title, response_mode: "GROUNDED_GENERATION", lang: k.lang }, { lineWidth: 0 }).trimEnd();
  const body = k.sections.map((s) => `## ${s.heading}\n\n${s.body.trim()}`).join("\n\n");
  return `---\n${front}\n---\n${body}\n`;
}

/** Render đúng theo `kind` — điểm vào duy nhất dùng từ route intake. */
export function renderIntakeMarkdown(r: IntakeDraftResult): string {
  return r.kind === "knowledge" ? renderKnowledgeMarkdown(r) : renderTemplateMarkdown(r);
}
