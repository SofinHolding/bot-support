/**
 * Đối chiếu kho template mới với luật cũ (legacy/): không câu trả lời cố định nào được thiếu hoặc sai lệch dù chỉ một ký tự,
 * và mọi từ khoá khớp của luật cũ vẫn được phủ.
 *
 *   npx tsx src/cli/parity.ts        (thoát mã 1 nếu có sai lệch)
 */
import { pathToFileURL } from "node:url";
import { loadContentDir } from "../core/bundle";
import { normalize } from "../core/text";
import { extractAgentsExtras, extractImageReaderExtras, extractLegacyAnswers } from "./legacy-parse";

const AGENTS = "legacy/AGENTS.md";
const SKILL = "legacy/skills/interlink-support/SKILL.md";
const IMAGE = "legacy/skills/image-reader/SKILL.md";

/**
 * Các mục cố ý được viết lại thành rule thay vì danh sách từ khoá (xem chú thích trong content/templates/fast-path.md).
 * Mỗi mục ghi rõ lý do để người đọc biết đây là quyết định có chủ ý, không phải sót.
 */
export const CURATED_HEADINGS: Record<string, string> = {
  "FP-1.": "lời chào chỉ khớp khi CẢ tin nhắn là lời chào (match.exact) để 'hi, how to withdraw' không bị nuốt",
  "FP-5b.": "khớp bằng rule (đã nhận email VÀ app vẫn chờ) + loại ảnh + ghi đè ngữ cảnh",
  "FP-6b.": "khớp bằng từ khoá + rule (KYC kèm khoảng thời gian như '20 days', '2 tháng')",
  "FP-11b.": "khớp bằng rule (chiến dịch 10M + chưa nhận NFT)",
  "FP-12.": "được tách thành các trigger esc-* (mỗi nhóm có mã lỗi/PIC riêng) dùng chung câu trả lời FP-12",
  "Got verification email": "trùng câu trả lời và điều kiện với FP-5b; hợp nhất vào FP-5b",
  "KHÔNG khớp case nào": "trùng câu trả lời với FP-12; là đường mặc định ESCALATE của router",
  "Sau template": "luật follow-up: gắn vào trường follow_up của template gốc, không khớp bằng từ khoá",
  "Câu hỏi CHUNG": "từ khoá lấy từ tiêu đề mục",
};

/** Từ khoá của luật cũ cố ý KHÔNG chuyển thành khớp trực tiếp, kèm lý do. */
export const INTENTIONAL_KEYWORD_EXCEPTIONS: Record<string, string> = {
  "OTP not receive": "FP-12 ghi '(sau warning đầu)': chỉ escalate sau khi đã gửi cảnh báo OTP email => follow_up.not_receive của otp-email",
  "forgot ID": "trong mục S04 chỉ là ghi chú 'KHÁC với forgot ID (FP-8)'; từ khoá này thuộc FP-8, đã được phủ ở đó",
  failed: "FP-12 mô tả ẢNH có hộp thoại lỗi ('failed' / 'error occurred' / 'try again'): xử lý bằng loại ảnh error_dialog (esc-app-error-image), không khớp chữ trần",
  "error occurred": "như trên (esc-app-error-image)",
  "try again": "như trên (esc-app-error-image)",
  "convert ITLG to ITL": "trùng với 'convert ITLG' của FP-3; AGENTS.md quy định FAST-PATH khớp trước => giữ câu của SKILL cho cách nói tiếng Việt",
};

export interface ParityReport {
  legacyAnswerCount: number;
  answerMisses: { source: string; heading: string; text: string }[];
  keywordMisses: { heading: string; keyword: string }[];
  curatedSkipped: string[];
}

export function checkParity(contentRoot = "content"): ParityReport {
  const bundle = loadContentDir(contentRoot);
  const allAnswers = new Set<string>();
  for (const t of bundle.templates) for (const a of Object.values(t.answers)) allAnswers.add(a);
  const allKeywords = new Set<string>();
  for (const t of bundle.templates) for (const k of [...t.match.keywords, ...t.match.exact]) allKeywords.add(normalize(k));

  const legacy = [
    ...extractLegacyAnswers(AGENTS).map((a) => ({ ...a, source: "AGENTS.md" })),
    ...extractLegacyAnswers(SKILL).map((a) => ({ ...a, source: "SKILL.md" })),
    ...extractAgentsExtras(AGENTS).map((e) => ({ source: "AGENTS.md", heading: e.key, text: e.text, keywords: [] as string[] })),
    ...extractImageReaderExtras(IMAGE).map((e) => ({ source: "image-reader", heading: e.key, text: e.text, keywords: [] as string[] })),
  ];

  const report: ParityReport = { legacyAnswerCount: legacy.length, answerMisses: [], keywordMisses: [], curatedSkipped: [] };
  for (const l of legacy) {
    if (!allAnswers.has(l.text)) report.answerMisses.push({ source: l.source, heading: l.heading, text: l.text });
    const curated = Object.keys(CURATED_HEADINGS).find((k) => l.heading.includes(k));
    if (curated) {
      report.curatedSkipped.push(`${l.heading.slice(0, 60)} — ${CURATED_HEADINGS[curated]}`);
      continue;
    }
    for (const k of l.keywords) {
      if (INTENTIONAL_KEYWORD_EXCEPTIONS[k]) continue;
      if (!allKeywords.has(normalize(k))) report.keywordMisses.push({ heading: l.heading, keyword: k });
    }
  }

  // FP-12: mọi từ khoá cũ (trừ ngoại lệ có chủ ý) phải nằm trong một trigger esc-*
  const fp12 = legacy.find((l) => l.heading.startsWith("FP-12."));
  for (const k of fp12?.keywords ?? []) {
    if (INTENTIONAL_KEYWORD_EXCEPTIONS[k]) continue;
    if (!allKeywords.has(normalize(k))) report.keywordMisses.push({ heading: "FP-12", keyword: k });
  }
  return report;
}

function main() {
  const r = checkParity();
  console.log(`Câu trả lời cố định trong luật cũ: ${r.legacyAnswerCount}`);
  console.log(`Thiếu/sai lệch câu trả lời: ${r.answerMisses.length}`);
  for (const m of r.answerMisses) console.log(`  ✗ [${m.source}] ${m.heading}: ${JSON.stringify(m.text.slice(0, 80))}`);
  console.log(`Từ khoá cũ chưa được phủ: ${r.keywordMisses.length}`);
  for (const m of r.keywordMisses) console.log(`  ✗ ${m.heading}: "${m.keyword}"`);
  console.log(`Mục được viết lại có chủ ý (${r.curatedSkipped.length}):`);
  for (const c of r.curatedSkipped) console.log(`  · ${c}`);
  process.exit(r.answerMisses.length || r.keywordMisses.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
