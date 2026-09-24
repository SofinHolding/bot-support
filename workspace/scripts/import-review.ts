/**
 * Đọc file rà soát khách hàng trả về và áp quyết định lên bộ mục hỏi đáp đã chuyển (src/kb/review-import.ts).
 * CHỈ GHI FILE: không đụng DB, không gọi AI.
 *
 *   npx tsx scripts/import-review.ts --file=<file khách trả về>.xlsx [--items=.staging/items] [--out=.staging/items-sau-duyet]
 *
 * Ghi ra <out>:
 *   <chủ đề>.yaml            — bộ mục hỏi đáp sau khi áp quyết định (nạp vào Admin Web dưới dạng bản nháp để kiểm tra)
 *   BAO-CAO-AP-DUNG.md       — đã áp gì, còn việc gì người quản lý bot phải làm, lỗi kiểm tra còn lại
 *   tai-lieu-can-sua.md      — các đoạn tài liệu tham khảo khách muốn sửa / bỏ
 *   quyet-dinh-cap.json      — quyết định về cặp mục hỏi đáp ↔ đoạn tài liệu, lưu vào bảng quyết định khi publish
 */
import ExcelJS from "exceljs";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { itemsDocToYaml, parseItemsDoc, type ItemsDoc } from "../src/core/items";
import { applyReview, parsePairDecision, parseRowDecision, parseWhere, type ChunkRow, type ItemRow, type PairRow, type ReviewInput, type SharedRow } from "../src/kb/review-import";

const arg = (k: string, d?: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const file = arg("file");
const itemsDir = arg("items", ".staging/items")!;
const outDir = arg("out", ".staging/items-sau-duyet")!;
if (!file) {
  console.error("thiếu --file=<file rà soát khách trả về>.xlsx");
  process.exit(1);
}

const text = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (typeof v === "object" && "richText" in v) return v.richText.map((r) => r.text).join("");
  if (typeof v === "object" && "text" in v) return String(v.text);
  if (typeof v === "object" && "result" in v) return String(v.result ?? "");
  return String(v);
};

/** Đọc một sheet thành các dòng {tiêu đề cột: giá trị}. `headerRow`: dòng chứa tiêu đề. */
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

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file!);
  const sheet = (prefix: string) => wb.worksheets.find((w) => w.name.startsWith(prefix));
  const unknown: string[] = [];
  const check = <T>(v: T | undefined, raw: string, where: string) => {
    if (raw && v === undefined) unknown.push(`${where}: không hiểu lựa chọn "${raw}"`);
    return v;
  };

  const items: ItemRow[] = rows(sheet("1.")).filter((r) => col(r, "Mã hệ thống")).map((r) => ({
    id: col(r, "Mã hệ thống"),
    decision: check(parseRowDecision(col(r, "Quyết định")), col(r, "Quyết định"), `mục ${col(r, "Mã hệ thống")}`),
    newAnswer: col(r, "Câu trả lời mới"),
    addQuestions: col(r, "Thêm câu khách hay hỏi").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    note: col(r, "Ghi chú"),
  }));
  const chunks: ChunkRow[] = rows(sheet("2.")).filter((r) => col(r, "Mã hệ thống")).map((r) => ({
    key: col(r, "Mã hệ thống"),
    decision: check(parseRowDecision(col(r, "Quyết định")), col(r, "Quyết định"), `đoạn ${col(r, "Mã hệ thống")}`),
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
  const input: ReviewInput = { items, chunks, pairs: [...pairRows("3."), ...pairRows("6.")], shared, objections };

  const docs: ItemsDoc[] = readdirSync(itemsDir).filter((f) => f.endsWith(".yaml")).map((f) => {
    const r = parseItemsDoc(readFileSync(join(itemsDir, f), "utf8"));
    if (!r.doc) throw new Error(`${f}: ${r.issues.map((i) => i.message).join("; ")}`);
    return r.doc;
  });
  const res = applyReview(docs, input);

  mkdirSync(outDir, { recursive: true });
  const problems: string[] = [];
  // báo cáo cho người đọc: tên mục thay cho mã
  const titles = new Map(res.docs.flatMap((d) => d.items.map((x) => [x.id, x.title] as const)));
  const readable = (m: string) => m.replace(/[a-z0-9]+(?:-[a-z0-9]+)+/g, (id) => (titles.has(id) ? `"${titles.get(id)}"` : id));
  for (const d of res.docs) {
    const yaml = itemsDocToYaml(d);
    writeFileSync(join(outDir, `${d.topic}.yaml`), yaml);
    for (const i of parseItemsDoc(yaml).issues.filter((x) => x.level === "error")) problems.push(`- ${d.title}${i.templateId ? `, mục "${d.items.find((x) => x.id === i.templateId)?.title ?? i.templateId}"` : ""}: ${readable(i.message)}`);
  }
  writeFileSync(join(outDir, "quyet-dinh-cap.json"), JSON.stringify(res.pairDecisions, null, 2));
  writeFileSync(
    join(outDir, "tai-lieu-can-sua.md"),
    ["# Đoạn tài liệu tham khảo cần sửa / bỏ", "", ...(res.chunkChanges.length ? res.chunkChanges.map((c) => `## ${c.action === "drop" ? "BỎ" : "SỬA"} — ${c.doc}: ${c.heading}\n\n(theo ${c.from})\n\n${c.text ?? ""}\n`) : ["Không có."])].join("\n"),
  );
  const list = (xs: string[]) => (xs.length ? xs.map((x) => (x.startsWith("- ") ? x : `- ${x}`)).join("\n") : "Không có.");
  writeFileSync(
    join(outDir, "BAO-CAO-AP-DUNG.md"),
    [
      "# Áp quyết định của khách hàng — báo cáo",
      "",
      `File: ${file}`,
      "",
      "## 1. Việc người quản lý bot còn phải làm",
      "",
      list([...unknown, ...res.todo]),
      "",
      "## 2. Lỗi kiểm tra còn lại (bản nháp sẽ không publish được tới khi xử lý)",
      "",
      list(problems),
      "",
      "## 3. Đã áp dụng",
      "",
      list(res.applied),
      "",
    ].join("\n"),
  );
  console.log(`áp ${res.applied.length} quyết định; còn ${res.todo.length + unknown.length} việc, ${problems.length} lỗi kiểm tra, ${res.chunkChanges.length} đoạn tài liệu cần sửa -> ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
