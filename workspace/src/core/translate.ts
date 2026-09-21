/**
 * Dịch template mà KHÔNG làm hỏng những thứ không được dịch (AGENTS.md > Ngôn ngữ):
 * URL, tên sản phẩm (Interlink, ITLG, ITL, HCS, HHP, KYC), Telegram handle.
 * Ta thay chúng bằng token trước khi gửi cho LLM, rồi khôi phục và KIỂM TRA đủ token sau khi dịch.
 */
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

/** Sau khi khôi phục: mọi URL/handle của bản gốc phải còn nguyên trong bản dịch. */
export function sameProtectedSet(original: string, translated: string): boolean {
  const grab = (s: string) => [...s.matchAll(PATTERNS[0]!), ...s.matchAll(PATTERNS[1]!)].map((m) => m[0]).sort();
  const a = grab(original);
  const b = grab(translated);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
