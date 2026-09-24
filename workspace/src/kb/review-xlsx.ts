/**
 * Đọc file rà soát nội dung (scripts/export-content-review.ts -> Ra-soat-toan-bo-noi-dung_v*.xlsx) mà khách hàng đã điền quyết
 * định, thành đầu vào cho applyReview (review-import.ts). Tìm cột theo TIÊU ĐỀ (không theo vị trí) để khách có thể ẩn/đổi
 * thứ tự cột. Lựa chọn lạ trong ô "Quyết định" được trả về trong `unknown`, không đoán.
 */
import ExcelJS from "exceljs";
import { parsePairDecision, parseRowDecision, parseWhere, type ChunkRow, type ItemRow, type PairRow, type ReviewInput, type SharedRow } from "./review-import";

const text = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (typeof v === "object" && "richText" in v) return v.richText.map((r) => r.text).join("");
  if (typeof v === "object" && "text" in v) return String(v.text);
  if (typeof v === "object" && "result" in v) return String(v.result ?? "");
  return String(v);
};

/** Một sheet thành các dòng {tiêu đề cột: giá trị}. */
function rows(ws: ExcelJS.Worksheet | undefined, headerRow = 1): Record<string, string>[] {
  if (!ws) return [];
  const headers = (ws.getRow(headerRow).values as ExcelJS.CellValue[]).map(text);
  const out: Record<string, string>[] = [];
  ws.eachRow((row, n) => {
    if (n <= headerRow) return;
    const o: Record<string, string> = {};
    (row.values as ExcelJS.CellValue[]).forEach((v, i) => headers[i] && (o[headers[i]!] = text(v).trim()));
    out.push(o);
  });
  return out;
}

const col = (r: Record<string, string>, prefix: string) => r[Object.keys(r).find((k) => k.startsWith(prefix)) ?? ""] ?? "";

export async function readReviewWorkbook(source: string | Buffer): Promise<{ input: ReviewInput; unknown: string[] }> {
  const wb = new ExcelJS.Workbook();
  if (typeof source === "string") await wb.xlsx.readFile(source);
  else await wb.xlsx.load(source as unknown as ArrayBuffer);
  const sheet = (prefix: string) => wb.worksheets.find((w) => w.name.startsWith(prefix));
  const unknown: string[] = [];
  const check = <T>(v: T | undefined, raw: string, where: string) => {
    if (raw && v === undefined) unknown.push(`${where}: không hiểu lựa chọn "${raw}"`);
    return v;
  };
  const items: ItemRow[] = rows(sheet("1.")).filter((r) => col(r, "Mã hệ thống")).map((r) => ({
    id: col(r, "Mã hệ thống"),
    decision: check(parseRowDecision(col(r, "Quyết định")), col(r, "Quyết định"), `mục ${col(r, "Tên") || col(r, "Mã hệ thống")}`),
    newAnswer: col(r, "Câu trả lời mới"),
    addQuestions: col(r, "Thêm câu khách hay hỏi").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    note: col(r, "Ghi chú"),
  }));
  const chunks: ChunkRow[] = rows(sheet("2.")).filter((r) => col(r, "Mã hệ thống")).map((r) => ({
    key: col(r, "Mã hệ thống"),
    decision: check(parseRowDecision(col(r, "Quyết định")), col(r, "Quyết định"), `đoạn ${col(r, "Mục") || col(r, "Mã hệ thống")}`),
    newText: col(r, "Nội dung mới"),
  }));
  const pairRows = (prefix: string): PairRow[] =>
    rows(sheet(prefix)).filter((r) => col(r, "Mã cặp")).map((r) => ({
      code: col(r, "Mã cặp"),
      a: col(r, "Mã hệ thống mục thứ nhất"),
      b: col(r, "Mã hệ thống mục thứ hai"),
      decision: check(parsePairDecision(col(r, "Quyết định")), col(r, "Quyết định"), `cặp ${col(r, "Mã cặp")}`),
      contextA: col(r, "Nếu giữ cả hai: mục thứ nhất"),
      contextB: col(r, "Nếu giữ cả hai: mục thứ hai"),
      fixText: col(r, "Nội dung đúng"),
      fixWhere: check(parseWhere(col(r, "Sửa ở mục nào")), col(r, "Sửa ở mục nào"), `cặp ${col(r, "Mã cặp")}`),
    }));
  const shared: SharedRow[] = rows(sheet("4."), 2).filter((r) => col(r, "Mã hệ thống")).map((r) => ({ id: col(r, "Mã hệ thống"), ownAnswer: col(r, "Câu trả lời riêng") }));
  const objections = rows(sheet("5.")).filter((r) => col(r, "Ý kiến")).map((r) => ({ code: col(r, "Mã cặp"), text: col(r, "Ý kiến") }));
  return { input: { items, chunks, pairs: [...pairRows("3."), ...pairRows("6.")], shared, objections }, unknown };
}
