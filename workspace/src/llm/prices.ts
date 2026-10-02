import type { Usage } from "./types";

export type CostStatus = "actual" | "estimated" | "unknown";
export type TokenPrice = { in: number; out: number; cacheRead?: number; cacheWrite?: number };
export type CostEstimate = { usd: number | null; status: CostStatus };

/**
 * USD / triệu token. Giá model phải đến từ cấu hình đã được operator xác minh
 * (`LLM_PRICING_JSON`); không giữ bảng giá hard-code vì model/alias và giá có thể
 * thay đổi độc lập với bản phát hành ứng dụng. Model chưa cấu hình = UNKNOWN.
 */
export function costOf(model: string, u: Usage, extra: Record<string, TokenPrice> = {}): CostEstimate {
  const p = extra[model];
  if (!p) return { usd: null, status: "unknown" };
  // Không đoán hệ số cache của provider. Nếu usage có cache token mà operator chưa
  // cấu hình đúng rate riêng, toàn bộ cost của call phải là UNKNOWN thay vì một số
  // có vẻ chính xác nhưng dựa trên giả định pricing không được xác minh.
  if ((u.cacheRead > 0 && p.cacheRead === undefined) || (u.cacheWrite > 0 && p.cacheWrite === undefined)) {
    return { usd: null, status: "unknown" };
  }
  return {
    usd: (u.inputTokens * p.in + u.outputTokens * p.out + u.cacheRead * (p.cacheRead ?? 0) + u.cacheWrite * (p.cacheWrite ?? 0)) / 1_000_000,
    status: "estimated",
  };
}
