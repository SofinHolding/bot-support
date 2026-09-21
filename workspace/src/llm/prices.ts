import type { Usage } from "./types";

/** USD / triệu token (giá công khai; model không có trong bảng thì chi phí = 0 và chỉ đếm token). */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-fable-5-1": { in: 10, out: 50 },
};

export function costOf(model: string, u: Usage, extra: Record<string, { in: number; out: number }> = {}): number {
  const p = extra[model] ?? PRICES[model];
  if (!p) return 0;
  // cache đọc ~0.1x giá input, ghi ~1.25x
  return (u.inputTokens * p.in + u.outputTokens * p.out + u.cacheRead * p.in * 0.1 + u.cacheWrite * p.in * 1.25) / 1_000_000;
}
