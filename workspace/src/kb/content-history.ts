/**
 * Lịch sử theo TỪNG PHẦN của nội dung (yêu cầu §5): mỗi khi một phiên bản được áp dụng (publish / rollback), so từng phần của
 * từng nội dung với bản đang chạy trước đó — chỉ phần thật sự đổi mới nhận mốc thời gian mới; phần không đổi giữ mốc cũ.
 * Lần đầu một tài liệu có lịch sử (dữ liệu V1), mọi phần được ghi là "khởi tạo".
 *
 * "Phần" đặt tên bằng lời thường cho người đọc (Cách khách hỏi, Trả lời bước 1, Điều kiện...), giá trị là chữ đọc được.
 * Hàm ở đây thuần: không đọc DB, không gọi AI.
 */
import type { KnowledgeChunk } from "../core/knowledge";
import type { Template } from "../domain/types";

export type ContentParts = Map<string, { title: string; parts: Map<string, string> }>;

export interface HistoryChange {
  unitKey: string;
  unitTitle: string;
  part: string;
  change: "created" | "updated" | "removed";
  before: string | null;
  after: string | null;
}

const lines = (xs: string[] | undefined) => (xs ?? []).filter(Boolean).join("\n");
const json = (x: unknown) => (x === undefined || x === null || (Array.isArray(x) && !x.length) || (typeof x === "object" && !Array.isArray(x) && !Object.keys(x as object).length) ? "" : JSON.stringify(x));

/** Các phần của một phiên bản: câu trả lời (gom các bước của một mục) hoặc đoạn tài liệu. */
export function contentParts(doc: { slug: string; templates: Template[]; chunks: KnowledgeChunk[] }): ContentParts {
  const out: ContentParts = new Map();
  const byUnit = new Map<string, Template[]>();
  for (const t of doc.templates) {
    const id = t.item?.id ?? t.id;
    byUnit.set(id, [...(byUnit.get(id) ?? []), t]);
  }
  for (const [id, ts] of byUnit) {
    const steps = [...ts].sort((a, b) => (a.item?.step ?? 0) - (b.item?.step ?? 0));
    const first = steps[0]!;
    const m = first.match;
    const parts = new Map<string, string>();
    const set = (k: string, v: string) => v && parts.set(k, v);
    set("Tên", first.item?.title ?? first.sets_context.issue ?? id);
    set("Cách khách hỏi", lines(m.examples));
    set("Cụm nhận biết", lines(m.keywords));
    set("Dùng khi", first.item?.applies_when ?? "");
    set("Khác với", json(first.item?.distinct_from));
    steps.forEach((t, i) => {
      set(steps.length > 1 ? `Trả lời bước ${i + 1}` : "Trả lời", t.answer_from ? `(dùng câu trả lời của ${t.answer_from})` : lines(Object.entries(t.answers).map(([lang, text]) => (lang === "en" ? text : `[${lang}] ${text}`))));
      set(steps.length > 1 ? `Sau bước ${i + 1}` : "Sau khi trả lời", json(t.follow_up));
    });
    set("Chuyển nhân viên", json({ ...(first.ticket ?? {}), ...(first.required_info?.length ? { ask_customer: first.required_info } : {}) }));
    set("Điều kiện", json(Object.fromEntries(Object.entries({ exact: m.exact, rules: m.rules, requires: m.requires, excludes: m.excludes, image_types: m.image_types }).filter(([, v]) => v.length))));
    set("Hiệu lực", json(first.valid));
    out.set(`item:${id}`, { title: first.item?.title ?? first.sets_context.issue ?? id, parts });
  }
  for (const c of doc.chunks) {
    const parts = new Map<string, string>();
    parts.set("Nội dung", c.text);
    if (c.url) parts.set("Link", c.url);
    out.set(`chunk:${doc.slug}#${c.heading}`, { title: c.heading, parts });
  }
  return out;
}

/** Thay đổi từ `prev` (bản đang chạy trước đó; undefined = chưa từng có) sang `next` (bản vừa áp dụng). */
export function diffParts(prev: ContentParts | undefined, next: ContentParts): HistoryChange[] {
  const out: HistoryChange[] = [];
  for (const [unitKey, n] of next) {
    const p = prev?.get(unitKey);
    for (const [part, after] of n.parts) {
      const before = p?.parts.get(part);
      if (before === undefined) out.push({ unitKey, unitTitle: n.title, part, change: "created", before: null, after });
      else if (before !== after) out.push({ unitKey, unitTitle: n.title, part, change: "updated", before, after });
    }
    if (p) for (const [part, before] of p.parts) if (!n.parts.has(part)) out.push({ unitKey, unitTitle: n.title, part, change: "removed", before, after: null });
  }
  if (prev) for (const [unitKey, p] of prev) if (!next.has(unitKey)) for (const [part, before] of p.parts) out.push({ unitKey, unitTitle: p.title, part, change: "removed", before, after: null });
  return out;
}
