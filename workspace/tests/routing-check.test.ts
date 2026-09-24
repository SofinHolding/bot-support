/**
 * Phương pháp "hỏi thử bot" (kb/routing-check.ts): chỉ báo chỗ bot TRẢ LỜI NHẦM THẬT, không báo mọi cặp chỉ giống chữ.
 * Sự cố người dùng gặp: báo cáo quét chồng lấn liệt kê 320 cặp, trong đó chỉ 1 cặp làm bot trả lời nhầm — người không rành
 * kỹ thuật không biết cặp nào đáng sửa.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashEmbedder } from "../src/core/embedding";
import { buildIndex } from "../src/core/bundle";
import { makeEvaluator } from "../src/core/predicates";
import type { Template } from "../src/domain/types";
import { evalSettings } from "../src/kb/eval";
import { scanCorpus } from "../src/kb/overlap";
import { describeConfusion, findConfusions } from "../src/kb/routing-check";
import type { Actor } from "../src/kb/service";
import { makeWorld, type World } from "./helpers";

const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };

const T = (id: string, keywords: string[], examples: string[], priority = 300): Template => ({
  id,
  group: "Test",
  response_mode: "EXACT_TEMPLATE",
  priority,
  match: { keywords, exact: [], examples, image_types: [], rules: [], requires: [], excludes: [], overrides_context: false },
  answers: { en: `answer of ${id}` },
  follow_up: {},
  sets_context: { issue: `issue ${id}`, status: "pending" },
});

describe("findConfusions — hỏi thử từng câu của mỗi mục", () => {
  const embedder = new HashEmbedder();
  const evaluator = makeEvaluator({});

  it("câu của mục A bị mục B (ưu tiên cao hơn, từ khoá chung hơn) giành -> 'nhầm', chỉ đúng câu đó", async () => {
    const idx = await buildIndex({ templates: [T("wide", ["token"], ["token question"], 900), T("narrow", ["token missing after swap"], ["my token missing after swap"])], evaluator }, embedder);
    const cs = await findConfusions(idx, evaluator, embedder, evalSettings());
    expect(cs.map((c) => [c.owner.id, c.got, c.kind])).toEqual(
      expect.arrayContaining([
        ["narrow", "wide", "nhầm"],
      ]),
    );
    expect(cs.every((c) => c.owner.id === "narrow")).toBe(true); // câu của "wide" vẫn về đúng "wide"
    expect(describeConfusion(cs[0]!, (id) => `tên ${id}`)).toMatch(/^Khách hỏi ".+" \((câu ví dụ|từ khoá) của mục "tên narrow" \(mã narrow\)\) → bot đang trả lời bằng mục "tên wide" \(mã wide\)\.$/);
  });

  it("hai mục cùng từ khoá, cùng độ ưu tiên -> 'mơ hồ' (luật không tự phân định, phải nhờ AI đoán)", async () => {
    const idx = await buildIndex({ templates: [T("a", ["reset my pin code"], ["reset my pin code please"]), T("b", ["reset my pin code"], ["i need to reset my pin code"])], evaluator }, embedder);
    const cs = await findConfusions(idx, evaluator, embedder, evalSettings());
    expect(cs.some((c) => c.owner.id === "a" && c.got === "b" && c.kind === "mơ hồ")).toBe(true);
    expect(cs.some((c) => c.owner.id === "b" && c.got === "a" && c.kind === "mơ hồ")).toBe(true);
  });

  it("hai mục giống chữ nhưng mỗi câu vẫn về đúng mục của nó -> không báo gì", async () => {
    const idx = await buildIndex({ templates: [T("forgot-pw", ["forgot password"], ["i forgot my password"]), T("forgot-id", ["forgot id"], ["i forgot my id"])], evaluator }, embedder);
    expect(await findConfusions(idx, evaluator, embedder, evalSettings())).toEqual([]);
  });

  it("dùng lại vector câu ví dụ đã có trong index: hỏi thử không gọi dịch vụ embedding cho câu ví dụ", async () => {
    let calls: string[] = [];
    const counting = { version: embedder.version, embed: async (t: string[]) => ((calls = [...calls, ...t]), embedder.embed(t)) };
    const idx = await buildIndex({ templates: [T("x1", ["zzq alpha"], ["how does zzq alpha work exactly"]), T("x2", ["zzq beta"], ["what is zzq beta used for"])], evaluator }, counting);
    calls = [];
    await findConfusions(idx, evaluator, counting, evalSettings());
    expect(calls).not.toContain("how does zzq alpha work exactly");
    expect(calls).not.toContain("what is zzq beta used for");
  });
});

describe("trên kho thật (seed) + bước 3 của bản nháp", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld({ adminIds: [9001, 9002], ownerId: 9001 });
  });
  afterAll(() => w.close());

  it("số chỗ bot trả lời nhầm thật ÍT hơn rất nhiều so với số cặp chỉ giống chữ; bắt đúng cặp chuyển đổi ITLG ↔ niêm yết", async () => {
    const rows = await w.kb.loadPublishedTemplateRows();
    const pairs = (await scanCorpus({ index: w.live.index, kb: w.kb, embedder: new HashEmbedder(), docOf: new Map(rows.map((r) => [r.template.id, r.docSlug])) }, { maxPairs: 500 })).filter(
      (p) => p.a.kind === "template" && p.b.kind === "template",
    );
    const cs = await findConfusions(w.live.index, w.live.evaluator, new HashEmbedder(), evalSettings(w.live.urlHosts));
    expect(cs.some((c) => c.owner.id === "itlg-to-itl-conversion" && c.got === "fp-3-listing-tge")).toBe(true); // "convert ITLG to ITL" bị mục niêm yết giành
    expect(cs.length).toBeLessThan(pairs.length / 5);
  });

  it("bản nháp có từ khoá quá chung giành câu của mục đang có -> bước 3 cảnh báo đúng câu, đúng mục, viết dễ hiểu", async () => {
    const md = `---\nid: test-greedy\ngroup: Test\nresponse_mode: EXACT_TEMPLATE\npriority: 999\nmatch:\n  keywords:\n    - KYC\n  examples:\n    - tell me about KYC in general please\n---\n<!-- answer:en -->\nGeneric KYC answer.\n`;
    const { report } = await w.kbService.createDraft({ slug: "test-greedy-doc", kind: "templates", md, author: admin });
    const s3 = report.steps.find((s) => s.name.startsWith("3."))!;
    expect(s3.status).toBe("warning");
    const text = s3.details.join("\n");
    expect(text).toMatch(/⚠ Khách hỏi ".+" \(.+ của mục ".+" \(mã fp-5-how-to-kyc\)\) → bot sẽ trả lời bằng mục ".+" \(mã test-greedy\)\./);
    expect(text).toContain("Cách sửa");
    // bước 3 chỉ cảnh báo; ở đây bản nháp còn làm SAI câu kiểm tra đang đúng nên bước 5 chặn publish — hai lớp cùng bắt một lỗi
    expect(report.steps.find((s) => s.name.startsWith("5."))!.status).toBe("error");
  });

  it("bản nháp chỉ giống chữ nhưng không giành câu của ai -> bước 3 xanh, không có dòng ⚠", async () => {
    const md = `---\nid: test-polite\ngroup: Test\nresponse_mode: EXACT_TEMPLATE\npriority: 300\nmatch:\n  keywords:\n    - zzq pineapple theme\n  examples:\n    - how to set zzq pineapple theme\n    - zzq pineapple theme please\n---\n<!-- answer:en -->\nTheme answer.\n`;
    const { report } = await w.kbService.createDraft({ slug: "test-polite-doc", kind: "templates", md, author: admin });
    const s3 = report.steps.find((s) => s.name.startsWith("3."))!;
    expect(s3.details.join("\n")).not.toContain("⚠");
    expect(s3.status).toBe("ok");
  });
});
