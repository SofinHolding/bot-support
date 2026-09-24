import { describe, expect, it } from "vitest";
import { compileItems, itemsDocToYaml, parseItemsDoc } from "../src/core/items";
import type { Template } from "../src/domain/types";
import { migrateTemplates } from "../src/kb/migrate-items";

const T = (id: string, over: Partial<Template> & { keywords?: string[]; examples?: string[] } = {}): Template => ({
  id,
  group: over.group ?? "Account",
  response_mode: over.response_mode ?? "EXACT_TEMPLATE",
  priority: over.priority ?? 880,
  match: { keywords: over.keywords ?? [], exact: [], examples: over.examples ?? [], image_types: [], rules: [], requires: [], excludes: [], overrides_context: false, ...over.match },
  answers: over.answers ?? { en: `answer of ${id}` },
  ...(over.answer_from ? { answer_from: over.answer_from } : {}),
  follow_up: over.follow_up ?? {},
  sets_context: over.sets_context ?? { issue: id, status: "pending" },
  ...(over.ticket ? { ticket: over.ticket } : {}),
});

describe("chuyển template cũ sang mục hỏi đáp", () => {
  const legacy = [
    T("fp-7-change-email", { keywords: ["change email", "email"], examples: ["how to change my email"], follow_up: { no_old_email: "old-email-required", negative: "ESCALATE" } }),
    T("old-email-required", { group: "FollowUp", answers: { en: "You need the old email code." }, sets_context: { status: "none" } }),
    T("fp-11-ambassador", { group: "Ambassador", keywords: ["ambassador", "become ambassador"], examples: ["how to become an ambassador", "join ambassador program", "apply ambassador"] }),
    T("esc-swap", { group: "Escalate", keywords: ["swap failed"], examples: ["my swap failed", "swap error", "swap stuck"], answer_from: "fp-12-escalate", ticket: { category: "wallet", error_code: "W1" } }),
    T("fp-12-escalate", { group: "Escalate", answers: { en: "Contact support." }, sets_context: { status: "none" } }),
    T("fp-0-security-alert", { group: "Security", response_mode: "SECURITY_RULE", answers: { en: "Never share your seed." }, sets_context: { status: "none" } }),
    T("fp-1-greeting", { group: "Greeting", match: { keywords: [], exact: ["hi", "hello"], examples: [], image_types: [], rules: [], requires: [], excludes: [], overrides_context: false }, sets_context: { status: "none" } }),
  ];
  const res = migrateTemplates(legacy, { codeIds: new Set(["fp-12-escalate", "fp-0-security-alert", "fp-1-greeting"]) });
  const all = res.docs.flatMap((d) => d.items.map((i) => ({ ...i, topic: d.topic })));
  const item = (id: string) => all.find((i) => i.id === id)!;

  it("giữ nguyên id; bỏ từ khoá một từ và ghi nhật ký; không còn độ ưu tiên", () => {
    expect(all.map((i) => i.id).sort()).toEqual(["esc-swap", "fp-0-security-alert", "fp-1-greeting", "fp-11-ambassador", "fp-12-escalate", "fp-7-change-email"]);
    expect(item("fp-11-ambassador").phrases).toEqual(["become ambassador"]);
    expect(res.notes.some((n) => n.id === "fp-11-ambassador" && n.what === "bỏ từ khoá một từ" && n.detail.includes('"ambassador"'))).toBe(true);
    expect(compileItems(res.docs.find((d) => d.topic === "programs")!)[0]!.priority).toBe(500);
  });

  it("template chỉ tới được qua tin nối tiếp thành bước 2; id mới được ghi lại để chép bản dịch", () => {
    const it = item("fp-7-change-email");
    expect(it.steps).toHaveLength(2);
    expect(it.steps[0]!.next).toEqual({ no_old_email: "next", negative: "handoff" });
    expect(it.steps[1]!.say.en).toBe("You need the old email code.");
    expect(res.renamed).toEqual({ "old-email-required": "fp-7-change-email--b2" });
  });

  it("mục có ít hơn 3 cách hỏi được thêm cụm từ khoá làm cách hỏi tạm (ghi nhật ký)", () => {
    expect(item("fp-7-change-email").questions).toEqual(["how to change my email", "change email"]);
    expect(res.notes.some((n) => n.id === "fp-7-change-email" && n.what === "cách hỏi tạm")).toBe(true);
    expect(res.notes.some((n) => n.id === "fp-7-change-email" && n.what === "thiếu cách hỏi")).toBe(true);
  });

  it("lối tắt chuyển nhân viên -> handoff kèm ticket; luật bảo mật và câu chuyển nhân viên chuẩn là tin hệ thống; lời chào giữ điều kiện khớp nguyên câu", () => {
    expect(item("esc-swap")).toMatchObject({ kind: "handoff", topic: "support", handoff: { category: "wallet", error_code: "W1" }, steps: [] });
    expect(item("fp-0-security-alert")).toMatchObject({ kind: "system", steps: [{ say: { en: "Never share your seed." } }], advanced: { response_mode: "SECURITY_RULE" } });
    expect(item("fp-12-escalate")).toMatchObject({ kind: "system", steps: [{ say: { en: "Contact support." } }] });
    expect(item("fp-1-greeting")).toMatchObject({ kind: "answer", questions: [], advanced: { exact: ["hi", "hello"] } }); // khớp nguyên câu bằng code: không cần cách hỏi
  });

  it("mọi tài liệu sinh ra đọc lại được và dịch ra template chạy được", () => {
    for (const d of res.docs) {
      const back = parseItemsDoc(itemsDocToYaml(d));
      expect(back.issues.filter((i) => i.level === "error")).toEqual([]);
      const tpl = compileItems(back.doc!);
      expect(tpl.length).toBeGreaterThan(0);
    }
    const sec = compileItems(parseItemsDoc(itemsDocToYaml(res.docs.find((d) => d.topic === "system")!)).doc!).find((t) => t.id === "fp-0-security-alert")!;
    expect(sec.response_mode).toBe("SECURITY_RULE");
    expect(sec.sets_context).toEqual({ issue: "fp-0-security-alert", status: "none" });
  });
});

describe("đoạn tài liệu: vector mang đủ đường dẫn tiêu đề (audit R7)", () => {
  it("đoạn của mục con embed kèm 'A › B'; câu gửi khách và khoá bản dịch không đổi", async () => {
    const { parseKnowledgeDoc, sha1 } = await import("../src/core/knowledge");
    const md = "---\nslug: d\ntitle: D\nresponse_mode: GROUNDED_GENERATION\n---\n# D\n\n## Ambassador\n\nTop level text that is long enough here.\n\n### Tiers\n\nTier 3 needs ten referrals to unlock.\n";
    const chunks = parseKnowledgeDoc(md, "d").doc!.chunks;
    const top = chunks.find((c) => c.heading === "Ambassador")!;
    const sub = chunks.find((c) => c.heading === "Ambassador › Tiers")!;
    expect(top.embedText).toBe(top.text);
    expect(sub.text).toBe("Tiers\n\nTier 3 needs ten referrals to unlock.");
    expect(sub.embedText).toBe("Ambassador › Tiers\n\nTier 3 needs ten referrals to unlock.");
    expect(sub.hash).toBe(sha1(sub.text));
  });
});
