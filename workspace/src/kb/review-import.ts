/**
 * Áp quyết định của khách hàng trong file rà soát (scripts/export-content-review.ts -> Ra-soat-toan-bo-noi-dung_v*.xlsx) lên
 * bộ mục hỏi đáp đã chuyển (src/kb/migrate-items.ts). Hàm thuần: nhận các dòng đã đọc từ Excel, trả về tài liệu đã sửa + danh
 * sách việc người quản lý bot còn phải làm. KHÔNG tự nghĩ nội dung:
 *  - "giữ cả hai (ghi ngữ cảnh)": ngữ cảnh của khách -> "dùng khi" của từng mục + lời khai "khác với"; câu hỏi lại khách
 *    (tiếng Anh) để TRỐNG — người quản lý phải viết, kiểm tra bản nháp sẽ chặn publish tới khi có.
 *  - "chỉ giữ một mục": mục bị bỏ gộp cách hỏi vào mục giữ lại (nhiều cách hỏi -> một câu trả lời), rồi bỏ.
 *  - "sửa": nội dung mới thay câu trả lời (bản dịch cũ hết hiệu lực vì câu gốc đổi).
 *  - Đoạn tài liệu tham khảo không nằm trong mục hỏi đáp: sửa/bỏ đoạn được liệt kê riêng để áp vào tài liệu gốc.
 *  - Quyết định về cặp mục hỏi đáp ↔ đoạn tài liệu được xuất ra để lưu vào bảng quyết định (kb_pair_decisions) lúc publish,
 *    khi đã có hash của nội dung cuối cùng.
 */
import type { FollowUpKind } from "../core/followup";
import type { ItemsDoc, KnowledgeItem } from "../core/items";
import { normalize } from "../core/text";

export type RowDecision = "keep" | "edit" | "drop";
export type PairDecisionText = "distinct" | "keep_both" | "keep_first" | "keep_second" | "fix";

/** Sheet "1. Câu trả lời soạn sẵn" */
export interface ItemRow {
  id: string;
  decision?: RowDecision;
  newAnswer?: string;
  addQuestions?: string[];
  note?: string;
}

/** Sheet "3. Cặp cần xem" và "6. Cặp chưa kết luận". Khoá: "template:<id>" | "chunk:<tài liệu>#<tiêu đề>" */
export interface PairRow {
  code: string;
  a: string;
  b: string;
  decision?: PairDecisionText;
  contextA?: string;
  contextB?: string;
  fixText?: string;
  fixWhere?: "a" | "b" | "both";
}

/** Sheet "2. Tài liệu tri thức" */
export interface ChunkRow {
  key: string;
  decision?: RowDecision;
  newText?: string;
}

/** Sheet "4. Nhóm dùng chung câu trả lời" */
export interface SharedRow {
  id: string;
  ownAnswer?: string;
}

export interface ReviewInput {
  items?: ItemRow[];
  chunks?: ChunkRow[];
  pairs?: PairRow[];
  shared?: SharedRow[];
  /** Sheet "5. Cặp không xung đột": mã cặp -> ý kiến khách ghi khi không đồng ý */
  objections?: { code: string; text: string }[];
}

export interface ChunkChange {
  doc: string;
  heading: string;
  action: "edit" | "drop";
  text?: string;
  from: string;
}

export interface PairDecisionOut {
  a: string;
  b: string;
  decision: "distinct" | "keep_both" | "merged" | "fixed";
  note: string;
  from: string;
}

export interface ReviewResult {
  docs: ItemsDoc[];
  applied: string[];
  /** việc người quản lý bot còn phải làm (viết câu hỏi lại, xử lý quyết định mâu thuẫn...) */
  todo: string[];
  chunkChanges: ChunkChange[];
  pairDecisions: PairDecisionOut[];
}

const DECISIONS: Record<string, PairDecisionText> = {
  "Không trùng - giữ nguyên cả hai": "distinct",
  "Trùng - giữ cả hai (ghi ngữ cảnh)": "keep_both",
  "Trùng - chỉ giữ mục thứ nhất": "keep_first",
  "Trùng - chỉ giữ mục thứ hai": "keep_second",
  "Mâu thuẫn - sửa (ghi nội dung đúng)": "fix",
};
const ROW_DECISIONS: Record<string, RowDecision> = {
  "Giữ nguyên": "keep",
  "Sửa (ghi câu trả lời mới)": "edit",
  "Ngừng dùng mục này": "drop",
  "Sửa (ghi nội dung mới)": "edit",
  "Bỏ đoạn này": "drop",
};
const WHERE: Record<string, "a" | "b" | "both"> = { "Mục thứ nhất": "a", "Mục thứ hai": "b", "Cả hai": "both" };

/** Chữ trong ô "Quyết định" -> mã; ô trống / chữ lạ -> undefined (chữ lạ được báo ở script). */
export const parsePairDecision = (s: unknown) => DECISIONS[String(s ?? "").trim()];
export const parseRowDecision = (s: unknown) => ROW_DECISIONS[String(s ?? "").trim()];
export const parseWhere = (s: unknown) => WHERE[String(s ?? "").trim()];

const ref = (key: string): { kind: "item"; id: string } | { kind: "chunk"; doc: string; heading: string } | undefined => {
  if (key.startsWith("template:")) return { kind: "item", id: key.slice(9) };
  const m = /^chunk:([^#]+)#(.+)$/.exec(key);
  return m ? { kind: "chunk", doc: m[1]!, heading: m[2]! } : undefined;
};
const pairKey = (key: string) => (key.startsWith("template:") ? `item:${key.slice(9)}` : key);

export function applyReview(docsIn: ItemsDoc[], input: ReviewInput): ReviewResult {
  const docs: ItemsDoc[] = structuredClone(docsIn);
  const applied: string[] = [];
  const todo: string[] = [];
  const chunkChanges: ChunkChange[] = [];
  const pairDecisions: PairDecisionOut[] = [];
  const find = (id: string): KnowledgeItem | undefined => docs.flatMap((d) => d.items).find((i) => i.id === id);
  const name = (id: string) => `"${find(id)?.title ?? id}"`;
  const removed = new Map<string, string>(); // id -> vì sao bỏ
  const edited = new Map<string, string>(); // id -> dòng đã sửa

  const setAnswer = (id: string, text: string, from: string) => {
    const it = find(id);
    if (!it) return todo.push(`${from}: không tìm thấy mục ${id}`);
    if (removed.has(id)) return todo.push(`${from}: sửa câu trả lời của mục ${name(id)} nhưng mục này đã bị bỏ (${removed.get(id)}) — cần xem lại`);
    if (edited.has(id) && edited.get(id) !== from) todo.push(`${from}: mục ${name(id)} đã được sửa ở ${edited.get(id)}; dùng nội dung của ${from} — kiểm tra hai nội dung có khớp không`);
    if (it.kind === "handoff") return todo.push(`${from}: mục ${name(id)} là mục chuyển nhân viên (dùng câu chuyển nhân viên chuẩn) — cần quyết định: đổi thành câu trả lời riêng thì không còn tạo ticket`);
    if (!it.steps.length) it.steps.push({ say: {} });
    it.steps[0]!.say = { en: text.trim() }; // câu gốc đổi: bản dịch cũ không còn đúng
    edited.set(id, from);
    applied.push(`${from}: sửa câu trả lời của mục ${name(id)}`);
    if (/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text)) todo.push(`${from}: câu trả lời mới của mục ${name(id)} có vẻ viết tiếng Việt — câu gốc phải là tiếng Anh, cần người quản lý viết lại`);
  };
  const drop = (id: string, why: string, mergeInto?: string) => {
    const it = find(id);
    if (!it) return todo.push(`${why}: không tìm thấy mục ${id}`);
    if (it.kind === "system") return todo.push(`${why}: mục ${name(id)} là tin hệ thống (code gửi) — không bỏ được qua file rà soát`);
    const into = mergeInto ? find(mergeInto) : undefined;
    if (into) {
      const seen = new Set(into.questions.map(normalize));
      for (const q of it.questions) if (!seen.has(normalize(q))) (into.questions.push(q), seen.add(normalize(q)));
      const seenP = new Set(into.phrases.map(normalize));
      for (const p of it.phrases) if (!seenP.has(normalize(p))) (into.phrases.push(p), seenP.add(normalize(p)));
    }
    for (const d of docs) d.items = d.items.filter((x) => x.id !== id);
    for (const other of docs.flatMap((d) => d.items)) {
      other.distinct_from = other.distinct_from.filter((x) => x.item !== id);
      for (const s of other.steps) for (const [k, target] of Object.entries(s.next ?? {}) as [FollowUpKind, string][]) if (target === id || target.startsWith(`${id}#`)) {
        s.next![k] = into ? into.id : "handoff";
        todo.push(`${why}: mục ${name(other.id)} đang dẫn tới mục bị bỏ ${id} — đã chuyển sang ${into ? name(into.id) : "chuyển nhân viên"}, cần kiểm tra`);
      }
    }
    removed.set(id, why);
    applied.push(`${why}: bỏ mục ${it.title}${into ? `, cách hỏi gộp vào ${name(into.id)}` : ""}`);
  };

  // ---- 1. Từng câu trả lời soạn sẵn ----
  for (const r of input.items ?? []) {
    const from = `dòng mục ${r.id}`;
    if (r.addQuestions?.length) {
      const it = find(r.id);
      if (it) {
        const seen = new Set(it.questions.map(normalize));
        const add = r.addQuestions.map((q) => q.trim()).filter((q) => q && !seen.has(normalize(q)));
        it.questions.push(...add);
        if (add.length) applied.push(`${from}: thêm ${add.length} cách hỏi cho mục ${name(r.id)}`);
      } else todo.push(`${from}: không tìm thấy mục`);
    }
    if (r.decision === "edit") {
      if (r.newAnswer?.trim()) setAnswer(r.id, r.newAnswer, from);
      else todo.push(`${from}: chọn "Sửa" nhưng chưa ghi câu trả lời mới`);
    } else if (r.decision === "drop") drop(r.id, from);
    if (r.note?.trim()) todo.push(`${from}: khách ghi chú — ${r.note.trim()}`);
  }

  // ---- 2. Cặp cần xem / chưa kết luận ----
  for (const p of input.pairs ?? []) {
    if (!p.decision) continue;
    const A = ref(p.a);
    const B = ref(p.b);
    const from = `cặp ${p.code}`;
    if (!A || !B) {
      todo.push(`${from}: không đọc được mã hệ thống (${p.a} / ${p.b})`);
      continue;
    }
    const both = A.kind === "item" && B.kind === "item";
    const decide = (d: PairDecisionOut["decision"], note: string) => pairDecisions.push({ a: pairKey(p.a), b: pairKey(p.b), decision: d, note, from });
    switch (p.decision) {
      case "distinct":
        if (!both) decide("distinct", "khách xác nhận không trùng");
        applied.push(`${from}: khách xác nhận hai mục khác nhau`);
        break;
      case "keep_both": {
        if (!p.contextA?.trim() || !p.contextB?.trim()) todo.push(`${from}: chọn "giữ cả hai" nhưng chưa ghi đủ ngữ cảnh cho hai mục`);
        for (const [s, ctx] of [[A, p.contextA], [B, p.contextB]] as const) if (s.kind === "item" && ctx?.trim() && find(s.id)) find(s.id)!.applies_when = ctx.trim();
        if (both) {
          const a = find(A.id);
          if (a && find(B.id) && !a.distinct_from.some((d) => d.item === B.id)) {
            a.distinct_from.push({ item: B.id, difference: `${a.title}: ${p.contextA?.trim() ?? "?"} / ${find(B.id)!.title}: ${p.contextB?.trim() ?? "?"}`, clarify: "" });
            todo.push(`${from}: viết câu hỏi lại khách (tiếng Anh) để phân biệt ${name(A.id)} và ${name(B.id)} — bản nháp sẽ không publish được tới khi có câu này`);
          }
        } else decide("keep_both", [p.contextA, p.contextB].filter(Boolean).join(" / "));
        applied.push(`${from}: giữ cả hai, ghi ngữ cảnh`);
        break;
      }
      case "keep_first":
      case "keep_second": {
        const [keep, gone] = p.decision === "keep_first" ? [A, B] : [B, A];
        if (gone.kind === "item") drop(gone.id, from, keep.kind === "item" ? keep.id : undefined);
        else chunkChanges.push({ doc: gone.doc, heading: gone.heading, action: "drop", from });
        if (keep.kind === "chunk" && gone.kind === "item") todo.push(`${from}: bỏ mục hỏi đáp để dùng đoạn tài liệu "${keep.heading}" — cách hỏi của mục bị bỏ không còn trỏ tới đâu; cân nhắc thêm vào tài liệu`);
        break;
      }
      case "fix": {
        if (!p.fixText?.trim()) {
          todo.push(`${from}: chọn "sửa" nhưng chưa ghi nội dung đúng`);
          break;
        }
        const where = p.fixWhere ?? "both";
        if (!p.fixWhere) todo.push(`${from}: chưa chọn "Sửa ở mục nào" — tạm áp cho cả hai, cần kiểm tra`);
        for (const [s, side] of [[A, "a"], [B, "b"]] as const) {
          if (where !== "both" && where !== side) continue;
          if (s.kind === "item") setAnswer(s.id, p.fixText, from);
          else chunkChanges.push({ doc: s.doc, heading: s.heading, action: "edit", text: p.fixText.trim(), from });
        }
        if (!both) decide("fixed", "khách sửa nội dung mâu thuẫn");
        break;
      }
    }
  }

  // ---- 3. Đoạn tài liệu, nhóm dùng chung câu trả lời, ý kiến phản đối ----
  for (const c of input.chunks ?? []) {
    const r = ref(`chunk:${c.key}`);
    if (!r || r.kind !== "chunk") continue;
    if (c.decision === "edit" && c.newText?.trim()) chunkChanges.push({ doc: r.doc, heading: r.heading, action: "edit", text: c.newText.trim(), from: `dòng tài liệu ${c.key}` });
    else if (c.decision === "edit") todo.push(`dòng tài liệu ${c.key}: chọn "Sửa" nhưng chưa ghi nội dung mới`);
    else if (c.decision === "drop") chunkChanges.push({ doc: r.doc, heading: r.heading, action: "drop", from: `dòng tài liệu ${c.key}` });
  }
  for (const s of input.shared ?? []) if (s.ownAnswer?.trim()) setAnswer(s.id, s.ownAnswer, `nhóm dùng chung, mục ${s.id}`);
  for (const o of input.objections ?? []) if (o.text.trim()) todo.push(`cặp ${o.code} (hệ thống kết luận không xung đột): khách không đồng ý — ${o.text.trim()}`);

  const seenChunk = new Map<string, ChunkChange>();
  for (const c of chunkChanges) {
    const k = `${c.doc}#${c.heading}`;
    const prev = seenChunk.get(k);
    if (prev && (prev.action !== c.action || prev.text !== c.text)) todo.push(`đoạn "${c.heading}" (${c.doc}) có hai quyết định khác nhau: ${prev.from} và ${c.from} — cần chọn một`);
    seenChunk.set(k, c);
  }
  return { docs, applied, todo, chunkChanges, pairDecisions };
}
