import { describe, expect, it } from "vitest";
import { buildKnowledgeSearchPlans, fuseKnowledgeRanks } from "../src/core/router";
import type { KnowledgeHit } from "../src/core/ports";

const hit = (id: string, score: number): KnowledgeHit => ({
  chunkId: id,
  docSlug: id,
  heading: id,
  text: `text ${id}`,
  score,
  lang: "en",
});

describe("RAG query-variant fusion", () => {
  it("không đưa raw query khác ngôn ngữ KB vào RRF khi đã có rewrite hợp lệ", () => {
    const out = buildKnowledgeSearchPlans(
      "dia chi vi cua toi nam o dau",
      "vi",
      "find wallet address",
      "en",
      "Where can I find my wallet address?",
    );
    expect(out.map((x) => x.q)).toEqual(["find wallet address", "Where can I find my wallet address?"]);
    expect(out.every((x) => x.lang === "en")).toBe(true);
  });

  it("giữ raw query làm fail-safe nếu rewrite bị validation loại bỏ", () => {
    expect(buildKnowledgeSearchPlans("địa chỉ ví", "vi", undefined, "en", undefined)).toEqual([
      { q: "địa chỉ ví", lang: "vi", weight: 1 },
    ]);
  });

  it("giữ raw query khi khách dùng đúng ngôn ngữ KB và deduplicate rewrite giống hệt", () => {
    expect(buildKnowledgeSearchPlans("forgot password", "en", "forgot password", "en", "forgot password")).toEqual([
      { q: "forgot password", lang: "en", weight: 1.2 },
    ]);
  });

  it("không so sánh max raw score giữa hai query khác calibration", () => {
    const wrong = hit("wrong", 0.97);
    const correctFromOriginal = hit("correct", 0.71);
    const correctFromEnglish = hit("correct", 0.76);
    const wrongFromEnglish = hit("wrong", 0.72);

    const out = fuseKnowledgeRanks(
      [
        { hits: [wrong, correctFromOriginal], weight: 1.0 },
        { hits: [correctFromEnglish, wrongFromEnglish], weight: 1.2 },
      ],
      0.25,
      8,
    );

    expect(out.map((x) => x.chunkId)).toEqual(["correct", "wrong"]);
    expect(out[0]!.score).toBe(0.76); // giữ raw score thật cho evidence gate, chỉ rank bằng RRF
  });

  it("lọc threshold, exclusion và deduplicate cùng chunk", () => {
    const out = fuseKnowledgeRanks(
      [
        { hits: [hit("a", 0.8), hit("b", 0.2), hit("c", 0.7)], weight: 1 },
        { hits: [hit("a", 0.7), hit("d", 0.9)], weight: 1 },
      ],
      0.25,
      2,
      (x) => x.chunkId === "d",
    );
    expect(out.map((x) => x.chunkId)).toEqual(["a", "c"]);
  });
});
