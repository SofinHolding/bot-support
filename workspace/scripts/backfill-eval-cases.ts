/**
 * Chạy một lần: thêm câu kiểm tra hồi quy ("Câu hỏi mẫu") cho các template ĐANG PUBLISH mà chưa có câu nào bảo vệ.
 * Dùng cùng logic tự động với KbService.autoRegisterEvalCases (kb/service.ts) — lấy 1 câu có sẵn trong `examples`
 * của chính template, không gọi AI, không sửa nội dung template. An toàn chạy lại nhiều lần (bỏ qua template đã có câu).
 *
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/backfill-eval-cases.ts
 */
import { openDb } from "../src/db/db";
import { kbRepo } from "../src/db/repo-kb";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("cần DATABASE_URL trong .env");
  const db = await openDb(process.env.DATABASE_URL);
  const kb = kbRepo(db);

  const rows = await kb.loadPublishedTemplateRows();
  const cases = await kb.listEvalCases();
  const covered = new Set(cases.map((c) => c.expected_template_id).filter((x): x is string => !!x));

  let added = 0;
  const skippedNoExample: string[] = [];
  for (const { template: t } of rows) {
    if (covered.has(t.id)) continue;
    const example = t.match.examples.find((e) => e.trim().length >= 4);
    if (!example) {
      skippedNoExample.push(t.id);
      continue;
    }
    await kb.addEvalCase({ question: example, expected: t.id, source: "auto" });
    covered.add(t.id);
    added++;
    console.log(`+ ${t.id}: "${example}"`);
  }

  console.log(`\nĐã thêm ${added} câu kiểm tra mới.`);
  if (skippedNoExample.length) console.log(`Bỏ qua (không có câu ví dụ nào để dùng): ${skippedNoExample.join(", ")}`);
  await db.close();
}
main().catch((e) => {
  console.error("lỗi:", (e as Error).message);
  process.exit(1);
});
