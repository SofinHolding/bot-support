/**
 * Dịch template mà KHÔNG làm hỏng những thứ không được dịch (AGENTS.md > Ngôn ngữ):
 * URL, tên sản phẩm (Interlink, ITLG, ITL, HCS, HHP, KYC), Telegram handle.
 * Ta thay chúng bằng token trước khi gửi cho LLM, rồi khôi phục và KIỂM TRA đủ token sau khi dịch.
 */
import { looksVietnamese, scriptProblem } from "./language";

const PATTERNS: RegExp[] = [
  /\bhttps?:\/\/[^\s)>\]"']+/gi, // URL
  /(?<![\w])@[A-Za-z0-9_]{4,}/g, // Telegram handle
  /\$?\b(?:ITLG|ITL|HCS|HHP|KYC)\b/g,
  /\bInter[Ll]ink(?:\s+Network)?\b/g,
];

const open = "⟦";
const close = "⟧";

export interface Protected {
  text: string;
  tokens: string[]; // index -> giá trị gốc
}

export function protectTerms(text: string): Protected {
  const tokens: string[] = [];
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (m) => {
      // tránh bọc lại chính token đã tạo
      const i = tokens.push(m) - 1;
      return `${open}${i}${close}`;
    });
  }
  return { text: out, tokens };
}

/** Khôi phục token. Ném lỗi nếu bản dịch làm mất hoặc nhân đôi bất kỳ token nào. */
export function restoreTerms(translated: string, tokens: string[]): string {
  for (let i = 0; i < tokens.length; i++) {
    const marker = `${open}${i}${close}`;
    const count = translated.split(marker).length - 1;
    if (count !== 1) throw new Error(`bản dịch làm sai token bảo vệ #${i} (${tokens[i]}): xuất hiện ${count} lần`);
  }
  return translated.replace(new RegExp(`${open}(\\d+)${close}`, "g"), (_, n) => tokens[Number(n)] ?? "");
}

// Chữ số của các hệ chữ khác (Ả Rập-Ấn Độ, Ba Tư, Devanagari, Thái, toàn chiều rộng) -> 0-9: bản dịch sang ar/fa/hi/th thường viết "٢٤" thay vì "24"
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x0e50, 0xff10];
const toAsciiDigits = (s: string): string =>
  s.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9);
    return zero === undefined ? ch : String(cp - zero);
  });
const stripZeros = (int: string) => int.replace(/^0+(?=\d)/, "");

/** Một số (đã chuẩn hoá chữ số, không có dấu cách) -> dạng chuẩn: "1.000" (vi) = "1,000" (en) = 1000; "1,5" = "1.5"; bỏ số 0 đầu ("03" = "3"). */
function canonicalNumber(token: string): string[] {
  const seps: string[] = token.match(/[.,٫٬]/g) ?? [];
  if (!seps.length) return [stripZeros(token)];
  const groups = token.split(/[.,٫٬]/);
  const last = groups[groups.length - 1]!;
  const decimal = (int: string, frac: string) => `${stripZeros(int)}${frac.replace(/0+$/, "") ? `.${frac.replace(/0+$/, "")}` : ""}`;
  if (seps.length === 1) return [seps[0] === "٬" || (seps[0] !== "٫" && last.length === 3 && groups[0]!.length <= 3) ? stripZeros(groups.join("")) : decimal(groups[0]!, last)];
  const decIdx = seps.lastIndexOf("٫");
  if (decIdx >= 0) return [decimal(groups.slice(0, decIdx + 1).join(""), groups[decIdx + 1]!)]; // ٫ là dấu thập phân, ٬ là dấu nghìn
  if (seps.every((x) => x === seps[0])) {
    // 1.000.000 -> một số; 2.3.1 (phiên bản, IP) -> từng phần là một số riêng
    return groups.slice(1).every((g) => g.length === 3) && groups[0]!.length <= 3 ? [stripZeros(groups.join(""))] : groups.map(stripZeros);
  }
  return [decimal(groups.slice(0, -1).join(""), last)]; // "1,234.56" / "1.234,56": dấu cuối là thập phân
}

/** Mọi con số trong văn bản dưới dạng chuẩn, sắp xếp. Nhận các kiểu viết: 1.000.000 · 1,000,000 · 1 000 000 (Pháp/Nga) · ٢٤ · 09:00 = 9:00. */
/** Con số xuất hiện trong `text` mà KHÔNG có trong bất kỳ nguồn nào: câu trả lời do AI viết không được chứa số liệu ngoài tài liệu. */
export function numbersNotIn(text: string, sources: string[]): string[] {
  const allowed = new Set(digitGroups(sources.join("\n")));
  return [...new Set(digitGroups(text).filter((n) => !allowed.has(n)))];
}

const digitGroups = (s: string): string[] => {
  const t = toAsciiDigits(s).replace(/(?<![\d.,٫٬])(\d{1,3})((?:[   ]\d{3}(?!\d))+)/g, (_, a: string, b: string) => a + b.replace(/[   ]/g, ""));
  return (t.match(/\d+(?:[.,٫٬]\d+)*/g) ?? []).flatMap(canonicalNumber).sort();
};

/**
 * Kiểm tra bằng CODE một bản dịch có trung thành không (không thay được việc đọc của người duyệt, nhưng chặn được các lỗi nguy hiểm nhất):
 *  - mọi con số / ngày / phần trăm của bản gốc phải còn đủ và KHÔNG có số mới (số là thứ LLM hay bịa nhất);
 *  - không rỗng, không bị cắt cụt hay phình ra bất thường;
 *  - đích không phải tiếng Việt thì không được còn sót tiếng Việt.
 * Trả về danh sách vấn đề; rỗng = đạt.
 */
export function translationProblems(source: string, translated: string, targetLang: string): string[] {
  const problems: string[] = [];
  const t = translated.trim();
  if (!t) return ["bản dịch rỗng"];
  const a = digitGroups(source);
  const b = digitGroups(translated);
  // Tên tháng ("November", "tháng Mười Một") trong nguồn được nhiều ngôn ngữ (Hàn, Nhật, Trung) viết bằng số ("11월"): số 1..12 thêm vào khi nguồn có tên tháng thì không phải bịa
  const monthNames = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b|tháng (?:một|hai|ba|tư|năm|sáu|bảy|tám|chín|mười|mười một|mười hai)\b/i.test(source);
  const bb = [...b];
  for (const x of a) { const i = bb.indexOf(x); if (i >= 0) bb.splice(i, 1); }
  const extra = monthNames ? bb.filter((n) => !/^(?:[1-9]|1[0-2])$/.test(n)) : bb;
  const missing = a.filter((x) => !b.includes(x));
  if (missing.length || extra.length) problems.push(`bản dịch đổi/thêm/bớt con số (gốc: ${a.join(",") || "-"}; dịch: ${b.join(",") || "-"})`);
  const ratio = t.length / Math.max(1, source.trim().length);
  if (source.trim().length >= 40 && (ratio < 0.12 || ratio > 3.5)) problems.push(`độ dài bản dịch bất thường (${Math.round(ratio * 100)}% so với gốc)`);
  if (targetLang !== "vi" && looksVietnamese(t)) problems.push("bản dịch còn sót tiếng Việt");
  const script = scriptProblem(t, targetLang);
  if (script) problems.push(script);
  return problems;
}

/**
 * Đổi các lỗi kiểm tra bản dịch (`translationProblems`, `checkOutput`, lỗi URL/handle của LlmClient — viết tiếng Việt cho admin)
 * thành lời nhắc tiếng Anh gửi lại SKILL translate-answer (`<previous_attempt_problems>`, R11). Không đưa chữ tiếng Việt vào
 * lời nhắc để không kéo bản dịch lần sau về tiếng Việt.
 */
export function translationFeedback(problems: string[]): string[] {
  return problems.map((p) => {
    const nums = /con số \(gốc: ([^;]*); dịch: ([^)]*)\)/.exec(p);
    if (nums) return `The numbers changed. Source numbers: ${nums[1]}. Numbers in your translation: ${nums[2]}. Keep exactly the source numbers and add no other number (R3).`;
    if (/rỗng/.test(p)) return "The translation was empty. Translate the whole source (R1).";
    if (/độ dài/.test(p)) return "The translation length does not match the source. Translate every sentence, add nothing, leave nothing out (R2).";
    if (/tiếng Việt/.test(p)) return "The translation still contains Vietnamese. Rewrite every Vietnamese word in the target language; no Vietnamese diacritic letter may remain (R1a).";
    if (/Kana/.test(p) || /chữ của ngôn ngữ đích|không phải Latin/.test(p)) return "The translation is not written in the script of the target language. Write it entirely in the target language's script (R1, R10).";
    if (/URL|handle/.test(p)) return "A URL or @handle was changed, added or lost. Keep every protected token ⟦n⟧ exactly once and write no URL or handle yourself (R5).";
    if (/vượt \d+ ký tự/.test(p)) return "The translation is too long for one message. Translate faithfully and concisely without adding anything (R2).";
    return "The translation failed an automatic faithfulness check. Translate the source again, literally and completely (R2, R10).";
  });
}

/** Tên/URL/handle cần còn nguyên; bỏ dấu "$" trước mã token ("$ITL" và "ITL" là cùng một thứ khi so khớp) */
const protectedIn = (s: string): string[] => [...s.matchAll(PATTERNS[0]!), ...s.matchAll(PATTERNS[1]!), ...s.matchAll(PATTERNS[2]!), ...s.matchAll(PATTERNS[3]!)].map((m) => m[0].toLowerCase().replace(/^\$/, "").replace(/\s+network$/, "")); // "Interlink Network" ~ "Interlink"

/**
 * Kiểm tra bằng CODE câu truy vấn do SKILL translate-query sinh ra (chỉ dùng để tìm, nhưng truy vấn sai = tìm sai đoạn):
 *  - mọi con số của câu hỏi còn nguyên; KHÔNG có số nào ngoài câu hỏi và ngữ cảnh cho phép (không bịa số);
 *  - tên sản phẩm / URL / @handle của câu hỏi còn nguyên;
 *  - viết bằng ngôn ngữ tìm kiếm (chữ viết đúng, và không lẫn tiếng Việt khi ngôn ngữ tìm kiếm không phải tiếng Việt).
 */
export function queryProblems(question: string, query: string, contextText: string, searchLang: string): string[] {
  const problems: string[] = [];
  const q = query.trim();
  if (!q) return ["câu truy vấn rỗng"];
  const inQuestion = digitGroups(question);
  const inQuery = digitGroups(q);
  const allowed = new Set([...inQuestion, ...digitGroups(contextText)]);
  const missing = inQuestion.filter((n) => !inQuery.includes(n));
  const invented = inQuery.filter((n) => !allowed.has(n));
  if (missing.length) problems.push(`truy vấn làm mất con số của câu hỏi (${missing.join(",")})`);
  if (invented.length) problems.push(`truy vấn thêm con số không có trong câu hỏi/ngữ cảnh (${invented.join(",")})`);
  const lowerQuery = q.toLowerCase();
  const lostTerms = [...new Set(protectedIn(question))].filter((p) => !lowerQuery.includes(p));
  if (lostTerms.length) problems.push(`truy vấn làm mất tên/URL/handle: ${lostTerms.join(", ")}`);
  if (searchLang !== "vi" && looksVietnamese(q)) problems.push("truy vấn còn tiếng Việt trong khi ngôn ngữ tìm kiếm không phải tiếng Việt");
  const script = scriptProblem(q, searchLang);
  if (script) problems.push(script.replace("bản dịch", "truy vấn"));
  return problems;
}

/** Sau khi khôi phục: mọi URL/handle của bản gốc phải còn nguyên trong bản dịch. */
export function sameProtectedSet(original: string, translated: string): boolean {
  const grab = (s: string) => [...s.matchAll(PATTERNS[0]!), ...s.matchAll(PATTERNS[1]!)].map((m) => m[0]).sort();
  const a = grab(original);
  const b = grab(translated);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
