/**
 * Xuất TOÀN BỘ tài liệu tri thức đang publish ra Excel để đọc trọn vẹn: mỗi tài liệu một trang, mỗi đoạn một dòng theo
 * đúng thứ tự trong tài liệu — chính là các đoạn bot tìm và đọc khi trả lời khách. CHỈ ĐỌC, không gọi AI, không sửa DB.
 *
 *   DATABASE_URL=... npx tsx scripts/export-knowledge-docs.ts [--out=file.xlsx]
 */
import ExcelJS from "exceljs";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db/db";

const outPath = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? ".staging/tai-lieu-tri-thuc-day-du.xlsx";

/** Bỏ ký hiệu định dạng Markdown để đọc như văn bản thường (giữ nguyên chữ, số, link). */
const plain = (s: string) =>
  s
    .replace(/\*\*|__|`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .trim();

async function main() {
  const cfg = loadConfig();
  const db = await openDb(cfg.DATABASE_URL);
  const docs = (
    await db.query<{ slug: string; title: string; version: number; published_at: Date | null; source_url: string | null }>(
      `SELECT d.slug, d.title, v.version, v.published_at, NULL AS source_url
       FROM kb_documents d JOIN kb_document_versions v ON v.slug = d.slug AND v.status = 'published'
       WHERE d.kind = 'knowledge' ORDER BY d.title`,
    )
  ).rows;

  const wb = new ExcelJS.Workbook();
  const overview = wb.addWorksheet("Tổng quan");
  overview.columns = [
    { header: "Tài liệu", width: 40 },
    { header: "Số đoạn", width: 10 },
    { header: "Phiên bản đang dùng", width: 18 },
    { header: "Ngày đưa lên", width: 16 },
    { header: "Trang trong file này", width: 30 },
  ];

  for (const d of docs) {
    const chunks = (
      await db.query<{ chunk_index: number; heading: string; text: string; url: string | null }>(
        `SELECT c.chunk_index, c.heading, c.text, c.url FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id
         WHERE v.status = 'published' AND c.doc_slug = $1 ORDER BY c.chunk_index`,
        [d.slug],
      )
    ).rows;
    // Tên trang Excel tối đa 31 ký tự, không có / \ ? * [ ]
    const sheetName = d.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
    const ws = wb.addWorksheet(sheetName);
    ws.columns = [
      { header: "STT", width: 6 },
      { header: "Phần lớn", width: 30 },
      { header: "Mục", width: 36 },
      { header: "Nội dung (nguyên văn bot đọc)", width: 100 },
      { header: "Đường link gửi kèm", width: 40 },
      { header: "Ghi chú của bạn", width: 30 },
    ];
    // Một mục quá dài bị tách thành nhiều đoạn cùng tiêu đề: đánh số (phần 1/2...) để người đọc biết là liền nhau
    const count = new Map<string, number>();
    for (const c of chunks) count.set(c.heading, (count.get(c.heading) ?? 0) + 1);
    const seen = new Map<string, number>();
    chunks.forEach((c, i) => {
      const parts = c.heading.split(" › ");
      const leaf = parts.at(-1)!;
      const parent = parts.length > 1 ? parts.slice(0, -1).join(" → ") : "";
      const n = (seen.get(c.heading) ?? 0) + 1;
      seen.set(c.heading, n);
      const total = count.get(c.heading)!;
      // nội dung đoạn bắt đầu bằng chính tiêu đề mục (hệ thống ghép vào để tìm kiếm): bỏ đi cho khỏi lặp với cột "Mục"
      const body = plain(c.text.startsWith(leaf) ? c.text.slice(leaf.length) : c.text);
      ws.addRow([i + 1, plain(parent), plain(leaf) + (total > 1 ? ` (phần ${n}/${total})` : ""), body, c.url ?? "", ""]);
    });
    const h = ws.getRow(1);
    h.font = { bold: true, color: { argb: "FFFFFFFF" } };
    h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5597" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.eachRow((r, i) => {
      if (i > 1) r.alignment = { wrapText: true, vertical: "top" };
    });
    overview.addRow([d.title, chunks.length, `bản ${d.version}`, d.published_at ? new Date(d.published_at).toISOString().slice(0, 10) : "", sheetName]);
  }
  overview.getRow(1).font = { bold: true };
  overview.addRow([]);
  overview.addRow(["Mỗi trang là một tài liệu. Mỗi dòng là một đoạn, theo đúng thứ tự trong tài liệu — đây chính là các đoạn bot tìm và đọc khi trả lời khách."]);
  overview.addRow(["Mục dài được hệ thống tách thành nhiều đoạn: ghi \"(phần 1/2)\", \"(phần 2/2)\"… là các đoạn liền nhau của cùng một mục."]);
  overview.addRow(["File chỉ đọc dữ liệu đang chạy thật, không sửa gì trong hệ thống."]);

  await wb.xlsx.writeFile(outPath);
  console.log(`đã ghi ${outPath}: ${docs.map((d) => d.title).join(" · ")}`);
  await db.close();
}
main().catch((e) => {
  console.error("lỗi:", e);
  process.exit(1);
});
