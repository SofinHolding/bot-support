/**
 * Sinh bộ câu hỏi mẫu (content/eval/eval_cases.jsonl) từ chính các từ khoá của template (kiểm tra xung đột/che khuất giữa
 * các template khi thêm nội dung) và gộp với các câu diễn đạt tự nhiên viết tay trong content/eval/handwritten.jsonl.
 *
 * LƯU Ý: đây là bộ khởi điểm. Bộ chuẩn (~300 câu thật, gắn nhãn) phải lấy từ transcript của hệ thống cũ.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildIndex, loadContentDir } from "../core/bundle";
import { evalSettings, outcomeKey, routeOffline } from "../kb/eval";

async function main() {
  const bundle = loadContentDir("content");
  const index = await buildIndex(bundle);
  const settings = evalSettings();
  const out: string[] = [];
  const skipped: string[] = [];

  for (const t of bundle.templates) {
    if (t.response_mode !== "EXACT_TEMPLATE" || !t.match.keywords.length) continue;
    for (const k of t.match.keywords.slice(0, 6)) {
      const r = await routeOffline(k, null, index, bundle.evaluator, settings);
      const got = outcomeKey(r.outcome);
      // esc-* dùng chung câu FP-12: chấp nhận bất kỳ trigger esc-* nào cho cùng nhóm
      if (got === t.id) out.push(JSON.stringify({ question: k, expected: t.id, source: "keyword" }));
      else skipped.push(`${t.id} <- "${k}" đang khớp ${got}`);
    }
  }
  const hand = "content/eval/handwritten.jsonl";
  if (existsSync(hand)) for (const l of readFileSync(hand, "utf8").split(/\r?\n/).filter((x) => x.trim())) out.push(JSON.stringify({ ...JSON.parse(l), source: "handwritten" }));
  writeFileSync("content/eval/eval_cases.jsonl", out.join("\n") + "\n", "utf8");
  console.log(`Đã ghi ${out.length} câu hỏi mẫu.`);
  if (skipped.length) {
    console.log(`Từ khoá bị template khác che khuất (${skipped.length}) — kiểm tra xem có chủ ý không:`);
    for (const s of skipped) console.log("  ·", s);
  }
}

void main();
