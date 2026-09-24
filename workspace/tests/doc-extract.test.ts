/**
 * Trích văn bản từ tệp kéo-thả (trợ lý "Nạp nội dung mới"). Không dựng lại toàn bộ .pdf/.docx/.doc thật ở đây (thư viện
 * bên thứ ba đã có test riêng); chỉ kiểm đúng đường dây của module này: chọn nhánh theo đuôi tệp, cắt bớt khi quá dài,
 * báo lỗi rõ ràng khi định dạng không hỗ trợ hoặc tệp rỗng. .xlsx dựng thật bằng chính exceljs (ghi rồi đọc lại).
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { extractText, MAX_EXTRACTED_CHARS } from "../src/kb/doc-extract";

describe("extractText", () => {
  it(".txt: đọc thẳng UTF-8, cắt khoảng trắng đầu/cuối", async () => {
    const text = await extractText(Buffer.from("  Nội dung tệp .txt tiếng Việt có dấu.  \n", "utf8"), "note.txt", "text/plain");
    expect(text).toBe("Nội dung tệp .txt tiếng Việt có dấu.");
  });

  it(".txt quá dài -> cắt đúng MAX_EXTRACTED_CHARS", async () => {
    const long = "a".repeat(MAX_EXTRACTED_CHARS + 5000);
    const text = await extractText(Buffer.from(long, "utf8"), "long.txt", "text/plain");
    expect(text.length).toBe(MAX_EXTRACTED_CHARS);
  });

  it(".md: đọc thẳng như .txt (chỉ là văn bản có cú pháp Markdown, không phải cấu trúc YAML mà hệ thống lưu)", async () => {
    const text = await extractText(Buffer.from("# Tiêu đề\n\nMột đoạn nội dung Markdown.\n", "utf8"), "ghi-chu.md", "text/markdown");
    expect(text).toBe("# Tiêu đề\n\nMột đoạn nội dung Markdown.");
  });

  it("tệp rỗng (chỉ khoảng trắng) -> báo lỗi rõ ràng", async () => {
    await expect(extractText(Buffer.from("   \n\n  ", "utf8"), "empty.txt", "text/plain")).rejects.toThrow(/không trích được nội dung/);
  });

  it("đuôi tệp không hỗ trợ -> báo lỗi liệt kê đúng các định dạng nhận", async () => {
    await expect(extractText(Buffer.from("x"), "ảnh.png", "image/png")).rejects.toThrow(/không hỗ trợ định dạng.*\.txt, \.md, \.pdf, \.doc, \.docx, \.xlsx/);
  });

  it(".xls (Excel cũ, dạng nhị phân) -> báo lỗi gợi ý lưu lại thành .xlsx", async () => {
    await expect(extractText(Buffer.from("x"), "old.xls", "application/vnd.ms-excel")).rejects.toThrow(/\.xls.*\.xlsx/);
  });

  it(".xlsx thật (dựng bằng exceljs) -> trích đúng tên sheet và nội dung ô, nhiều sheet", async () => {
    const wb = new ExcelJS.Workbook();
    const s1 = wb.addWorksheet("Cau hoi 1");
    s1.addRow(["Câu hỏi", "Trả lời"]);
    s1.addRow(["Sao rút tiền chậm?", "Do đang xử lý, thường xong trong 24 giờ."]);
    const s2 = wb.addWorksheet("Cau hoi 2");
    s2.addRow(["Làm sao đổi email?"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const text = await extractText(buf, "faq.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(text).toContain("Cau hoi 1");
    expect(text).toContain("Cau hoi 2");
    expect(text).toContain("Sao rút tiền chậm?");
    expect(text).toContain("Do đang xử lý, thường xong trong 24 giờ.");
    expect(text).toContain("Làm sao đổi email?");
  });

  it(".pdf thật (dựng đúng bảng xref, không qua thư viện ngoài) -> trích đúng chữ; không crash lúc import module (pdf-parse v2 cần polyfill DOMMatrix — xem đầu file doc-extract.ts)", async () => {
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 100] /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    const stream = "BT /F1 18 Tf 10 50 Td (Hello test PDF file) Tj ET";
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, "utf8"));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefOffset = Buffer.byteLength(out, "utf8");
    const n = objs.length + 1;
    out += `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    const text = await extractText(Buffer.from(out, "utf8"), "note.pdf", "application/pdf");
    expect(text).toContain("Hello test PDF file");
  });

  it(".pdf hỏng -> báo lỗi rõ ràng thay vì crash", async () => {
    await expect(extractText(Buffer.from("%PDF-1.1\nkhông phải PDF hợp lệ"), "note.pdf", "application/pdf")).rejects.toThrow(/không đọc được nội dung tệp/);
  });

  it(".xlsx rỗng (không sheet nào có dữ liệu) -> báo lỗi rõ ràng thay vì trả chuỗi rỗng", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Trống");
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(extractText(buf, "empty.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).rejects.toThrow(/không trích được nội dung/);
  });
});
