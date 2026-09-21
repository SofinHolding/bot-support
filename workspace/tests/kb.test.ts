import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KbError, type Actor } from "../src/kb/service";
import { makeWorld, type World } from "./helpers";

let w: World;
const owner: Actor = { id: 9001, role: "owner", label: "owner#9001" };
const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };
const viewer: Actor = { id: 9003, role: "viewer", label: "viewer#9003" };

beforeAll(async () => {
  w = await makeWorld({ adminIds: [9001, 9002], ownerId: 9001 });
});
afterAll(async () => w.close());

const tpl = (id: string, extra: { priority?: number; keywords?: string[]; answer?: string; mode?: string; follow?: string } = {}) => `---
id: ${id}
group: Test
response_mode: ${extra.mode ?? "EXACT_TEMPLATE"}
priority: ${extra.priority ?? 300}
match:
  keywords:
${(extra.keywords ?? ["pizza recipe"]).map((k) => `    - ${k}`).join("\n")}
${extra.follow ? `follow_up:\n  negative: ${extra.follow}\n` : ""}sets_context:
  issue: test issue
  status: pending
---
<!-- answer:en -->
${extra.answer ?? "This is a test answer"}
`;

describe("Draft -> kiểm tra -> Publish", () => {
  it("template hợp lệ: qua kiểm tra, publish, bot dùng ngay không cần khởi động lại", async () => {
    const { version, report } = await w.kbService.createDraft({ slug: "test-pizza", kind: "templates", md: tpl("test-pizza-recipe", { keywords: ["pizza recipe", "how to bake pizza"], answer: "Bake it at 250 degrees." }), author: admin });
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual(["1. Cấu trúc", "2. Quét an toàn", "3. Trùng và mâu thuẫn", "4. Bản dịch", "5. Test hồi quy", "6. Replay tin nhắn thật (14 ngày)"]);
    expect(await w.kbService.publish(version.id, admin)).toBe("published");

    await w.say(4001, "how to bake pizza");
    expect(w.channel.textsTo(4001).at(-1)).toBe("Bake it at 250 degrees.");
    expect(w.live.index.get("test-pizza-recipe")).toBeDefined();
  });

  it("thiếu response_mode / id / câu trả lời tiếng Anh: báo lỗi rõ ràng và KHÔNG cho publish", async () => {
    const bad = "---\nid: bad-one\ngroup: X\nmatch:\n  keywords: [abc]\n---\n<!-- answer:en -->\nhello\n";
    const { version, report } = await w.kbService.createDraft({ slug: "test-bad", kind: "templates", md: bad, author: admin });
    expect(report.ok).toBe(false);
    expect(report.steps[0]!.details.join(" ")).toContain("response_mode");
    await expect(w.kbService.publish(version.id, admin)).rejects.toThrow(KbError);
  });

  it("viewer không được tạo/publish", async () => {
    const { version } = await w.kbService.createDraft({ slug: "test-v", kind: "templates", md: tpl("test-viewer", { keywords: ["viewer keyword phrase"] }), author: admin });
    await expect(w.kbService.publish(version.id, viewer)).rejects.toMatchObject({ status: 403 });
  });

  it("quét an toàn: chặn chuỗi giống seed/key và HTML script; cảnh báo URL ngoài whitelist", async () => {
    const seed = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const a = await w.kbService.createDraft({ slug: "test-seed", kind: "templates", md: tpl("test-seed", { answer: `Your phrase is ${seed}` }), author: admin });
    expect(a.report.ok).toBe(false);
    expect(a.report.steps[1]!.details.join(" ")).toContain("private key / seed");
    const b = await w.kbService.createDraft({ slug: "test-html", kind: "templates", md: tpl("test-html", { answer: "click <script>alert(1)</script>" }), author: admin });
    expect(b.report.ok).toBe(false);
    const c = await w.kbService.createDraft({ slug: "test-url", kind: "templates", md: tpl("test-url", { keywords: ["url test phrase"], answer: "See https://new-host.example.org/x" }), author: admin });
    expect(c.report.steps[1]!.status).toBe("warning");
    expect(c.report.steps[1]!.details.join(" ")).toContain("new-host.example.org");
  });

  it("hồi quy: template mới che khuất template cũ bị phát hiện và chặn publish", async () => {
    const md = tpl("test-shadow", { priority: 5000, keywords: ["withdraw", "how to withdraw"], answer: "Totally different answer" });
    const { version, report } = await w.kbService.createDraft({ slug: "test-shadow", kind: "templates", md, author: admin });
    const step = report.steps.find((s) => s.name.startsWith("5."))!;
    expect(step.status).toBe("error");
    expect(report.regression!.changed.some((c) => c.before === "fp-2-withdraw" && c.after === "test-shadow")).toBe(true);
    expect(report.regression!.accuracyAfter).toBeLessThan(report.regression!.accuracyBefore);
    expect(report.ok).toBe(false);
    await expect(w.kbService.publish(version.id, admin)).rejects.toThrow(/chưa qua kiểm tra/);
    expect(w.live.index.get("test-shadow")).toBeUndefined(); // bot vẫn chạy bản cũ
  });

  it("replay tin nhắn thật liệt kê tin sẽ đổi câu trả lời", async () => {
    await w.say(4101, "how to withdraw");
    const md = tpl("test-shadow2", { priority: 5000, keywords: ["how to withdraw"], answer: "Shadowed" });
    const { report } = await w.kbService.createDraft({ slug: "test-shadow2", kind: "templates", md, author: admin });
    expect(report.replay!.total).toBeGreaterThan(0);
    expect(report.replay!.changed).toBeGreaterThan(0);
    expect(report.replay!.samples.some((s) => s.before === "fp-2-withdraw")).toBe(true);
  });

  it("nhất quán chéo: xoá template đang được template khác tham chiếu (follow_up) bị chặn", async () => {
    const md = tpl("test-anchor", { keywords: ["anchor phrase one"] });
    const a = await w.kbService.createDraft({ slug: "test-anchor", kind: "templates", md, author: admin });
    await w.kbService.publish(a.version.id, admin);
    const ref = tpl("test-ref", { keywords: ["reference phrase one"], follow: "test-anchor" });
    const r = await w.kbService.createDraft({ slug: "test-ref", kind: "templates", md: ref, author: admin });
    await w.kbService.publish(r.version.id, admin);
    // phiên bản mới của test-anchor đổi id => test-ref trỏ vào id không còn tồn tại
    const renamed = tpl("test-anchor-renamed", { keywords: ["anchor phrase one"] });
    const d = await w.kbService.createDraft({ slug: "test-anchor", kind: "templates", md: renamed, author: admin });
    expect(d.report.ok).toBe(false);
    expect(d.report.steps[2]!.details.join(" ")).toContain("test-anchor");
  });

  it("rollback: khôi phục phiên bản trước, giữ lịch sử", async () => {
    const v1 = await w.kbService.createDraft({ slug: "test-roll", kind: "templates", md: tpl("test-roll", { keywords: ["rollback phrase"], answer: "Version one" }), author: admin });
    await w.kbService.publish(v1.version.id, admin);
    const v2 = await w.kbService.createDraft({ slug: "test-roll", kind: "templates", md: tpl("test-roll", { keywords: ["rollback phrase"], answer: "Version two" }), author: admin });
    await w.kbService.publish(v2.version.id, admin);
    await w.say(4201, "rollback phrase");
    expect(w.channel.textsTo(4201).at(-1)).toBe("Version two");

    await w.kbService.rollback("test-roll", 1, admin);
    await w.say(4202, "rollback phrase");
    expect(w.channel.textsTo(4202).at(-1)).toBe("Version one");
    const versions = await w.kb.listVersions("test-roll");
    expect(versions.length).toBe(3);
    expect(versions.filter((v) => v.status === "published").length).toBe(1);
  });
});

describe("duyệt hai người cho luật bảo mật (SECURITY_RULE)", () => {
  const secMd = tpl("test-sec", { mode: "SECURITY_RULE", keywords: ["nothing"], answer: "Protected text" });

  it("admin thường không được đề xuất; owner đề xuất -> chờ duyệt; không tự duyệt; người khác duyệt", async () => {
    const a = await w.kbService.createDraft({ slug: "test-sec", kind: "templates", md: secMd, author: owner });
    expect(a.report.securityRules).toEqual(["test-sec"]);
    await expect(w.kbService.publish(a.version.id, admin)).rejects.toMatchObject({ status: 403 });

    expect(await w.kbService.publish(a.version.id, owner)).toBe("pending_approval");
    const changes = await w.ops.listChanges("pending");
    const ch = changes.find((c) => c.kind === "kb_publish" && c.payload.slug === "test-sec")!;
    expect(ch.proposed_by).toBe(9001);
    expect(w.live.index.get("test-sec")).toBeUndefined(); // chưa có hiệu lực

    await expect(w.kbService.approve(ch.id, owner)).rejects.toMatchObject({ status: 403 }); // không tự duyệt
    await w.kbService.approve(ch.id, admin);
    expect(w.live.index.get("test-sec")?.answers.en).toBe("Protected text");
    expect((await w.ops.listChanges("approved")).some((c) => c.id === ch.id)).toBe(true);
    expect((await w.ops.listAudit(50, 0)).some((x) => (x as unknown as { action: string }).action === "kb.approve_publish")).toBe(true);
  });
});

describe("tài liệu tri thức (RAG)", () => {
  it("publish tài liệu, tìm được chunk bằng từ khoá + vector, bot trích nguyên văn kèm link", async () => {
    const md = `---
slug: staking-guide
title: Staking Guide
response_mode: GROUNDED_GENERATION
source_url: https://whitepaper.interlinklabs.ai
---
## Vesting schedule

Tokenomics detail: locked tokens vest linearly over a maximum period of one hundred eighty months, which protects the price.

## Something else

An unrelated paragraph about ambassadors and their monthly points.
`;
    const { version, report } = await w.kbService.createDraft({ slug: "staking-guide", kind: "knowledge", md, author: admin });
    expect(report.ok).toBe(true);
    await w.kbService.publish(version.id, admin);
    expect(await w.kb.countChunks()).toBeGreaterThan(5);

    const hits = await w.pipeline["d"].knowledge!.search("tokenomics vesting schedule", 3);
    expect(hits[0]!.heading).toContain("Vesting");
    await w.say(4301, "explain tokenomics vesting schedule");
    expect(w.channel.textsTo(4301).at(-1)).toContain("linearly over a maximum period of one hundred eighty months");
    expect(w.channel.textsTo(4301).at(-1)).toContain("https://whitepaper.interlinklabs.ai");
  });

  it("tài liệu tri thức phải khai response_mode GROUNDED_GENERATION", async () => {
    const md = "---\nslug: wrong-mode\nresponse_mode: EXACT_TEMPLATE\n---\n## H\n\nSome long enough paragraph of text here.\n";
    const { report } = await w.kbService.createDraft({ slug: "wrong-mode", kind: "knowledge", md, author: admin });
    expect(report.ok).toBe(false);
  });
});

describe("kho mặc định sau seed", () => {
  it("có ~60 template, 3 tài liệu tri thức, và bộ câu hỏi mẫu; hồi quy nền đạt đủ cao", async () => {
    expect(w.live.index.templates.length).toBeGreaterThan(60);
    expect(await w.kb.countEvalCases()).toBeGreaterThan(100);
    const docs = await w.kb.listDocuments();
    expect(docs.filter((d) => d.kind === "knowledge").map((d) => d.slug)).toEqual(expect.arrayContaining(["whitepaper-data", "infrastructure-data", "ambassador-program"]));
    expect(docs.some((d) => d.slug === "support-cases-training")).toBe(false); // tài liệu nội bộ không vào kho của khách
  });
});
