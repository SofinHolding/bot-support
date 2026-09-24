import { describe, expect, it } from "vitest";
import { itemsDocToYaml, parseItemsDoc, type ItemsDoc } from "../src/core/items";
import { applyReview, parsePairDecision } from "../src/kb/review-import";

const doc = (): ItemsDoc => ({
  topic: "account",
  title: "Tài khoản",
  items: [
    { id: "fp-8-forgot-id", title: "Quên ID", kind: "answer", questions: ["forgot id", "I forgot my ID", "lost my id"], phrases: ["forgot id"], distinct_from: [], steps: [{ say: { en: "Tap Forgot ID.", vi: "Bấm Quên ID." } }] },
    { id: "forgot-login-id", title: "Quên ID đăng nhập", kind: "answer", questions: ["forgot login id", "lost login id", "cannot remember login id"], phrases: ["forgot login id"], distinct_from: [], steps: [{ say: { en: "Tap Forgot Login ID." } }] },
    { id: "fp-3-listing-tge", title: "Niêm yết", kind: "answer", questions: ["when list", "when tge", "convert ITLG"], phrases: ["when list", "convert itlg"], distinct_from: [], steps: [{ say: { en: "Follow us." } }] },
    { id: "itlg-to-itl-conversion", title: "Chuyển ITLG sang ITL", kind: "answer", questions: ["how to convert ITLG to ITL", "ITLG to ITL", "swap ITLG into ITL"], phrases: [], distinct_from: [], steps: [{ say: { en: "Not yet." } }], },
    { id: "esc-swap", title: "Swap lỗi", kind: "handoff", questions: ["swap failed", "swap error", "swap stuck"], phrases: [], distinct_from: [], steps: [] },
    { id: "fp-0-security-alert", title: "Bảo mật", kind: "system", questions: [], phrases: [], distinct_from: [], steps: [{ say: { en: "Never share." } }] },
  ],
});

describe("áp quyết định của khách hàng", () => {
  it("giữ cả hai: ghi ngữ cảnh + 'khác với', câu hỏi lại để trống cho người quản lý viết (publish bị chặn tới khi có)", () => {
    const r = applyReview([doc()], { pairs: [{ code: "C001", a: "template:fp-8-forgot-id", b: "template:forgot-login-id", decision: "keep_both", contextA: "quên InterLink ID", contextB: "quên ID đăng nhập" }] });
    const a = r.docs[0]!.items.find((i) => i.id === "fp-8-forgot-id")!;
    expect(a.applies_when).toBe("quên InterLink ID");
    expect(a.distinct_from).toEqual([{ item: "forgot-login-id", difference: "Quên ID: quên InterLink ID / Quên ID đăng nhập: quên ID đăng nhập", clarify: "" }]);
    expect(r.todo.join("\n")).toMatch(/viết câu hỏi lại khách/);
    expect(parseItemsDoc(itemsDocToYaml(r.docs[0]!)).issues.some((i) => i.level === "error" && /thiếu câu hỏi lại khách/.test(i.message))).toBe(true);
  });

  it("chỉ giữ một mục: cách hỏi và cụm của mục bị bỏ gộp vào mục giữ lại", () => {
    const r = applyReview([doc()], { pairs: [{ code: "C001", a: "template:fp-8-forgot-id", b: "template:forgot-login-id", decision: "keep_second" }] });
    const ids = r.docs[0]!.items.map((i) => i.id);
    expect(ids).not.toContain("fp-8-forgot-id");
    const kept = r.docs[0]!.items.find((i) => i.id === "forgot-login-id")!;
    expect(kept.questions).toContain("I forgot my ID");
    expect(kept.phrases).toEqual(["forgot login id", "forgot id"]);
  });

  it("mâu thuẫn - sửa: thay câu trả lời (bỏ bản dịch cũ); câu mới tiếng Việt bị nhắc viết lại tiếng Anh", () => {
    const r = applyReview([doc()], { pairs: [{ code: "X001", a: "template:fp-3-listing-tge", b: "template:itlg-to-itl-conversion", decision: "fix", fixText: "Chưa hỗ trợ chuyển đổi.", fixWhere: "b" }] });
    expect(r.docs[0]!.items.find((i) => i.id === "itlg-to-itl-conversion")!.steps[0]!.say).toEqual({ en: "Chưa hỗ trợ chuyển đổi." });
    expect(r.docs[0]!.items.find((i) => i.id === "fp-3-listing-tge")!.steps[0]!.say.en).toBe("Follow us.");
    expect(r.todo.join("\n")).toMatch(/tiếng Việt/);
  });

  it("không bỏ được tin hệ thống; không đổi câu trả lời của mục chuyển nhân viên mà không hỏi", () => {
    const r = applyReview([doc()], { items: [{ id: "fp-0-security-alert", decision: "drop" }, { id: "esc-swap", decision: "edit", newAnswer: "Try again later." }] });
    expect(r.docs[0]!.items.map((i) => i.id)).toContain("fp-0-security-alert");
    expect(r.todo.join("\n")).toMatch(/tin hệ thống/);
    expect(r.todo.join("\n")).toMatch(/mục chuyển nhân viên/);
  });

  it("cặp mục ↔ đoạn tài liệu: xuất quyết định để lưu lúc publish; sửa đoạn tài liệu được liệt kê riêng", () => {
    const r = applyReview([doc()], {
      pairs: [
        { code: "X002", a: "template:fp-3-listing-tge", b: "chunk:whitepaper#Listing", decision: "keep_both", contextA: "hỏi ngày niêm yết", contextB: "hỏi cơ chế niêm yết" },
        { code: "X003", a: "template:fp-3-listing-tge", b: "chunk:whitepaper#TGE", decision: "fix", fixText: "New TGE text.", fixWhere: "b" },
      ],
    });
    expect(r.pairDecisions.map((d) => [d.a, d.b, d.decision])).toEqual([
      ["item:fp-3-listing-tge", "chunk:whitepaper#Listing", "keep_both"],
      ["item:fp-3-listing-tge", "chunk:whitepaper#TGE", "fixed"],
    ]);
    expect(r.chunkChanges).toEqual([{ doc: "whitepaper", heading: "TGE", action: "edit", text: "New TGE text.", from: "cặp X003" }]);
  });

  it("thêm cách hỏi từ khách; đọc đúng chữ trong ô Quyết định", () => {
    const r = applyReview([doc()], { items: [{ id: "forgot-login-id", addQuestions: ["I can't log in, forgot the ID", "forgot login id"] }] });
    expect(r.docs[0]!.items.find((i) => i.id === "forgot-login-id")!.questions).toHaveLength(4);
    expect(parsePairDecision("Trùng - chỉ giữ mục thứ hai")).toBe("keep_second");
    expect(parsePairDecision("khác")).toBeUndefined();
  });
});
