import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileItems, itemsDocToYaml, parseItemsDoc } from "../src/core/items";
import { chunkKey, itemKey, orderPair, templateHash, textHash } from "../src/kb/pair-decisions";
import type { Actor } from "../src/kb/service";
import { ESCALATE_TEMPLATE_ID } from "../src/domain/types";
import { fakeLlm, makeWorld, type World } from "./helpers";

const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };

const LOGIN = `topic: account
title: Tài khoản
items:
  - id: forgot-login-id
    title: Quên Login ID
    questions: [I forgot my login ID, Cannot remember the ID I log in with, Lost my login ID what now]
    phrases: [forgot login id]
    applies_when: Khách quên ID dùng để đăng nhập
    steps:
      - say: Please tap "Forgot Login ID" and do a face scan.
        next: { negative: next }
      - say: Please record your screen during the face scan.
        next: { negative: handoff, info_provided: handoff }
    handoff: { category: login, error_code: S04, pic: recovery, ask_customer: [face scan video] }
  - id: login-escalate
    title: Chuyển nhân viên đăng nhập
    kind: handoff
    questions: [I need a human for my login, talk to support about login, login problem human please]
`;

describe("mục hỏi đáp: đọc, kiểm tra, dịch sang template", () => {
  it("đọc đúng và dịch nhiều bước thành chuỗi template nối bằng tin nối tiếp", () => {
    const { doc, issues } = parseItemsDoc(LOGIN);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    const t = compileItems(doc!);
    expect(t.map((x) => x.id)).toEqual(["forgot-login-id", "forgot-login-id--b2", "login-escalate"]);
    const [s1, s2, esc] = t as [(typeof t)[0], (typeof t)[0], (typeof t)[0]];
    expect(s1.priority).toBe(500);
    expect(s1.match.examples).toHaveLength(3);
    expect(s1.follow_up).toEqual({ negative: "forgot-login-id--b2" });
    expect(s2.match.keywords).toEqual([]); // bước sau không tìm được bằng câu hỏi
    expect(s2.follow_up).toEqual({ negative: "ESCALATE", info_provided: "ESCALATE" });
    expect(s2.ticket).toEqual({ category: "login", error_code: "S04", pic: "recovery" });
    expect(s2.item).toMatchObject({ id: "forgot-login-id", step: 1, steps: 2 });
    expect(esc.answer_from).toBe(ESCALATE_TEMPLATE_ID);
  });

  it("ghi ra YAML rồi đọc lại không mất nội dung", () => {
    const { doc } = parseItemsDoc(LOGIN);
    const again = parseItemsDoc(itemsDocToYaml(doc!));
    expect(again.doc).toEqual(doc);
  });

  it("chặn: cụm một từ, trùng cụm, 'bước kế' ở bước cuối, id có '--', thiếu câu hỏi lại khách", () => {
    const { issues } = parseItemsDoc(`topic: account
items:
  - id: a--b
    title: A
    questions: [q one here, q two here, q three here]
    phrases: [ambassador, shared phrase]
    steps: [{ say: Hi, next: { negative: next } }]
    distinct_from: [{ item: b, difference: khác }]
  - id: b
    title: B
    questions: [only one question]
    phrases: [shared phrase]
    steps: [{ say: Hello }]
`);
    const errs = issues.filter((i) => i.level === "error").map((i) => i.message).join("\n");
    expect(errs).toMatch(/"ambassador" chỉ có một từ/);
    expect(errs).toMatch(/"shared phrase" trùng/);
    expect(errs).toMatch(/bước cuối/);
    expect(errs).toMatch(/không có "--"/);
    expect(errs).toMatch(/thiếu câu hỏi lại khách/);
    expect(issues.some((i) => i.level === "warning" && /mới có 1 cách hỏi/.test(i.message))).toBe(true);
  });

  it("quyết định cặp: không phụ thuộc thứ tự, hết hiệu lực khi nội dung đổi", () => {
    const t = compileItems(parseItemsDoc(LOGIN).doc!)[0]!;
    const a = { key: itemKey(t.id), hash: templateHash(t) };
    const b = { key: chunkKey("doc", "H"), hash: textHash("x") };
    expect(orderPair(a, b)).toEqual(orderPair(b, a));
    expect(templateHash({ ...t, answers: { en: "changed" } })).not.toBe(a.hash);
  });
});

describe("luật chặn publish của mục hỏi đáp (KbService)", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld({ adminIds: [9001, 9002], ownerId: 9001, llm: fakeLlm() });
  });
  afterAll(async () => w.close());

  const pizza = (distinct: boolean) => `topic: general
items:
  - id: pizza-oven-temp
    title: Nhiệt độ lò pizza
    questions: [what is the pizza oven temperature, how hot should the pizza oven be, pizza oven heat setting]
    phrases: [pizza oven temperature]
    steps: [{ say: Set it to 250 degrees. }]
${distinct ? "    distinct_from: [{ item: pizza-oven-clean, difference: Một bên hỏi nhiệt độ, một bên hỏi vệ sinh, clarify: Do you want the temperature or how to clean the oven? }]\n" : ""}  - id: pizza-oven-clean
    title: Vệ sinh lò pizza
    questions: [how to clean the pizza oven temperature sensor, wash the pizza oven, pizza oven cleaning steps]
    steps: [{ say: Let it cool and brush it. }]
`;
  const step3 = (r: { steps: { name: string; status: string; details: string[] }[] }) => r.steps.find((s) => s.name.startsWith("3."))!;

  it("hai mục tương tự bị bot trả lời nhầm, chưa khai báo 'khác với' → chặn; khai báo rồi → hết chặn", async () => {
    const bad = await w.kbService.createDraft({ slug: "test-items-pizza", kind: "items", md: pizza(false), author: admin });
    expect(step3(bad.report).status).toBe("error");
    expect(step3(bad.report).details.join("\n")).toMatch(/khai báo "khác với"/);
    expect(bad.report.ok).toBe(false);

    const good = await w.kbService.updateDraft(bad.version.id, pizza(true));
    expect(step3(good).details.join("\n")).not.toMatch(/khai báo "khác với"/);
  });

  it("'khác với' trỏ tới mục không tồn tại → chặn", async () => {
    const md = pizza(true).replace("item: pizza-oven-clean", "item: no-such-item");
    const { report } = await w.kbService.createDraft({ slug: "test-items-missing", kind: "items", md, author: admin });
    expect(step3(report).details.join("\n")).toMatch(/không có mục nào mã này/);
  });

  it("mục giành mất đoạn tài liệu → chặn cho tới khi có quyết định còn hiệu lực", async () => {
    const kmd = "---\nslug: test-items-kdoc\ntitle: Oven guide\nresponse_mode: GROUNDED_GENERATION\n---\n# Oven guide\n\n## Pizza oven temperature\n\nThe pizza oven temperature depends on the dough and the stone used for baking.\n";
    const k = await w.kbService.createDraft({ slug: "test-items-kdoc", kind: "knowledge", md: kmd, author: admin });
    await w.kbService.publish(k.version.id, admin);

    const imd = `topic: general
items:
  - id: oven-heat
    title: Nhiệt lò
    questions: [how hot is the oven, oven heat level please, what heat for baking]
    phrases: [pizza oven temperature]
    steps: [{ say: 250 degrees. }]
`;
    const d = await w.kbService.createDraft({ slug: "test-items-hijack", kind: "items", md: imd, author: admin });
    const msg = step3(d.report).details.join("\n");
    expect(msg).toMatch(/ghi nhận quyết định giữ nguyên/);

    const tpl = compileItems(parseItemsDoc(imd).doc!)[0]!;
    const chunk = (await w.kb.listPublishedChunks()).find((c) => c.docSlug === "test-items-kdoc")!;
    const p = orderPair({ key: itemKey(tpl.id), hash: templateHash(tpl) }, { key: chunkKey("test-items-kdoc", chunk.heading), hash: textHash(chunk.text) });
    await w.kb.savePairDecision({ ...p, decision: "keep_both", note: "test", decidedBy: admin.label });
    const again = await w.kbService.revalidate(d.version.id);
    expect(step3(again).details.join("\n")).not.toMatch(/ghi nhận quyết định giữ nguyên/);
  });
});
