import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { costOf } from "../src/llm/prices";

const usage = (inputTokens = 1000, outputTokens = 100, cacheRead = 0, cacheWrite = 0) => ({ inputTokens, outputTokens, cacheRead, cacheWrite });

describe("LLM pricing semantics", () => {
  it("unknown alias không bị hiểu nhầm là $0", () => {
    expect(costOf("cx/gpt-5.5", usage())).toEqual({ usd: null, status: "unknown" });
  });

  it("custom gateway pricing tạo estimated cost", () => {
    const r = costOf("cx/custom", usage(1_000_000, 100_000), { "cx/custom": { in: 2, out: 10 } });
    expect(r.status).toBe("estimated");
    expect(r.usd).toBeCloseTo(3);
  });

  it("zero token với model có pricing vẫn là estimated zero, không phải unknown", () => {
    expect(costOf("configured", usage(0, 0), { configured: { in: 1, out: 5 } })).toEqual({ usd: 0, status: "estimated" });
  });

  it("không tự đoán giá cache khi provider chưa cấu hình rate riêng", () => {
    expect(costOf("x", usage(0, 0, 1_000_000, 1_000_000), { x: { in: 2, out: 10 } })).toEqual({ usd: null, status: "unknown" });
  });

  it("cache token chỉ được tính khi operator cấu hình rate đã xác minh", () => {
    const r = costOf("x", usage(0, 0, 1_000_000, 1_000_000), { x: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 } });
    expect(r).toEqual({ usd: 2.7, status: "estimated" });
  });

  it("pricing alias cấu hình được và config sai fail-closed", () => {
    const cfg = loadConfig({ DATABASE_URL: "pglite:memory", LLM_PRICING_JSON: '{"cx/gpt":{"in":1.5,"out":7}}' } as NodeJS.ProcessEnv);
    expect(cfg.llmPrices["cx/gpt"]).toEqual({ in: 1.5, out: 7 });
    const cache = loadConfig({ DATABASE_URL: "pglite:memory", LLM_PRICING_JSON: '{"cx/gpt":{"in":1.5,"out":7,"cacheRead":0.15,"cacheWrite":1.9}}' } as NodeJS.ProcessEnv);
    expect(cache.llmPrices["cx/gpt"]).toEqual({ in: 1.5, out: 7, cacheRead: 0.15, cacheWrite: 1.9 });
    expect(() => loadConfig({ DATABASE_URL: "pglite:memory", LLM_PRICING_JSON: '{"cx":{"in":-1,"out":2}}' } as NodeJS.ProcessEnv)).toThrow(/số >= 0/);
    expect(() => loadConfig({ DATABASE_URL: "pglite:memory", LLM_PRICING_JSON: '{"cx":{"in":1,"out":2,"cacheRead":-1}}' } as NodeJS.ProcessEnv)).toThrow(/cacheRead/);
  });
});
