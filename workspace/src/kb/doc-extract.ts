/**
 * Trích văn bản từ tệp admin kéo-thả vào trợ lý "Nạp nội dung mới" (.txt, .md, .pdf, .doc, .docx, .xlsx) để đưa vào ô nội dung
 * tự do — không lưu tệp lại (chỉ xử lý trong bộ nhớ rồi bỏ), không gọi dịch vụ ngoài nào. Chỉ admin mới gọi được route
 * dùng hàm này (xem admin/server.ts), nhưng nội dung tệp vẫn coi là KHÔNG ĐÁNG TIN — thư viện phân tích có thể có lỗi
 * với tệp cố tình làm hỏng; luôn bọc try/catch và có giới hạn dung lượng ở route.
 */
import { createRequire } from "node:module";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import type { PDFParse as PDFParseType } from "pdf-parse";

export const MAX_UPLOAD_BYTES = 15_000_000;
/** Khớp giới hạn `rawText` của IntakeDraftRequest (src/core/ports.ts) — cắt bớt thay vì để lời gọi AI thất bại vì quá dài. */
export const MAX_EXTRACTED_CHARS = 200_000;

const extOf = (filename: string) => (filename.split(".").pop() || "").toLowerCase();

/**
 * pdf-parse v2 bọc pdfjs-dist bản đầy đủ, mà pdfjs-dist tham chiếu `DOMMatrix` (API trình duyệt) ngay ở CẤP MODULE — không
 * có thì cả tiến trình admin crash lúc IMPORT (`DOMMatrix is not defined`), dù chỉ cần trích CHỮ chứ không vẽ/chụp ảnh gì.
 * pdf-parse tự khai báo phụ thuộc gói polyfill riêng nền tảng (@napi-rs/canvas) nhưng Dockerfile cố ý `npm ci --omit=optional`
 * nên phần nhị phân theo nền tảng của nó không cài được, và polyfill dự phòng có sẵn của @napi-rs/canvas không hoạt động
 * đúng trong môi trường này (đã xác minh thật). Tự cấp DOMMatrix bằng `dommatrix` (gói JS thuần, không nhị phân theo nền
 * tảng, luôn cài được) TRƯỚC khi pdf-parse được nạp.
 * QUAN TRỌNG: `import ... from "pdf-parse"` TĨNH ở đầu file vẫn crash dù polyfill đặt trước trong cùng file — theo đặc tả
 * ES module, mọi import tĩnh trong đồ thị phụ thuộc được nạp/chạy TRƯỚC bất kỳ câu lệnh nào của chính module đang import,
 * bất kể thứ tự viết trong file. Phải nạp ĐỘNG (`import()`) bên trong hàm, sau khi polyfill đã chắc chắn chạy xong.
 * (Đã thử pdf-parse v1, không cần canvas nhưng phân tích sai ngẫu nhiên trong tiến trình dài dưới ESM — bỏ, chuyển sang v2.)
 */
let pdfParseCtor: Promise<typeof PDFParseType> | undefined;
function loadPdfParse(): Promise<typeof PDFParseType> {
  if (!pdfParseCtor) {
    const require = createRequire(import.meta.url);
    (globalThis as { DOMMatrix?: unknown }).DOMMatrix ??= require("dommatrix");
    pdfParseCtor = import("pdf-parse").then((m) => m.PDFParse);
  }
  return pdfParseCtor;
}

async function extractPdf(buf: Buffer): Promise<string> {
  const PDFParse = await loadPdfParse();
  const parser = new PDFParse({ data: buf });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

async function extractXlsx(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const lines: string[] = [];
  wb.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow((row) => {
      const cells = (row.values as unknown[])
        .slice(1) // exceljs: values[0] luôn rỗng (mảng 1-based)
        .map((v) => (v == null ? "" : typeof v === "object" && v && "text" in (v as Record<string, unknown>) ? String((v as { text: unknown }).text) : String(v)))
        .filter((s) => s.trim());
      if (cells.length) rows.push(cells.join(" | "));
    });
    if (rows.length) lines.push(`## ${sheet.name}`, ...rows); // bỏ qua sheet trống hẳn: không để lại tiêu đề rỗng không ai đọc được
  });
  return lines.join("\n");
}

/** `filename`/`mime` chỉ để CHỌN cách trích, không quyết định độ an toàn — cả hai đến từ trình duyệt, không đáng tin. */
export async function extractText(buf: Buffer, filename: string, mime: string): Promise<string> {
  const ext = extOf(filename);
  let text: string;
  try {
    // .md: đọc thẳng như .txt — chỉ là văn bản có cú pháp Markdown, không phải cấu trúc YAML/template mà hệ thống dùng
    // để lưu (parseTemplateFile/parseKnowledgeDoc); AI ở bước sau vẫn đọc hiểu và cấu trúc lại như mọi văn bản tự do khác.
    if (ext === "txt" || ext === "md" || ext === "markdown" || mime === "text/plain" || mime === "text/markdown") text = buf.toString("utf8");
    else if (ext === "pdf" || mime === "application/pdf") text = await extractPdf(buf);
    else if (ext === "docx" || mime.includes("wordprocessingml")) text = (await mammoth.extractRawText({ buffer: buf })).value;
    else if (ext === "doc" || mime === "application/msword") text = (await new WordExtractor().extract(buf)).getBody();
    else if (ext === "xlsx" || mime.includes("spreadsheetml")) text = await extractXlsx(buf);
    else if (ext === "xls" || mime === "application/vnd.ms-excel") throw new Error('định dạng .xls (Excel cũ) chưa hỗ trợ — lưu lại thành .xlsx rồi thử lại');
    else throw new Error(`không hỗ trợ định dạng tệp ".${ext || "?"}" — chỉ nhận .txt, .md, .pdf, .doc, .docx, .xlsx`);
  } catch (e) {
    if (e instanceof Error && !e.message.includes("hỗ trợ")) throw new Error(`không đọc được nội dung tệp: ${e.message.slice(0, 200)}`);
    throw e;
  }
  text = text.trim();
  if (!text) throw new Error("không trích được nội dung văn bản nào từ tệp này");
  return text.length > MAX_EXTRACTED_CHARS ? text.slice(0, MAX_EXTRACTED_CHARS) : text;
}
