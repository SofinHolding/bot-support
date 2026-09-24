import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileItems, parseItemsDoc } from "../src/core/items";
import { TemplateIndex } from "../src/core/template-index";
import { contentParts, diffParts } from "../src/kb/content-history";
import type { Actor } from "../src/kb/service";
import { fakeLlm, makeWorld, type World } from "./helpers";

const doc = (answer: string, extra = "") => `topic: account
items:
  - id: reset-pin
    title: Đặt lại PIN
    questions: [how do I reset my pin, forgot my pin code, change my pin please]
    steps: [{ say: ${answer} }]
${extra}`;
const parts = (md: string) => contentParts({ slug: "items-account", templates: compileItems(parseItemsDoc(md).doc!), chunks: [] });

describe("lịch sử theo từng phần", () => {
  it("lần đầu (V1): mọi phần là khởi tạo", () => {
    const d = diffParts(undefined, parts(doc("Tap Reset.")));
    expect(d.every((x) => x.change === "created")).toBe(true);
    expect(d.map((x) => x.part)).toEqual(expect.arrayContaining(["Tên", "Cách khách hỏi", "Trả lời"]));
  });

  it("chỉ phần bị sửa có thay đổi, kèm trước/sau; phần không đổi không có dòng nào", () => {
    const d = diffParts(parts(doc("Tap Reset.")), parts(doc("Open Settings and tap Reset PIN.")));
    expect(d).toEqual([{ unitKey: "item:reset-pin", unitTitle: "Đặt lại PIN", part: "Trả lời", change: "updated", before: "Tap Reset.", after: "Open Settings and tap Reset PIN." }]);
  });

  it("nội dung bị bỏ: mọi phần của nó ghi là bỏ", () => {
    const d = diffParts(parts(doc("A answer.")), new Map());
    expect(d.length).toBeGreaterThan(0);
    expect(d.every((x) => x.change === "removed" && x.after === null)).toBe(true);
  });
});

describe("thời gian hiệu lực", () => {
  it("mục ngoài thời gian hiệu lực không được đưa làm ứng viên; ngày sai dạng bị chặn", () => {
    const expired = compileItems(parseItemsDoc(doc("Old answer.", "    valid_until: 2020-01-31\n")).doc!)[0]!;
    expect(expired.valid).toEqual({ until: "2020-01-31" });
    expect(TemplateIndex.isActive(expired, new Date("2026-09-24T00:00:00Z"))).toBe(false);
    expect(TemplateIndex.isActive(expired, new Date("2020-01-31T12:00:00Z"))).toBe(true);
    const bad = parseItemsDoc(doc("x", "    valid_from: 31/01/2020\n"));
    expect(bad.issues.some((i) => i.level === "error" && /YYYY-MM-DD/.test(i.message))).toBe(true);
  });
});

describe("ghi lịch sử khi publish (KbService)", () => {
  let w: World;
  const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };
  beforeAll(async () => {
    w = await makeWorld({ adminIds: [9001, 9002], ownerId: 9001, llm: fakeLlm() });
  });
  afterAll(() => w.close());

  it("publish lần 1 ghi khởi tạo; publish lần 2 chỉ ghi phần đổi; mốc của phần không đổi giữ nguyên", async () => {
    const v1 = await w.kbService.createDraft({ slug: "items-account", kind: "items", md: doc("Tap Reset."), author: admin });
    await w.kbService.publish(v1.version.id, admin);
    const h1 = await w.kbService.unitHistory("item:reset-pin");
    expect(h1.parts.every((p) => p.change === "created" && p.version === 1)).toBe(true);

    w.clock.advance(86_400_000);
    const v2 = await w.kbService.createDraft({ slug: "items-account", kind: "items", md: doc("Open Settings and tap Reset PIN."), author: admin });
    await w.kbService.publish(v2.version.id, admin);
    const h2 = await w.kbService.unitHistory("item:reset-pin");
    const answer = h2.parts.find((p) => p.part === "Trả lời")!;
    const questions = h2.parts.find((p) => p.part === "Cách khách hỏi")!;
    expect(answer).toMatchObject({ change: "updated", version: 2 });
    expect(questions).toMatchObject({ change: "created", version: 1 });
    expect(new Date(answer.since).getTime()).toBeGreaterThan(new Date(questions.since).getTime());
    expect(h2.changes.find((c) => c.change === "updated")).toMatchObject({ before: "Tap Reset.", after: "Open Settings and tap Reset PIN." });
  });

  it("dữ liệu đang chạy chưa có lịch sử được ghi mốc khởi tạo một lần", async () => {
    const n1 = await w.kbService.ensureHistoryBaseline();
    expect(n1).toBeGreaterThan(0); // các tài liệu seed
    expect(await w.kbService.ensureHistoryBaseline()).toBe(0); // chạy lại không ghi trùng
  });
  it("xác nhận thay thế: ghi quan hệ có chiều, bản nháp bỏ nội dung cũ, bản đang chạy chưa đổi", async () => {
    const kmd = `---
slug: listing-doc
title: Listing
response_mode: GROUNDED_GENERATION
---
# Listing

## Listing plan

The token will be listed toward the end of 2025 or early 2026.

## Vesting

Vesting is linear over up to 180 months for large holders.
`;
    const k = await w.kbService.createDraft({ slug: "listing-doc", kind: "knowledge", md: kmd, author: admin });
    await w.kbService.publish(k.version.id, admin);
    const r = await w.kbService.supersede({ newKey: "item:reset-pin", oldKey: "chunk:listing-doc#Listing plan" }, admin);
    const units = await w.kbService.versionUnits(r.version, "knowledge");
    expect(units.find((u) => u.title === "Listing plan")?.change).toBe("removed");
    expect(units.find((u) => u.title === "Vesting")?.change).toBe("same");
    const d = (await w.kb.listPairDecisions()).find((x) => x.decision === "supersedes")!;
    expect(d).toMatchObject({ winnerKey: "item:reset-pin" });
    expect((await w.kb.listPublishedChunks()).some((c) => c.heading === "Listing plan")).toBe(true); // chưa publish: bot vẫn dùng bản cũ
  });
});
