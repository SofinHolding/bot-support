/**
 * Một note trong vault: frontmatter theo references/frontmatter-schema.md của skill + thân Markdown (heading `##` cho từng ý con).
 * AI không viết YAML: code dựng note từ các trường có cấu trúc (renderNote), nên `related` luôn là danh sách chuỗi có ngoặc kép.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { sha1 } from "../core/knowledge";

export const NOTE_STATUSES = ["draft", "confirmed", "provisional", "awaiting_approval", "superseded"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];
/** Chỉ các trạng thái này được vào chỉ mục tìm kiếm và dùng để trả lời khách. */
export const SERVABLE: readonly NoteStatus[] = ["confirmed", "provisional"];

export interface NoteMeta {
  id: string;
  title: string;
  category: string;
  tags: string[];
  status: NoteStatus;
  lang_source: string;
  source_file: string;
  /** Vị trí trong file gốc (sheet/dòng, heading) — để người duyệt đối chiếu khi có xung đột. */
  source_refs: string[];
  ingested_at: string;
  version_group: string;
  supersedes: string | string[] | null;
  conflict_ref: string | null;
  /** Dạng "[[<id>|<tiêu đề>]]": Obsidian mở đúng file `<id>.md`, code đọc id trước dấu "|". */
  related: string[];
  summary: string;
  keywords: string[];
  canonical_title: string;
  canonical_summary: string;
  canonical_keywords: string[];
}

export interface VaultNote {
  meta: NoteMeta;
  body: string;
}

export const NOTE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const FIELD_ORDER: (keyof NoteMeta)[] = [
  "id", "title", "category", "tags", "status", "lang_source", "source_file", "source_refs", "ingested_at", "version_group", "supersedes", "conflict_ref", "related",
  "summary", "keywords", "canonical_title", "canonical_summary", "canonical_keywords",
];

export const relatedLink = (id: string, title?: string) => `[[${id}${title && title !== id ? `|${title}` : ""}]]`;

/** "[[id|Tiêu đề]]" / "[[Tiêu đề]]" -> phần trước "|" (id hoặc tên note). */
export function relatedTarget(link: string): string {
  const inner = link.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  return inner.split("|")[0]!.trim();
}

export function sectionsToBody(sections: { heading: string; body: string }[]): string {
  if (sections.length === 1 && !sections[0]!.heading.trim()) return sections[0]!.body.trim();
  return sections.map((s) => (s.heading.trim() ? `## ${s.heading.trim()}\n\n${s.body.trim()}` : s.body.trim())).join("\n\n");
}

export function renderNote(n: VaultNote): string {
  const ordered: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) ordered[k] = n.meta[k] ?? null;
  const front = stringifyYaml(ordered, { lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" }).trimEnd();
  return `---\n${front}\n---\n${n.body.trim()}\n`;
}

export class NoteParseError extends Error {}

export function parseNote(md: string): VaultNote {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md.replace(/^﻿/, "").trimStart());
  if (!m) throw new NoteParseError("note thiếu frontmatter: thêm khối --- ... --- ở đầu file");
  let meta: Record<string, unknown>;
  try {
    meta = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new NoteParseError(`frontmatter không đọc được (${(e as Error).message.split("\n")[0]}). Kiểm tra "related" phải viết dạng ["[[Tên note]]"], có ngoặc kép`);
  }
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String(x))) : []);
  const str = (v: unknown) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v));
  const sup = meta.supersedes;
  return {
    meta: {
      id: str(meta.id),
      title: str(meta.title),
      category: str(meta.category),
      tags: arr(meta.tags),
      status: str(meta.status) as NoteStatus,
      lang_source: str(meta.lang_source),
      source_file: str(meta.source_file),
      source_refs: arr(meta.source_refs),
      ingested_at: str(meta.ingested_at),
      version_group: str(meta.version_group),
      supersedes: Array.isArray(sup) ? arr(sup) : sup ? str(sup) : null,
      conflict_ref: meta.conflict_ref ? str(meta.conflict_ref) : null,
      // giữ nguyên kiểu gốc để validateNote bắt được related sai (danh sách lồng nhau khi thiếu ngoặc kép)
      related: (Array.isArray(meta.related) ? meta.related : meta.related ? [meta.related] : []) as string[],
      summary: str(meta.summary),
      keywords: arr(meta.keywords),
      canonical_title: str(meta.canonical_title),
      canonical_summary: str(meta.canonical_summary),
      canonical_keywords: arr(meta.canonical_keywords),
    },
    body: m[2]!.trim(),
  };
}

const REQUIRED: (keyof NoteMeta)[] = ["id", "title", "category", "status", "lang_source", "ingested_at", "version_group", "summary", "keywords", "canonical_title", "canonical_summary", "canonical_keywords"];

/** Tương đương validate.py (trang Notion "Hướng dẫn vector dataset" mục 3). Mỗi lỗi nói cần sửa gì. */
export function validateNote(n: VaultNote): string[] {
  const m = n.meta;
  const errors: string[] = [];
  for (const k of REQUIRED) {
    const v = m[k];
    if (v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length)) errors.push(`thiếu trường ${k}: chạy lại skill nạp dữ liệu hoặc bổ sung tay`);
  }
  if (m.id && !NOTE_ID_RE.test(m.id)) errors.push(`id "${m.id}" không hợp lệ: chỉ dùng chữ thường không dấu, số và dấu gạch ngang`);
  if (m.status && !(NOTE_STATUSES as readonly string[]).includes(m.status)) errors.push(`status "${m.status}" không hợp lệ: dùng một trong ${NOTE_STATUSES.join(", ")}`);
  if (m.ingested_at && Number.isNaN(Date.parse(m.ingested_at))) errors.push("ingested_at không phải thời điểm ISO 8601: ghi dạng 2026-09-28T10:00:00+07:00");
  if (!Array.isArray(m.related) || !m.related.every((r) => typeof r === "string")) errors.push('related phải là danh sách chuỗi có ngoặc kép, ví dụ ["[[Tên note]]"]');
  else if (m.related.length > 5) errors.push("related có hơn 5 liên kết: tách note nhỏ hơn hoặc bỏ bớt liên kết");
  if (!n.body.trim()) errors.push("thân note trống: thêm nội dung trả lời");
  return errors;
}

/** sha1 của thân note và canonical_summary (index.json `content_hash`): đổi nội dung hay bản chuẩn hoá đều làm hash đổi. */
export const noteContentHash = (n: VaultNote) => sha1(`${n.body.trim()}\n${n.meta.canonical_summary.trim()}`);

export const relatedIds = (n: VaultNote) => n.meta.related.filter((r) => typeof r === "string").map(relatedTarget).filter(Boolean);
