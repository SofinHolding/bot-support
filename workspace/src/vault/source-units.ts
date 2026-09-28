/**
 * Tách file thô thành các ĐƠN VỊ NGUỒN có vị trí (sheet/dòng hoặc heading) trước khi đưa cho SKILL knowledge-ingest:
 * AI biết từng đơn vị đến từ đâu, người duyệt đối chiếu được khi có xung đột ("Sheet FAQ, dòng 12").
 * Excel: mỗi dòng một đơn vị, kèm tên cột của dòng tiêu đề. Tài liệu: theo heading; không có heading thì theo đoạn.
 */
import ExcelJS from "exceljs";
import { extractText } from "../kb/doc-extract";

export interface SourceUnit {
  id: string;
  ref: string;
  text: string;
}

/** Một đơn vị không dài quá mức này (đoạn dài hơn bị chia): giữ mỗi lời gọi AI trong giới hạn đầu ra. */
const MAX_UNIT_CHARS = 3000;
/** Đoạn văn liền nhau được gộp tới khoảng này để một ý không bị cắt vụn. */
const TARGET_PARAGRAPH_CHARS = 1500;

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("text" in o) return String(o.text ?? "");
    if ("richText" in o && Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("");
    if ("result" in o) return cellText(o.result);
    if ("hyperlink" in o) return String(o.hyperlink);
    return "";
  }
  return String(v);
};

async function xlsxUnits(buf: Buffer): Promise<SourceUnit[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const out: SourceUnit[] = [];
  wb.eachSheet((sheet) => {
    let header: string[] | null = null;
    sheet.eachRow((row, rowNumber) => {
      const cells = (row.values as unknown[]).slice(1).map((v) => cellText(v).replace(/\s+/g, " ").trim());
      if (!cells.some(Boolean)) return;
      if (!header) {
        header = cells;
        // dòng đầu chỉ là tên cột ngắn -> dùng làm tiêu đề; dòng đầu đã là nội dung dài -> không có dòng tiêu đề
        if (cells.every((c) => c.length <= 60)) return;
        header = [];
      }
      const h = header;
      const parts = cells.map((c, i) => (c ? (h[i] ? `${h[i]}: ${c}` : c) : "")).filter(Boolean);
      out.push({ id: "", ref: `Sheet ${sheet.name}, dòng ${rowNumber}`, text: parts.join(" | ").slice(0, MAX_UNIT_CHARS) });
    });
  });
  return out;
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_UNIT_CHARS) return [text];
  const out: string[] = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?。])\s+|\n+/)) {
    if (cur && cur.length + s.length + 1 > MAX_UNIT_CHARS) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${s}` : s;
    while (cur.length > MAX_UNIT_CHARS) {
      out.push(cur.slice(0, MAX_UNIT_CHARS));
      cur = cur.slice(MAX_UNIT_CHARS);
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function textUnits(text: string): SourceUnit[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: SourceUnit[] = [];
  if (lines.some((l) => /^#{1,4}\s+\S/.test(l))) {
    let heading = "";
    let buf: string[] = [];
    const flush = () => {
      const body = buf.join("\n").trim();
      if (body) for (const [i, part] of splitLong(body).entries()) out.push({ id: "", ref: `${heading || "Phần mở đầu"}${i ? ` (tiếp ${i + 1})` : ""}`, text: heading ? `${heading}\n${part}` : part });
      buf = [];
    };
    for (const l of lines) {
      const m = /^#{1,4}\s+(.+)$/.exec(l);
      if (m) {
        flush();
        heading = m[1]!.trim();
      } else buf.push(l);
    }
    flush();
    return out;
  }
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let cur: string[] = [];
  let start = 1;
  paragraphs.forEach((p, i) => {
    if (cur.length && cur.join("\n\n").length + p.length > TARGET_PARAGRAPH_CHARS) {
      for (const part of splitLong(cur.join("\n\n"))) out.push({ id: "", ref: `Đoạn ${start}${i > start ? `-${i}` : ""}`, text: part });
      cur = [];
      start = i + 1;
    }
    cur.push(p);
  });
  if (cur.length) for (const part of splitLong(cur.join("\n\n"))) out.push({ id: "", ref: `Đoạn ${start}${paragraphs.length > start ? `-${paragraphs.length}` : ""}`, text: part });
  return out;
}

export async function sourceUnits(buf: Buffer, filename: string, mime = ""): Promise<SourceUnit[]> {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const units = ext === "xlsx" || mime.includes("spreadsheetml") ? await xlsxUnits(buf) : textUnits(await extractText(buf, filename, mime));
  if (!units.length) throw new Error("không tìm thấy nội dung nào để nạp trong tệp này: kiểm tra tệp có chữ, không chỉ có ảnh");
  return units.map((u, i) => ({ ...u, id: `U${i + 1}` }));
}

/** Chia đơn vị thành lô cho từng lời gọi AI (giới hạn độ dài và số đơn vị). */
export function batchUnits(units: SourceUnit[], maxChars = 12_000, maxUnits = 40): SourceUnit[][] {
  const out: SourceUnit[][] = [];
  let cur: SourceUnit[] = [];
  let size = 0;
  for (const u of units) {
    if (cur.length && (size + u.text.length > maxChars || cur.length >= maxUnits)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(u);
    size += u.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}
