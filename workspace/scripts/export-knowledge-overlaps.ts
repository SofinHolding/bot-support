/**
 * Xuất ra Excel các cặp nội dung "giống nhau" có dính tới TÀI LIỆU TRI THỨC (tài liệu ↔ tài liệu, câu trả lời có sẵn ↔ tài liệu),
 * mỗi cặp ghi NGUYÊN VĂN cả hai bên, viết bằng lời thường (không mã, không id) cho người không rành kỹ thuật đọc và đánh giá.
 * CHỈ ĐỌC: dùng đúng máy quét lúc chạy thật (kb/overlap.ts) và model embedding đang chọn; không gọi AI, không sửa DB.
 *
 *   EMBEDDING_URL=http://localhost:8081/v1 DATABASE_URL=... npx tsx scripts/export-knowledge-overlaps.ts [--out=file.xlsx]
 */
import ExcelJS from "exceljs";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db/db";
import { kbRepo } from "../src/db/repo-kb";
import { opsRepo } from "../src/db/repo-ops";
import type { Template } from "../src/domain/types";
import { LiveContent } from "../src/kb/live-content";
import { scanCorpus, type OverlapPair, type OverlapRef } from "../src/kb/overlap";
import { EmbeddingConfig } from "../src/llm/embedding-config";
import { createEmbedder, SelectedEmbedder } from "../src/llm/embedder";
import { SecretBox } from "../src/llm/secret-box";
import { TEMPLATE_TITLES } from "./lib/template-titles";

const outPath = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? ".staging/xung-dot-tai-lieu-tri-thuc.xlsx";

/** Bỏ ký hiệu định dạng Markdown để đọc như văn bản thường (giữ nguyên chữ, số, link). */
const plain = (s: string) =>
  s
    .replace(/\*\*|__|`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\{SUPPORT_SUMMARY\}/g, "")
    .trim();

const level = (score: number) => (score >= 0.75 ? "Cao" : score >= 0.65 ? "Trung bình" : "Thấp");
const pct = (score: number) => `${Math.round(score * 100)}%`;
const uniq = (xs: string[]) => [...new Map(xs.filter((x) => x.trim()).map((x) => [x.trim().toLowerCase(), x.trim()])).values()];

async function main() {
  const cfg = loadConfig();
  const db = await openDb(cfg.DATABASE_URL);
  const kb = kbRepo(db);
  const ops = opsRepo(db);
  const embedding = new EmbeddingConfig(ops, cfg.SECRETS_KEY ? new SecretBox(cfg.SECRETS_KEY) : null);
  const embedder = new SelectedEmbedder(() => embedding.selection(), createEmbedder(cfg), { log: () => undefined });
  const live = new LiveContent(db, kb, ops, embedder, `${cfg.CONTENT_DIR}/config/predicates.yml`, Date.now, async () => (await embedder.active()).version);
  await live.rebuild();

  const rows = await kb.loadPublishedTemplateRows();
  const docTitle = new Map((await kb.listDocuments()).map((d) => [d.slug, d.title]));
  const chunks = new Map((await kb.listPublishedChunks()).map((c) => [c.chunkId, c]));
  const pairs = await scanCorpus({ index: live.index, kb, embedder, docOf: new Map(rows.map((r) => [r.template.id, r.docSlug])) }, { maxPairs: 2000 });

  const tTitle = (id: string) => TEMPLATE_TITLES[id] ?? live.index.get(id)?.sets_context.issue ?? "(chưa đặt tên)";
  const dTitle = (slug: string) => docTitle.get(slug) ?? slug;
  const leaf = (heading: string) => heading.split(" › ").join(" → ");
  const chunkText = (r: OverlapRef) => plain(chunks.get(r.id)?.text ?? "");
  const answerOf = (t: Template) => plain(live.index.resolveAnswerSource(t).answers.en ?? "");
  const asksOf = (t: Template) => uniq([...t.match.exact, ...t.match.keywords, ...t.match.examples]).map((x) => `"${x}"`).join(", ");

  /** Tín hiệu kỹ thuật của máy quét -> một câu lời thường (thay id bằng tên, bỏ điểm số lẻ). */
  const reason = (p: OverlapPair): string => {
    const out: string[] = [];
    for (const s of p.signals.slice(0, 3)) {
      let m: RegExpExecArray | null;
      if ((m = /^"(.+?)" ~ câu mẫu của (\S+) \(/.exec(s))) out.push(`Câu "${m[1]}" có ý gần giống câu khách hay hỏi của mục "${tTitle(m[2]!)}".`);
      else if ((m = /^"(.+?)" ~ đoạn "(.+?)" của (\S+) \(/.exec(s))) out.push(`Nội dung "${m[1]!.slice(0, 80)}${m[1]!.length > 80 ? "…" : ""}" có ý gần giống đoạn "${leaf(m[2]!)}" trong tài liệu "${dTitle(m[3]!)}".`);
      else if ((m = /^từ khoá "(.+?)" của (\S+) nằm trong/.exec(s))) out.push(`Cụm "${m[1]}" mà mục "${tTitle(m[2]!)}" dùng để nhận biết câu hỏi xuất hiện trong nội dung bên kia.`);
      else if ((m = /^từ khoá "(.+?)" nằm trong đoạn "(.+?)" của (\S+)/.exec(s))) out.push(`Cụm "${m[1]}" xuất hiện trong đoạn "${leaf(m[2]!)}" của tài liệu "${dTitle(m[3]!)}".`);
      else if ((m = /^từ khoá "(.+?)" nằm trong câu mẫu\/từ khoá của (\S+)/.exec(s))) out.push(`Cụm "${m[1]}" xuất hiện trong câu hỏi mẫu của mục "${tTitle(m[2]!)}".`);
    }
    if (p.updateHint) out.push("Hai đoạn gần như trùng nguyên văn — có thể một bên là bản cập nhật của bên kia.");
    return uniq(out).join("\n") || "Hai nội dung nói về cùng một chủ đề.";
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = "InterLink Support Bot";

  const kk = pairs.filter((p) => p.a.kind === "chunk" && p.b.kind === "chunk");
  const tk = pairs.filter((p) => p.a.kind !== p.b.kind);

  // ---- Trang 1: hướng dẫn đọc
  const guide = wb.addWorksheet("Cách đọc");
  guide.columns = [{ width: 120 }];
  [
    "BÁO CÁO NỘI DUNG GIỐNG NHAU CÓ LIÊN QUAN TỚI TÀI LIỆU TRI THỨC",
    "",
    `Trang "Tài liệu với tài liệu": ${kk.length} cặp đoạn thuộc HAI tài liệu khác nhau có nội dung gần giống nhau.`,
    `Trang "Câu trả lời với tài liệu": ${tk.length} cặp giữa một câu trả lời có sẵn (bot gửi nguyên văn) và một đoạn tài liệu (bot đọc rồi viết lại).`,
    "",
    "Mỗi dòng ghi NGUYÊN VĂN cả hai bên để bạn so trực tiếp, không cần mở chỗ khác.",
    'Cột "Mức giống": Cao / Trung bình / Thấp — càng cao càng nên xem trước. Giống nhau KHÔNG có nghĩa là sai: nhiều cặp chỉ cùng chủ đề.',
    "Điều cần tìm khi đọc: hai bên có nói KHÁC NHAU về cùng một việc không (số liệu, ngày giờ, đường link, các bước làm, điều kiện áp dụng).",
    'Cột "Đánh giá của bạn" và "Ghi chú" để trống cho bạn điền. Gợi ý cách điền: Không sao / Trùng — giữ một bên / Mâu thuẫn — cần sửa / Không chắc.',
    "",
    "Báo cáo chỉ đọc dữ liệu đang chạy thật, không sửa gì trong hệ thống.",
    `Ngày xuất: ${new Date().toISOString().slice(0, 10)}`,
  ].forEach((line, i) => {
    const r = guide.addRow([line]);
    r.alignment = { wrapText: true, vertical: "top" };
    if (i === 0) r.font = { bold: true, size: 14 };
  });

  const style = (ws: ExcelJS.Worksheet) => {
    const h = ws.getRow(1);
    h.font = { bold: true, color: { argb: "FFFFFFFF" } };
    h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5597" } };
    h.alignment = { wrapText: true, vertical: "middle" };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.eachRow((r, i) => {
      if (i > 1) r.alignment = { wrapText: true, vertical: "top" };
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
    const lv = ws.getColumn(2);
    lv.eachCell((c, i) => {
      if (i === 1) return;
      const color = c.value === "Cao" ? "FFF8CBAD" : c.value === "Trung bình" ? "FFFFE699" : "FFE2EFDA";
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    });
  };

  // ---- Trang 2: tài liệu ↔ tài liệu
  const ws1 = wb.addWorksheet("Tài liệu với tài liệu");
  ws1.columns = [
    { header: "STT", width: 6 },
    { header: "Mức giống", width: 12 },
    { header: "Độ giống", width: 10 },
    { header: "Tài liệu thứ nhất", width: 24 },
    { header: "Mục trong tài liệu thứ nhất", width: 28 },
    { header: "Nội dung đầy đủ (thứ nhất)", width: 70 },
    { header: "Tài liệu thứ hai", width: 24 },
    { header: "Mục trong tài liệu thứ hai", width: 28 },
    { header: "Nội dung đầy đủ (thứ hai)", width: 70 },
    { header: "Vì sao bị xếp thành cặp", width: 45 },
    { header: "Đánh giá của bạn", width: 20 },
    { header: "Ghi chú", width: 30 },
  ];
  kk.forEach((p, i) =>
    ws1.addRow([i + 1, level(p.score), pct(p.score), dTitle(p.a.doc), leaf(p.a.title), chunkText(p.a), dTitle(p.b.doc), leaf(p.b.title), chunkText(p.b), reason(p), "", ""]),
  );
  style(ws1);

  // ---- Trang 3: câu trả lời có sẵn ↔ tài liệu
  const ws2 = wb.addWorksheet("Câu trả lời với tài liệu");
  ws2.columns = [
    { header: "STT", width: 6 },
    { header: "Mức giống", width: 12 },
    { header: "Độ giống", width: 10 },
    { header: "Câu trả lời có sẵn (tên)", width: 28 },
    { header: "Khách thường hỏi", width: 40 },
    { header: "Bot trả lời (nguyên văn)", width: 60 },
    { header: "Tài liệu", width: 24 },
    { header: "Mục trong tài liệu", width: 30 },
    { header: "Nội dung đầy đủ của mục", width: 70 },
    { header: "Vì sao bị xếp thành cặp", width: 45 },
    { header: "Đánh giá của bạn", width: 20 },
    { header: "Ghi chú", width: 30 },
  ];
  tk.forEach((p, i) => {
    const tRef = p.a.kind === "template" ? p.a : p.b;
    const cRef = p.a.kind === "chunk" ? p.a : p.b;
    const t = live.index.get(tRef.id);
    if (!t) return;
    ws2.addRow([i + 1, level(p.score), pct(p.score), tTitle(t.id), asksOf(t), answerOf(t), dTitle(cRef.doc), leaf(cRef.title), chunkText(cRef), reason(p), "", ""]);
  });
  style(ws2);

  await wb.xlsx.writeFile(outPath);
  console.log(`đã ghi ${outPath}: tài liệu↔tài liệu ${kk.length} cặp, câu trả lời↔tài liệu ${tk.length} cặp (model ${live.index.vectorsModel})`);
  await db.close();
}
main().catch((e) => {
  console.error("lỗi:", e);
  process.exit(1);
});
