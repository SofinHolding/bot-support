/**
 * Định dạng file template `.md` (Admin upload):
 *
 *   ---
 *   id: fp-2-withdraw
 *   group: Withdraw
 *   response_mode: EXACT_TEMPLATE
 *   priority: 880
 *   match: { keywords: [...] }
 *   follow_up: { negative: ESCALATE }
 *   ---
 *   <!-- answer:en -->
 *   Câu trả lời nguyên văn...
 *   <!-- answer:vi -->
 *   ...
 *   <!-- next -->
 *   (template tiếp theo trong cùng file)
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Condition, ParseIssue, ResponseMode, Template } from "../domain/types";

export const NEXT_MARKER = "<!-- next -->";
const RESPONSE_MODES: ResponseMode[] = ["SECURITY_RULE", "EXACT_TEMPLATE", "GROUNDED_GENERATION"];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
export const FOLLOW_UP_KINDS = ["thanks", "negative", "more_images", "not_receive", "no_old_email", "info_provided"] as const;

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function asConditions(v: unknown): Condition[] {
  return Array.isArray(v) ? (v as Condition[]) : [];
}

function splitAnswers(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^<!--\s*answer:([a-zA-Z-]+)\s*-->\s*$/gm;
  const marks: { lang: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) marks.push({ lang: m[1]!.toLowerCase(), start: m.index, end: m.index + m[0].length });
  marks.forEach((mk, i) => {
    const next = marks[i + 1];
    const text = body.slice(mk.end, next ? next.start : body.length);
    // chỉ cắt dòng trống đầu/cuối, giữ nguyên mọi ký tự bên trong
    out[mk.lang] = text.replace(/^\s*\n/, "").replace(/\s+$/, "");
  });
  return out;
}

export function parseTemplateFile(md: string, source?: string): { templates: Template[]; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const templates: Template[] = [];
  const text = md.replace(/\r\n/g, "\n");
  const parts = text.split(new RegExp(`^${NEXT_MARKER}\\s*$`, "m"));

  parts.forEach((part, idx) => {
    const trimmed = part.replace(/^\s+/, "");
    if (!trimmed) return;
    const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(trimmed);
    if (!fm) {
      issues.push({ level: "error", message: `Khối #${idx + 1}: thiếu frontmatter (--- ... ---)` });
      return;
    }
    let meta: Record<string, unknown>;
    try {
      meta = (parseYaml(fm[1]!) ?? {}) as Record<string, unknown>;
    } catch (e) {
      issues.push({ level: "error", message: `Khối #${idx + 1}: YAML không hợp lệ: ${(e as Error).message}` });
      return;
    }
    const id = String(meta.id ?? "");
    if (!ID_RE.test(id)) {
      issues.push({ level: "error", templateId: id || undefined, message: `Khối #${idx + 1}: id thiếu hoặc không hợp lệ (chữ thường, số, gạch ngang)` });
      return;
    }
    const mode = String(meta.response_mode ?? "") as ResponseMode;
    if (!RESPONSE_MODES.includes(mode)) {
      issues.push({ level: "error", templateId: id, message: `response_mode bắt buộc và phải là ${RESPONSE_MODES.join(" | ")}` });
      return;
    }
    if (!meta.group) issues.push({ level: "error", templateId: id, message: "thiếu group" });

    const m = (meta.match ?? {}) as Record<string, unknown>;
    const sc = (meta.sets_context ?? {}) as Record<string, unknown>;
    const answers = splitAnswers(fm[2]!);
    const answerFrom = meta.answer_from ? String(meta.answer_from) : undefined;
    if (!answerFrom && !answers.en) {
      issues.push({ level: "error", templateId: id, message: "thiếu <!-- answer:en --> (bản gốc bắt buộc) hoặc answer_from" });
    }
    const status = String(sc.status ?? "pending");
    if (!["pending", "resolved", "none"].includes(status)) {
      issues.push({ level: "error", templateId: id, message: `sets_context.status không hợp lệ: ${status}` });
    }

    templates.push({
      id,
      group: String(meta.group ?? ""),
      response_mode: mode,
      priority: Number(meta.priority ?? 0),
      match: {
        keywords: asStringArray(m.keywords),
        exact: asStringArray(m.exact),
        examples: asStringArray(m.examples),
        image_types: asStringArray(m.image_types),
        rules: Array.isArray(m.rules) ? (m.rules as { all: Condition[] }[]) : [],
        requires: asConditions(m.requires),
        excludes: asConditions(m.excludes),
        overrides_context: m.overrides_context === true,
      },
      answers,
      answer_from: answerFrom,
      follow_up: Object.fromEntries(Object.entries((meta.follow_up ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)])),
      sets_context: { issue: sc.issue ? String(sc.issue) : undefined, status: status as "pending" | "resolved" | "none" },
      ticket: meta.ticket ? (meta.ticket as Template["ticket"]) : undefined,
      required_info: meta.required_info ? asStringArray(meta.required_info) : undefined,
      source: meta.source ? String(meta.source) : source,
    });
  });
  return { templates, issues };
}

/** Kiểm tra chéo cả bộ: id trùng, follow_up/answer_from trỏ đúng, predicate tồn tại, regex hợp lệ. */
export function validateBundle(templates: Template[], predicateNames: Set<string>): ParseIssue[] {
  const issues: ParseIssue[] = [];
  const ids = new Map<string, number>();
  for (const t of templates) ids.set(t.id, (ids.get(t.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) issues.push({ level: "error", templateId: id, message: `id bị trùng ${n} lần` });

  const checkCond = (t: Template, c: Condition, where: string) => {
    if (typeof c === "string") {
      if (!predicateNames.has(c)) issues.push({ level: "error", templateId: t.id, message: `${where}: predicate không tồn tại: ${c}` });
    } else if ("regex" in c) {
      try {
        new RegExp(c.regex, c.flags ?? "iu");
      } catch {
        issues.push({ level: "error", templateId: t.id, message: `${where}: regex không hợp lệ: ${c.regex}` });
      }
    } else if ("last_template" in c) {
      const list = Array.isArray(c.last_template) ? c.last_template : [c.last_template];
      for (const x of list) if (!ids.has(x)) issues.push({ level: "warning", templateId: t.id, message: `${where}: last_template không có trong bộ này: ${x}` });
    }
  };

  for (const t of templates) {
    if (t.answer_from && !ids.has(t.answer_from)) issues.push({ level: "error", templateId: t.id, message: `answer_from trỏ tới id không tồn tại: ${t.answer_from}` });
    for (const [kind, target] of Object.entries(t.follow_up)) {
      if (!(FOLLOW_UP_KINDS as readonly string[]).includes(kind)) issues.push({ level: "warning", templateId: t.id, message: `follow_up loại lạ: ${kind}` });
      if (target !== "ESCALATE" && !ids.has(target)) issues.push({ level: "error", templateId: t.id, message: `follow_up.${kind} trỏ tới id không tồn tại: ${target}` });
    }
    for (const c of t.match.requires) checkCond(t, c, "requires");
    for (const c of t.match.excludes) checkCond(t, c, "excludes");
    t.match.rules.forEach((r, i) => r.all.forEach((c) => checkCond(t, c, `rules[${i}]`)));
    if (t.response_mode === "EXACT_TEMPLATE" && !t.answer_from && Object.keys(t.answers).length === 0) {
      issues.push({ level: "error", templateId: t.id, message: "EXACT_TEMPLATE không có câu trả lời" });
    }
  }
  return issues;
}

export function templateToMarkdown(t: Template): string {
  const meta: Record<string, unknown> = {
    id: t.id,
    group: t.group,
    response_mode: t.response_mode,
    priority: t.priority,
  };
  if (t.source) meta.source = t.source;
  const m: Record<string, unknown> = {};
  if (t.match.keywords.length) m.keywords = t.match.keywords;
  if (t.match.exact.length) m.exact = t.match.exact;
  if (t.match.examples.length) m.examples = t.match.examples;
  if (t.match.image_types.length) m.image_types = t.match.image_types;
  if (t.match.rules.length) m.rules = t.match.rules;
  if (t.match.requires.length) m.requires = t.match.requires;
  if (t.match.excludes.length) m.excludes = t.match.excludes;
  if (t.match.overrides_context) m.overrides_context = true;
  if (Object.keys(m).length) meta.match = m;
  if (t.answer_from) meta.answer_from = t.answer_from;
  if (Object.keys(t.follow_up).length) meta.follow_up = t.follow_up;
  meta.sets_context = { ...(t.sets_context.issue ? { issue: t.sets_context.issue } : {}), status: t.sets_context.status };
  if (t.ticket) meta.ticket = t.ticket;
  if (t.required_info) meta.required_info = t.required_info;

  const fm = stringifyYaml(meta, { lineWidth: 0 }).trimEnd();
  const body = Object.entries(t.answers)
    .map(([lang, text]) => `<!-- answer:${lang} -->\n${text}`)
    .join("\n");
  return `---\n${fm}\n---\n${body}\n`;
}

export function templatesToMarkdown(ts: Template[]): string {
  return ts.map(templateToMarkdown).join(`${NEXT_MARKER}\n`);
}
