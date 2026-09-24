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
import type { KnowledgeItem } from "../core/items";
import { normalize, wordCount } from "../core/text";
import { GROUP_TOPIC } from "./migrate-items";

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

/**
 * Kết quả SKILL intake-draft loại "câu trả lời" -> mục hỏi đáp (src/core/items.ts), mỗi mục kèm chủ đề. Người dùng không chọn
 * loại hay chủ đề: nhóm AI đề xuất được quy về danh sách chủ đề cố định (GROUP_TOPIC), không khớp thì "general".
 * Từ khoá một từ bị bỏ (nguyên nhân trả lời nhầm); từ khoá nhiều từ vừa là cụm nhận biết vừa là một cách hỏi.
 */
export function intakeToItems(r: IntakeDraftResult): { topic: string; item: KnowledgeItem }[] {
  const byLower = new Map(Object.entries(GROUP_TOPIC).map(([g, t]) => [g.toLowerCase(), t]));
  return r.templates.map((t) => {
    const phrases = [...new Set(t.keywords.map((k) => k.trim()).filter((k) => wordCount(normalize(k)) >= 2))];
    const questions: string[] = [];
    for (const q of [...t.examples, ...phrases]) if (q.trim() && !questions.some((x) => normalize(x) === normalize(q))) questions.push(q.trim());
    const title = r.templates.length === 1 && r.title.trim() ? r.title.trim() : t.examples[0]?.trim() || t.id;
    return {
      topic: byLower.get(t.group.trim().toLowerCase()) ?? "general",
      item: { id: t.id, title, kind: "answer", questions, phrases, distinct_from: [], steps: [{ say: { en: t.answer_en.trim() } }] },
    };
  });
}
