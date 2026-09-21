import { describe, expect, it } from "vitest";
import { checkParity } from "../src/cli/parity";
import { loadContentDir } from "../src/core/bundle";

describe("đối chiếu với luật cũ (legacy/)", () => {
  const report = checkParity();

  it("mọi câu trả lời cố định có mặt NGUYÊN VĂN trong kho template mới", () => {
    expect(report.legacyAnswerCount).toBeGreaterThanOrEqual(61);
    expect(report.answerMisses).toEqual([]);
  });

  it("mọi từ khoá khớp của luật cũ vẫn được phủ (trừ ngoại lệ có chủ ý, đã ghi lý do)", () => {
    expect(report.keywordMisses).toEqual([]);
  });

  it("các mục được viết lại có chủ ý đều có template thay thế", () => {
    const ids = new Set(loadContentDir().templates.map((t) => t.id));
    for (const id of ["fp-1-greeting", "fp-5b-kyc-email-queue", "fp-6b-kyc-review-long", "fp-11b-campaign-10m-nft", "fp-12-escalate", "esc-app-error-image", "email-old-email-required", "you-are-welcome", "whitepaper-general", "greeting-returning", "high-traffic", "fp-0-security-alert"]) {
      expect(ids.has(id), id).toBe(true);
    }
    for (let i = 1; i <= 6; i++) expect(ids.has(`antispam-${i}`)).toBe(true);
    expect(ids.has("antispam-7plus")).toBe(true);
  });
});
