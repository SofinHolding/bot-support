/**
 * Xung đột nội dung ĐÃ PUBLISH (khác với "kb/overlap.test.ts": đó là kiểm tra lúc bản nháp + quét toàn kho tạm thời):
 *  - publish() chốt lại chồng lấn của tài liệu vừa lên vào kb_conflicts, kèm AI mô tả (SKILL review-overlap) cho vài cặp
 *    điểm cao nhất — nguồn cho dấu chấm đỏ + tooltip trên danh sách Tài liệu (Admin Web);
 *  - khi tín hiệu là một cụm cụ thể trong match.keywords/examples của MỘT template, có thể "Gỡ máy móc" (narrowTemplateMatch)
 *    mà không cần AI diễn giải tự do — applyNarrow() điền sẵn bản nháp, admin vẫn phải Publish lại như bình thường;
 *  - publish lại một tài liệu tự dọn các dòng xung đột cũ không còn đúng (KbRepo.syncConflicts).
 * Dùng cụm từ khoá TỰ ĐẶT (không trùng gì trong content/eval/eval_cases.jsonl) để không vô tình đổi kết quả eval của nội
 * dung thật đang có — bài kiểm tra này chỉ kiểm cơ chế, không kiểm nội dung production.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/kb/service";
import { narrowTemplateMatch, replaceChunkSection, replaceTemplateAnswer } from "../src/kb/overlap";
import { fakeLlm, makeWorld, type World } from "./helpers";

const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };
// Luôn kèm một từ khoá riêng ngoài `shared`: gỡ máy móc chỉ xoá đúng một cụm, template phải còn cách khớp khác — giống
// esc-login-fail thật (2 từ khoá, gỡ 1 còn 1), tránh trường hợp biên "template hết sạch từ khoá" không liên quan tới bài kiểm tra này.
const tpl = (id: string, shared: string, ownKeyword: string, answer = "A test answer.") => `---
id: ${id}
group: Test
response_mode: EXACT_TEMPLATE
priority: 300
match:
  keywords:
    - ${shared}
    - ${ownKeyword}
---
<!-- answer:en -->
${answer}
`;

describe("narrowTemplateMatch (thuần, không DB)", () => {
  const md = `---
id: esc-login-fail
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 755
match:
  keywords:
    - login fail
    - face verify fail
  examples:
    - login fail
    - face verify fail
answer_from: fp-12-escalate
---
<!-- next -->
---
id: esc-wallet-create
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 760
match:
  keywords:
    - creating wallet failed
answer_from: fp-12-escalate
---
<!-- next -->
`;

  it("gỡ đúng một cụm khỏi ĐÚNG một template, cả keywords: lẫn examples:, template khác nguyên vẹn", () => {
    const { md: out, removed } = narrowTemplateMatch(md, "esc-login-fail", "face verify fail");
    expect(removed).toBe(2); // 1 dòng ở keywords:, 1 dòng ở examples:
    expect(out).not.toMatch(/-\s*face verify fail/);
    expect(out).toContain("- login fail"); // cụm còn lại của CHÍNH template này vẫn còn
    expect(out).toContain("creating wallet failed"); // template khác không bị đụng tới
  });

  it("không tìm thấy cụm (đã sửa rồi) -> removed=0, markdown giữ nguyên", () => {
    const { md: out, removed } = narrowTemplateMatch(md, "esc-login-fail", "cụm không tồn tại");
    expect(removed).toBe(0);
    expect(out).toBe(md);
  });
});

describe("replaceTemplateAnswer / replaceChunkSection (sửa tự do trong một khung xung đột — trợ lý Nạp nội dung mới)", () => {
  const tplMd = `---
id: esc-login-fail
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 755
match:
  keywords:
    - login fail
---
<!-- answer:en -->
Old escalate answer.
---
id: esc-wallet-create
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 760
match:
  keywords:
    - creating wallet failed
---
<!-- answer:en -->
Untouched wallet answer.
`;

  it("thay đúng bản dịch en của MỘT template, template khác nguyên vẹn", () => {
    const { md, replaced } = replaceTemplateAnswer(tplMd, "esc-login-fail", "en", "New rewritten answer.");
    expect(replaced).toBe(true);
    expect(md).toContain("New rewritten answer.");
    expect(md).not.toContain("Old escalate answer.");
    expect(md).toContain("Untouched wallet answer."); // template khác không bị đụng
  });

  it("template chưa có bản dịch ngôn ngữ đó -> chèn thêm, không xoá bản dịch khác", () => {
    const { md, replaced } = replaceTemplateAnswer(tplMd, "esc-login-fail", "vi", "Câu trả lời tiếng Việt mới.");
    expect(replaced).toBe(true);
    expect(md).toContain("<!-- answer:vi -->");
    expect(md).toContain("Câu trả lời tiếng Việt mới.");
    expect(md).toContain("Old escalate answer."); // bản en cũ vẫn còn
  });

  it("id không tồn tại -> replaced=false, markdown giữ nguyên", () => {
    const { md, replaced } = replaceTemplateAnswer(tplMd, "khong-ton-tai", "en", "x");
    expect(replaced).toBe(false);
    expect(md).toBe(tplMd);
  });

  const kbMd = `---
slug: login-help
title: Login help
response_mode: GROUNDED_GENERATION
lang: en
---
# Login help

## Step 1 — Invalid ID

Old step 1 body text here, long enough to be a real section.

## Step 2 — Check OTP

Untouched step 2 body text, should not change at all.
`;

  it("thay đúng THÂN của một mục ##, mục khác nguyên vẹn", () => {
    const { md, replaced } = replaceChunkSection(kbMd, "Step 1 — Invalid ID", "New rewritten step 1 body.");
    expect(replaced).toBe(true);
    expect(md).toContain("New rewritten step 1 body.");
    expect(md).not.toContain("Old step 1 body text here");
    expect(md).toContain("Untouched step 2 body text"); // mục khác không bị đụng
    expect(md).toContain("## Step 1 — Invalid ID"); // tiêu đề giữ nguyên
  });

  it("heading dạng ghép 'h2 › h3' -> khớp theo phần sau dấu ›", () => {
    const { replaced } = replaceChunkSection(kbMd, "Login help › Step 2 — Check OTP", "New step 2.");
    expect(replaced).toBe(true);
  });

  it("heading không tồn tại -> replaced=false, markdown giữ nguyên", () => {
    const { md, replaced } = replaceChunkSection(kbMd, "Không tồn tại", "x");
    expect(replaced).toBe(false);
    expect(md).toBe(kbMd);
  });
});

describe("Xung đột đã publish (kb_conflicts) — chốt lúc Publish, không phải mỗi lần lưu nháp", () => {
  let w: World;
  let lastReview: { a: string; b: string } | null = null;
  const PHRASE = "zzqtest unique overlap phrase for narrow mechanism";
  beforeAll(async () => {
    w = await makeWorld({
      adminIds: [9001, 9002],
      ownerId: 9001,
      llm: fakeLlm({
        reviewOverlap: async (req) => {
          lastReview = { a: req.a.id, b: req.b.id };
          return { verdict: "subset", reason: "A là chốt chuyển nhân viên, B đã hướng dẫn từng bước rồi", suggestion: `Bỏ "${PHRASE}" khỏi một trong hai template` };
        },
      }),
    });
    // A publish trước, chưa có gì để xung đột
    const a = await w.kbService.createDraft({ slug: "test-conflict-doc-a", kind: "templates", md: tpl("test-conflict-a", PHRASE, "zzqtest-filler-a-only"), author: admin });
    expect(await w.kbService.publish(a.version.id, admin)).toBe("published");
  });
  afterAll(() => w.close());

  it("publish template B trùng cụm với A -> ghi xung đột kèm AI mô tả và cụm gỡ được máy móc", async () => {
    expect((await w.kb.listConflicts("test-conflict-doc-a")).length).toBe(0); // trước khi B tồn tại: chưa có gì

    const b = await w.kbService.createDraft({ slug: "test-conflict-doc-b", kind: "templates", md: tpl("test-conflict-b", PHRASE, "zzqtest-filler-b-only"), author: admin });
    expect(await w.kbService.publish(b.version.id, admin)).toBe("published");

    const ownB = await w.kb.listConflicts("test-conflict-doc-b");
    expect(ownB.length).toBeGreaterThan(0);
    const pair = ownB.find((c) => [c.a.id, c.b.id].includes("test-conflict-a") && [c.a.id, c.b.id].includes("test-conflict-b"));
    expect(pair, "phải bắt được chồng lấn giữa A và B qua cụm dùng chung").toBeTruthy();
    expect(pair!.verdict).toBe("subset"); // AI đã được gọi và ghi lại
    expect(pair!.reason).toContain("chốt chuyển nhân viên");
    expect(pair!.suggestion).toContain(PHRASE);
    expect(pair!.narrow).toBeTruthy();
    expect([pair!.narrow!.templateId]).toEqual(expect.arrayContaining([expect.stringMatching(/^test-conflict-[ab]$/)]));
    expect(pair!.narrow!.phrase).toBe(PHRASE);
    expect(lastReview).toBeTruthy(); // SKILL review-overlap thật sự được gọi, không phải chỉ code

    // Danh sách Tài liệu: cả hai bên đều thấy dấu hiệu xung đột
    const counts = await w.kb.listOpenConflictCounts();
    expect(counts.get("test-conflict-doc-a")?.count).toBeGreaterThan(0);
    expect(counts.get("test-conflict-doc-b")?.count).toBeGreaterThan(0);
  });

  it("Áp dụng gỡ máy móc: tạo bản nháp mới đã gỡ đúng cụm, publish lại thì xung đột này biến mất (tự dọn cả hai phía)", async () => {
    const ownB = await w.kb.listConflicts("test-conflict-doc-b");
    const pair = ownB.find((c) => c.narrow)!;
    expect(pair).toBeTruthy();
    const { templateId, phrase } = pair.narrow!;

    const { version, report } = await w.kbService.applyNarrow(templateId, phrase, admin);
    expect(version.source_md).not.toContain(PHRASE);
    expect(report.ok).toBe(true); // bản đã gỡ vẫn qua kiểm tra bình thường
    expect(await w.kbService.publish(version.id, admin)).toBe("published");

    expect(await w.kb.listConflicts("test-conflict-doc-a")).toEqual([]);
    expect(await w.kb.listConflicts("test-conflict-doc-b")).toEqual([]);
    const counts = await w.kb.listOpenConflictCounts();
    expect(counts.get("test-conflict-doc-a")).toBeUndefined();
    expect(counts.get("test-conflict-doc-b")).toBeUndefined();
  });

  it("Xoá tài liệu: xung đột đang mở chạm tới nó cũng hết ở CẢ hai phía", async () => {
    const PHRASE2 = "zzqtest another unique throwaway overlap phrase";
    const c = await w.kbService.createDraft({ slug: "test-throwaway-c", kind: "templates", md: tpl("test-throwaway-c-tpl", PHRASE2, "zzqtest-filler-c-only"), author: admin });
    await w.kbService.publish(c.version.id, admin);
    const d = await w.kbService.createDraft({ slug: "test-throwaway-d", kind: "templates", md: tpl("test-throwaway-d-tpl", PHRASE2, "zzqtest-filler-d-only"), author: admin });
    await w.kbService.publish(d.version.id, admin);
    expect((await w.kb.listConflicts("test-throwaway-c")).length).toBeGreaterThan(0);
    expect((await w.kb.listConflicts("test-throwaway-d")).length).toBeGreaterThan(0);

    await w.kbService.deleteDocument("test-throwaway-c", admin);
    expect(await w.kb.listConflicts("test-throwaway-c")).toEqual([]);
    expect(await w.kb.listConflicts("test-throwaway-d")).toEqual([]); // phía kia cũng hết vì bên duy nhất đối diện đã biến mất
  });

  it("applyNarrow báo lỗi rõ ràng khi cụm không còn (đã bị sửa từ trước hoặc gõ sai)", async () => {
    await expect(w.kbService.applyNarrow("test-conflict-a", "cụm-không-tồn-tại-nữa", admin)).rejects.toThrow(/không còn thấy/);
  });

  it("applyNarrow báo lỗi rõ ràng khi template không tồn tại/không còn publish", async () => {
    await expect(w.kbService.applyNarrow("khong-ton-tai-xyz", PHRASE, admin)).rejects.toThrow(/không tìm thấy template/);
  });
});
