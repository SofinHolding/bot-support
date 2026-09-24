/**
 * Render Markdown thuần (không LLM) từ kết quả có cấu trúc của SKILL intake-draft — phải parse lại được đúng bằng chính
 * các parser đang dùng cho mọi tài liệu khác (parseTemplateFile/parseKnowledgeDoc), không có đường parse riêng nào khác.
 */
import { describe, expect, it } from "vitest";
import { renderIntakeMarkdown, renderKnowledgeMarkdown, renderTemplateMarkdown } from "../src/kb/intake";
import { parseKnowledgeDoc } from "../src/core/knowledge";
import { parseTemplateFile } from "../src/core/templates";
import type { IntakeDraftResult } from "../src/core/ports";

describe("renderTemplateMarkdown", () => {
  const draft: IntakeDraftResult = {
    kind: "templates",
    slug: "wallet-transfer-slow",
    title: "Wallet-to-wallet transfer is slow",
    templates: [
      { id: "wallet-transfer-slow", group: "Wallet", keywords: ["transfer slow", "wallet to wallet delay"], examples: ["Why is my transfer taking so long?", "chuyển ví nội bộ sao lâu vậy"], answer_en: "Internal transfers usually complete within 15-30 minutes." },
    ],
    knowledge: null,
  };

  it("render ra Markdown parse lại đúng id/group/keywords/examples/câu trả lời", () => {
    const md = renderTemplateMarkdown(draft);
    const { templates, issues } = parseTemplateFile(md, draft.slug);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(templates).toHaveLength(1);
    const t = templates[0]!;
    expect(t.id).toBe("wallet-transfer-slow");
    expect(t.group).toBe("Wallet");
    expect(t.response_mode).toBe("EXACT_TEMPLATE");
    expect(t.match.keywords).toEqual(["transfer slow", "wallet to wallet delay"]);
    expect(t.match.examples).toEqual(["Why is my transfer taking so long?", "chuyển ví nội bộ sao lâu vậy"]);
    expect(t.answers.en).toBe("Internal transfers usually complete within 15-30 minutes.");
  });

  it("nhiều template trong một lần nạp -> mỗi template parse ra riêng biệt, đúng thứ tự", () => {
    const two: IntakeDraftResult = { ...draft, templates: [draft.templates[0]!, { id: "second-one", group: "Wallet", keywords: ["kw2"], examples: ["ex2"], answer_en: "Answer two." }] };
    const { templates } = parseTemplateFile(renderTemplateMarkdown(two), two.slug);
    expect(templates.map((t) => t.id)).toEqual(["wallet-transfer-slow", "second-one"]);
  });

  it("renderIntakeMarkdown đi đúng nhánh templates khi kind=templates", () => {
    expect(renderIntakeMarkdown(draft)).toBe(renderTemplateMarkdown(draft));
  });
});

describe("renderKnowledgeMarkdown", () => {
  const draft: IntakeDraftResult = {
    kind: "knowledge",
    slug: "wallet-transfer-info",
    title: "Wallet transfer info",
    templates: [],
    knowledge: {
      lang: "en",
      sections: [
        { heading: "Why transfers take time", body: "Internal transfers go through two layers of security confirmation before completing." },
        { heading: "When to contact support", body: "If a transfer has not completed after one hour, contact support with the transaction id." },
      ],
    },
  };

  it("render ra Markdown parse lại đúng slug/response_mode/lang và đủ số đoạn", () => {
    const md = renderKnowledgeMarkdown(draft);
    const { doc, issues } = parseKnowledgeDoc(md, draft.slug);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(doc?.slug).toBe("wallet-transfer-info");
    expect(doc?.chunks).toHaveLength(2);
    expect(doc?.chunks.map((c) => c.heading)).toEqual(["Why transfers take time", "When to contact support"]);
    expect(doc?.chunks[0]!.text).toContain("two layers of security confirmation");
  });

  it("thiếu trường knowledge (kind sai) -> báo lỗi rõ ràng thay vì crash mơ hồ", () => {
    expect(() => renderKnowledgeMarkdown({ ...draft, knowledge: null })).toThrow(/thiếu trường knowledge/);
  });

  it("renderIntakeMarkdown đi đúng nhánh knowledge khi kind=knowledge", () => {
    expect(renderIntakeMarkdown(draft)).toBe(renderKnowledgeMarkdown(draft));
  });
});
