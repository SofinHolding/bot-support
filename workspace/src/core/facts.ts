/**
 * Trích bằng CODE các giá trị khách nêu trong tin nhắn (mã lỗi, phiên bản app, thiết bị, số lượng, ngày, khoảng thời gian).
 * Ghi vào `events` (customer_fact) nên luôn đúng nguyên văn và không mất khi tin cũ rời khỏi cửa sổ ngữ cảnh —
 * bản tóm tắt của LLM chỉ là phần phụ. Đầu vào là văn bản ĐÃ che (maskSensitive): ID/email/số dài không bao giờ vào đây.
 */
export type FactKind = "error_code" | "app_version" | "device" | "amount" | "date" | "duration";

export interface CustomerFact {
  kind: FactKind;
  value: string;
}

const PATTERNS: [FactKind, RegExp][] = [
  // không nhận "code 123456" đứng riêng: đó thường là mã xác minh (OTP), không phải mã lỗi
  ["error_code", /\b(?:error|err|lỗi|mã lỗi|loi|ma loi)\s*(?:code|số|so)?\s*[:#-]?\s*([A-Z]{0,4}[-_]?\d{2,6})\b/giu],
  ["app_version", /\b(?:v|ver|version|phiên bản|phien ban|bản|ban)\.?\s*(\d+\.\d+(?:\.\d+){0,2})\b/giu],
  ["device", /\b((?:android|ios|iphone|ipad|samsung|xiaomi|redmi|huawei|oppo|vivo|realme|pixel)(?:\s+[a-z]{0,6}\d[\w.]{0,8})?)\b/giu],
  ["amount", /(?<![\w.])(\d{1,7}(?:[.,]\d{1,8})*\s*(?:ITLG|ITL|USDT|USDC|USD|\$))(?!\w)/giu],
  ["date", /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2})\b/gu],
  ["duration", /\b(\d{1,3}\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|phút|phut|giờ|gio|tiếng|tieng|ngày|ngay|tuần|tuan|tháng|thang))(?![\p{L}\p{N}])/giu],
];

const MAX_FACTS_PER_MESSAGE = 6;

export function extractFacts(maskedText: string): CustomerFact[] {
  const out: CustomerFact[] = [];
  const seen = new Set<string>();
  for (const [kind, re] of PATTERNS) {
    for (const m of maskedText.matchAll(re)) {
      const value = (m[1] ?? "").replace(/\s+/g, " ").trim();
      const key = `${kind}:${value.toLowerCase()}`;
      if (!value || seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, value });
    }
  }
  return out.slice(0, MAX_FACTS_PER_MESSAGE);
}

/** Gộp fact của nhiều lượt: giá trị mới nhất đứng sau, bỏ trùng, giữ tối đa `limit` mục gần nhất. */
export function mergeFacts(lists: CustomerFact[][], limit = 10): string[] {
  const seen = new Map<string, string>();
  for (const facts of lists) {
    for (const f of facts) {
      const key = `${f.kind}:${f.value.toLowerCase()}`;
      seen.delete(key);
      seen.set(key, `${f.kind}=${f.value}`);
    }
  }
  return [...seen.values()].slice(-limit);
}
