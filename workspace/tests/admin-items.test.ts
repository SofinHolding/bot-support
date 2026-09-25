import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAdminServer } from "../src/admin/server";
import { createServices, type Services } from "../src/app";
import { loadConfig } from "../src/config";
import { parseItemsDoc, type KnowledgeItem } from "../src/core/items";
import type { IntakeDraftRequest, IntakeDraftResult } from "../src/core/ports";
import type { Actor } from "../src/kb/service";
import { FakeChannel, fakeLlm } from "./helpers";

let svc: Services;
let app: FastifyInstance;
let channel: FakeChannel;
const media = mkdtempSync(join(tmpdir(), "admin-items-media-"));
const clock = { now: new Date("2026-09-21T03:00:00Z") };
let ipSeq = 1;
const ip = () => `10.1.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`; // mỗi lần đăng nhập một IP để không dính giới hạn theo IP
const ADMIN: Actor = { id: 9002, role: "admin", label: "test-admin" };

/** AI tách nội dung (SKILL intake-draft) giả: mỗi test đặt kết quả cần trả; ghi lại các yêu cầu đã nhận. */
let nextDraft: (r: IntakeDraftRequest) => IntakeDraftResult = () => {
  throw new Error("test chưa đặt kết quả AI");
};
const intakeCalls: IntakeDraftRequest[] = [];
/** AI so hai nội dung (SKILL review-overlap) giả: mặc định "khác phạm vi" */
let nextReview: () => Promise<{ verdict: string; reason?: string }> = async () => ({ verdict: "distinct" });
let reviewCalls = 0;
const answerDraft = (t: { id: string; group: string; keywords: string[]; examples: string[]; answer_en: string }, title = ""): IntakeDraftResult => ({ kind: "templates", slug: "ai-slug-ignored", title, templates: [t], knowledge: null });

const H = { "x-requested-with": "admin-web", "content-type": "application/json" };
type Res = { statusCode: number; json: () => any; body: string; headers: Record<string, unknown> };

beforeAll(async () => {
  const cfg = loadConfig({ DATABASE_URL: "pglite:memory", ADMIN_TELEGRAM_IDS: "9001,9002", OWNER_TELEGRAM_ID: "9001", SECRETS_KEY: "test-secrets-key-0123456789-abcdefghij", MEDIA_DIR: media, CONTENT_DIR: "content", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  svc = await createServices(cfg, "admin");
  channel = new FakeChannel();
  (svc as { channel: unknown }).channel = channel;
  (svc as { llm: unknown }).llm = fakeLlm({
    draftIntake: async (r) => {
      intakeCalls.push(r);
      return nextDraft(r);
    },
    reviewOverlap: async () => {
      reviewCalls++;
      return (await nextReview()) as never;
    },
  });
  await svc.ops.upsertAdmin(9003, "viewer", null);
  await svc.ops.setSetting("router.mode", "hybrid", "test");
  svc.settings.invalidate();
  app = await buildAdminServer(svc, { now: () => clock.now, webDir: "src/admin/web" });
});
afterAll(async () => {
  await app.close();
  await svc.close();
  rmSync(media, { recursive: true, force: true });
});

async function login(id: number): Promise<string> {
  const n = channel.sent.length;
  const r1 = (await app.inject({ method: "POST", url: "/api/auth/request-code", headers: H, remoteAddress: ip(), payload: { telegramId: id } })) as Res;
  expect(r1.statusCode).toBe(200);
  const msg = channel.sent.slice(n).find((s) => s.chatId === id);
  const code = /\b(\d{6})\b/.exec(msg?.text ?? "")?.[1];
  expect(code, "mã đăng nhập phải được gửi qua Telegram của admin").toBeDefined();
  const r2 = (await app.inject({ method: "POST", url: "/api/auth/verify", headers: H, remoteAddress: ip(), payload: { telegramId: id, code } })) as Res & { cookies: { name: string; value: string; httpOnly?: boolean; sameSite?: string }[] };
  expect(r2.statusCode).toBe(200);
  const sid = r2.cookies.find((c) => c.name === "sid")!;
  expect(sid.httpOnly).toBe(true);
  expect(String(sid.sameSite).toLowerCase()).toBe("strict");
  return `sid=${sid.value}`;
}
const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } }) as Promise<Res>;
const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, cookie: string, payload?: unknown) => app.inject({ method, url, headers: { ...H, cookie }, payload: payload as never }) as Promise<Res>;

type Unit = { key: string; kind: string; title: string; questions: string[]; steps: string[]; change: string };
async function versionOf(id: number, cookie: string): Promise<{ version: { slug: string; status: string; source_md: string }; units: Unit[] }> {
  const r = await get(`/api/kb/versions/${id}`, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function itemIn(versionId: number, itemId: string, cookie: string): Promise<KnowledgeItem> {
  const { version } = await versionOf(versionId, cookie);
  const it = parseItemsDoc(version.source_md).doc?.items.find((x) => x.id === itemId);
  expect(it, `mục ${itemId} phải có trong bản nháp`).toBeDefined();
  return it!;
}
/** Tạo + publish một tài liệu tham khảo ngay trong hệ thống (qua web chỉ còn "Thêm nội dung"). */
async function publishKnowledge(slug: string, title: string, sections: [string, string][]) {
  const md = `---\nslug: ${slug}\ntitle: ${title}\nresponse_mode: GROUNDED_GENERATION\n---\n# ${title}\n\n${sections.map(([h, b]) => `## ${h}\n\n${b}\n`).join("\n")}`;
  const d = await svc.kbService.createDraft({ slug, kind: "knowledge", md, author: ADMIN });
  expect(d.report.ok, JSON.stringify(d.report.steps)).toBe(true);
  expect(await svc.kbService.publish(d.version.id, ADMIN)).toBe("published");
}

const PIN = {
  id: "quen-ma-pin-ung-dung",
  group: "Account",
  keywords: ["pin", "app pin code"], // "pin" (một từ) phải bị bỏ: nguyên nhân trả lời nhầm
  examples: ["I forgot my app pin code", "how to reset the app lock pin code", "app pin code forgotten what now"],
  answer_en: "Open Settings and tap Reset app PIN.",
};

describe("Admin Web: Kho tri thức — một danh sách, một cửa thêm nội dung", () => {
  it("/api/kb/content liệt kê câu trả lời đang chạy theo chủ đề, đoạn tài liệu theo tài liệu, và bản nháp đang chờ", async () => {
    const admin = await login(9002);
    const c = (await get("/api/kb/content", admin)).json();
    expect(typeof c.kbVersion).not.toBe("undefined");
    expect(c.pending).toEqual([]);
    expect(c.topics.length).toBeGreaterThan(0);
    const answers = c.topics.flatMap((t: { answers: unknown[] }) => t.answers);
    const login1 = answers.find((a: { id: string }) => a.id === "how-to-login");
    expect(login1).toMatchObject({ key: "item:how-to-login", converted: false, docSlug: expect.any(String) });
    expect(login1.steps.length).toBeGreaterThan(0);
    expect(c.topics.find((t: { answers: { id: string }[] }) => t.answers.some((a) => a.id === "how-to-login")).topic).toBe("account");
    const amb = c.documents.find((d: { slug: string }) => d.slug === "ambassador-program");
    expect(amb.sections.length).toBeGreaterThan(0);
    for (const s of amb.sections) expect(s.key).toBe(`chunk:ambassador-program#${s.heading}`);
    // viewer cũng xem được danh sách
    expect((await get("/api/kb/content", await login(9003))).statusCode).toBe(200);
  });

  it("thêm nội dung: AI tách câu trả lời -> mục hỏi đáp trong bản nháp đúng chủ đề (bỏ từ khoá một từ); publish xong bot dùng ngay", async () => {
    const admin = await login(9002);
    nextDraft = () => answerDraft(PIN, "Quên mã PIN ứng dụng");
    const n = intakeCalls.length;
    const r = await send("POST", "/api/kb/intake", admin, { rawText: "Khách quên mã PIN mở ứng dụng: vào Cài đặt, bấm Đặt lại mã PIN." });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(intakeCalls.slice(n)).toHaveLength(1);
    expect(intakeCalls[n]!.kindHint).toBeUndefined(); // người dùng không chọn loại nội dung
    expect(body.version.slug).toBe("items-account"); // nhóm "Account" -> chủ đề account
    expect(body.drafts).toEqual([{ versionId: body.version.id, slug: "items-account", ok: true }]);
    expect(body.report.ok).toBe(true);

    const it = await itemIn(body.version.id, "quen-ma-pin-ung-dung", admin);
    expect(it.title).toBe("Quên mã PIN ứng dụng");
    expect(it.kind).toBe("answer");
    expect(it.phrases).toEqual(["app pin code"]);
    expect(it.questions).toEqual([...PIN.examples, "app pin code"]);
    expect(it.questions).not.toContain("pin");
    expect(it.steps[0]!.say).toEqual({ en: "Open Settings and tap Reset app PIN." });

    const { units } = await versionOf(body.version.id, admin);
    expect(units).toEqual([expect.objectContaining({ key: "item:quen-ma-pin-ung-dung", title: "Quên mã PIN ứng dụng", change: "new", steps: ["Open Settings and tap Reset app PIN."] })]);
    const pending = (await get("/api/kb/content", admin)).json().pending;
    expect(pending).toEqual([expect.objectContaining({ slug: "items-account", versionId: body.version.id, status: "draft", ok: true })]);

    const pub = await send("POST", `/api/kb/versions/${body.version.id}/publish`, admin, {});
    expect(pub.json().status).toBe("published");
    const t = (await send("POST", "/api/kb/try", admin, { question: "app pin code" })).json();
    expect(t).toMatchObject({ result: "TEMPLATE", itemId: "quen-ma-pin-ung-dung", title: "Quên mã PIN ứng dụng", answer: "Open Settings and tap Reset app PIN." });
    const c = (await get("/api/kb/content", admin)).json();
    expect(c.pending).toEqual([]);
    const account = c.topics.find((x: { topic: string }) => x.topic === "account");
    expect(account.answers.find((a: { id: string }) => a.id === "quen-ma-pin-ung-dung")).toMatchObject({ converted: true, docSlug: "items-account", steps: ["Open Settings and tap Reset app PIN."] });
  });

  it("sửa câu trả lời (target item:<id>): mã giữ nguyên, câu trả lời thay, cách hỏi gộp thêm; thử trên bản nháp thấy câu mới, bộ đang chạy vẫn câu cũ", async () => {
    const admin = await login(9002);
    // AI xếp nhóm khác, mã khác: vẫn phải sửa đúng mục đang chọn, ở đúng chủ đề của nó
    nextDraft = () => answerDraft({ id: "ma-khac", group: "Wallet", keywords: ["pin code lost again"], examples: ["pin code lost again"], answer_en: "Go to Security and choose Reset PIN." });
    const n = intakeCalls.length;
    const r = await send("POST", "/api/kb/intake", admin, { rawText: "Đổi hướng dẫn: vào mục Bảo mật rồi chọn Đặt lại mã PIN.", target: "item:quen-ma-pin-ung-dung" });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(intakeCalls[n]!.kindHint).toBe("templates");
    expect(body.version.slug).toBe("items-account");
    expect(body.drafts).toHaveLength(1);

    const it = await itemIn(body.version.id, "quen-ma-pin-ung-dung", admin);
    expect(it.steps[0]!.say).toEqual({ en: "Go to Security and choose Reset PIN." });
    expect(it.questions).toEqual([...PIN.examples, "app pin code", "pin code lost again"]);
    expect(it.phrases).toEqual(["app pin code"]);
    const { version, units } = await versionOf(body.version.id, admin);
    expect(parseItemsDoc(version.source_md).doc!.items.map((x) => x.id)).toEqual(["quen-ma-pin-ung-dung"]); // không thêm mục "ma-khac"
    expect(units).toEqual([expect.objectContaining({ key: "item:quen-ma-pin-ung-dung", change: "changed", steps: ["Go to Security and choose Reset PIN."] })]);

    const draft = (await send("POST", "/api/kb/try", admin, { question: "app pin code", versionId: body.version.id })).json();
    expect(draft).toMatchObject({ itemId: "quen-ma-pin-ung-dung", answer: "Go to Security and choose Reset PIN." });
    const live = (await send("POST", "/api/kb/try", admin, { question: "app pin code" })).json();
    expect(live).toMatchObject({ itemId: "quen-ma-pin-ung-dung", answer: "Open Settings and tap Reset app PIN." });
  });

  it("thử hỏi trên bản nháp: mục mới (chưa có vector) vẫn được so theo nghĩa", async () => {
    const admin = await login(9002);
    nextDraft = () => answerDraft({ id: "doi-mang-luoi-vi", group: "Wallet", keywords: [], examples: ["how do I switch the wallet network", "change network in my wallet", "wallet shows the wrong chain network"], answer_en: "Tap the network name and choose another." }, "Đổi mạng lưới ví");
    const r = (await send("POST", "/api/kb/intake", admin, { rawText: "Đổi mạng lưới trong ví: bấm vào tên mạng rồi chọn mạng khác." })).json();
    expect(r.version.slug).toBe("items-wallet");
    const t = (await send("POST", "/api/kb/try", admin, { question: "switch wallet network please", versionId: r.version.id })).json();
    expect([t.itemId, ...t.suggestions.map((s: { id: string }) => s.id)]).toContain("doi-mang-luoi-vi");
  });

  it("sửa đoạn tài liệu (target chunk:<doc>#<heading>): nội dung mới thay đúng đoạn đó, không cần AI tách", async () => {
    const admin = await login(9002);
    await publishKnowledge("garden-guide", "Garden guide", [
      ["Watering schedule", "Water the tomato plants every morning before the sun gets too strong."],
      ["Soil preparation", "Mix compost into the soil two weeks before planting the seedlings."],
    ]);
    const doc = (await get("/api/kb/content", admin)).json().documents.find((d: { slug: string }) => d.slug === "garden-guide");
    const water = doc.sections.find((s: { heading: string }) => /Watering schedule/.test(s.heading));
    expect(water.key).toBe(`chunk:garden-guide#${water.heading}`);

    const n = intakeCalls.length;
    const newText = "Water the tomato plants every evening once the soil has cooled down.";
    const r = await send("POST", "/api/kb/intake", admin, { rawText: newText, target: water.key });
    expect(r.statusCode, r.body).toBe(200);
    expect(intakeCalls.length).toBe(n); // không gọi AI tách cấu trúc
    const body = r.json();
    expect(body.version.slug).toBe("garden-guide");
    expect(body.drafts).toEqual([{ versionId: body.version.id, slug: "garden-guide", ok: body.report.ok }]);

    const { units } = await versionOf(body.version.id, admin);
    const byKey = new Map(units.map((u) => [u.key, u]));
    expect(byKey.get(water.key)).toMatchObject({ kind: "document", change: "changed" });
    expect(byKey.get(water.key)!.steps[0]).toContain("every evening");
    expect([...byKey.values()].find((u) => /Soil preparation/.test(u.title))?.change).toBe("same");
    // bot đang chạy vẫn dùng đoạn cũ cho tới khi publish
    const live = (await get("/api/kb/content", admin)).json().documents.find((d: { slug: string }) => d.slug === "garden-guide");
    expect(live.sections.find((s: { key: string }) => s.key === water.key).text).toContain("every morning");
  });

  it("GET /api/kb/versions/:id: nội dung dễ đọc của phiên bản, đánh dấu mới / thay đổi / giữ nguyên / bị bỏ so với bản đang chạy", async () => {
    const admin = await login(9002);
    await publishKnowledge("units-guide", "Units guide", [
      ["Section kept", "This section stays exactly the same between the two versions."],
      ["Section edited", "This section will be rewritten in the next version of the guide."],
      ["Section dropped", "This section disappears in the next version of the guide."],
    ]);
    const md = "---\nslug: units-guide\ntitle: Units guide\nresponse_mode: GROUNDED_GENERATION\n---\n# Units guide\n\n## Section kept\n\nThis section stays exactly the same between the two versions.\n\n## Section edited\n\nThis section has been rewritten with completely different wording now.\n\n## Section added\n\nThis section is brand new in the second version of the guide.\n";
    const d = await svc.kbService.createDraft({ slug: "units-guide", kind: "knowledge", md, author: ADMIN });
    const { units } = await versionOf(d.version.id, admin);
    const change = (h: string) => units.find((u) => u.title.includes(h))?.change;
    expect(change("Section kept")).toBe("same");
    expect(change("Section edited")).toBe("changed");
    expect(change("Section added")).toBe("new");
    expect(change("Section dropped")).toBe("removed");
    expect(units.every((u) => u.key.startsWith("chunk:units-guide#"))).toBe(true);
    // tài liệu Hướng dẫn AI: không có đơn vị nội dung
    const gv = (await get("/api/kb/documents/agent-guide", admin)).json().versions[0] as { id: number };
    expect((await versionOf(gv.id, admin)).units).toEqual([]);
  });

  it("viewer không thêm/sửa nội dung được; soạn/sửa Markdown thẳng chỉ còn cho Hướng dẫn AI", async () => {
    const viewer = await login(9003);
    nextDraft = () => answerDraft(PIN);
    expect((await send("POST", "/api/kb/intake", viewer, { rawText: "Một nội dung đủ dài để qua kiểm tra độ dài." })).statusCode).toBe(403);
    expect((await send("POST", "/api/kb/intake", viewer, { rawText: "Một nội dung đủ dài để qua kiểm tra độ dài.", target: "item:quen-ma-pin-ung-dung" })).statusCode).toBe(403);

    const admin = await login(9002);
    const kmd = "---\nslug: raw-guide\ntitle: Raw guide\nresponse_mode: GROUNDED_GENERATION\n---\n# Raw guide\n\n## Raw section\n\nSome raw knowledge text that is long enough to be a section.\n";
    for (const [slug, kind, md] of [["raw-guide", "knowledge", kmd], ["raw-tpl", "templates", "---\nid: raw-tpl\ngroup: Test\n---\n<!-- answer:en -->\nhello there\n"], ["items-general", "items", "topic: general\nitems: []\n"]] as const) {
      const r = await send("POST", "/api/kb/documents", admin, { slug, kind, md });
      expect(r.statusCode, `${kind}: ${r.body}`).toBe(403);
      expect(r.json().error).toContain("Thêm nội dung");
    }
    expect((await get("/api/kb/documents/raw-guide", admin)).statusCode).toBe(404);
    // sửa Markdown của bản nháp nội dung tri thức (dù tạo trong hệ thống) cũng bị chặn
    const d = await svc.kbService.createDraft({ slug: "raw-guide", kind: "knowledge", md: kmd, author: ADMIN });
    const put = await send("PUT", `/api/kb/versions/${d.version.id}`, admin, { md: kmd.replace("Some raw", "Other raw") });
    expect(put.statusCode).toBe(403);
    expect((await versionOf(d.version.id, admin)).version.source_md).toBe(kmd);

    // Hướng dẫn AI làm việc: vẫn soạn/sửa thẳng được
    const gmd = readFileSync("content/guide/agent-guide.md", "utf8");
    const g = await send("POST", "/api/kb/documents", admin, { slug: "agent-guide", kind: "guide", md: gmd });
    expect(g.statusCode, g.body).toBe(200);
    expect(g.json().report.ok).toBe(true);
    const gp = await send("PUT", `/api/kb/versions/${g.json().version.id}`, admin, { md: gmd + "\n" });
    expect(gp.statusCode, gp.body).toBe(200);
    expect(gp.json().report.ok).toBe(true);
    // bản nháp Hướng dẫn AI không nằm trong danh sách nội dung chờ xử lý
    expect((await get("/api/kb/content", admin)).json().pending.some((p: { slug: string }) => p.slug === "agent-guide")).toBe(false);
  });

  it("mục giành câu hỏi của đoạn tài liệu: báo cáo có nút xử lý; ghi nhận giữ nguyên thì hết chặn", async () => {
    const admin = await login(9002);
    await publishKnowledge("oven-guide", "Oven guide", [["Pizza oven temperature", "The pizza oven temperature depends on the dough and the stone used for baking."]]);
    nextDraft = () => answerDraft({ id: "nhiet-lo", group: "FAQ", keywords: ["pizza oven temperature"], examples: ["how hot is the oven", "oven heat level please", "what heat for baking"], answer_en: "250 degrees." }, "Nhiệt lò");
    const res = await send("POST", "/api/kb/intake", admin, { rawText: "Nhiệt độ lò nướng pizza: 250 độ." });
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.version.slug).toBe("items-general"); // nhóm "FAQ" -> chủ đề general
    expect(r.report.ok).toBe(false);
    expect(r.report.hijacks?.[0]).toMatchObject({ itemId: "nhiet-lo", heading: "Pizza oven temperature" });
    const d = await send("POST", "/api/kb/decide", admin, { versionId: r.version.id, itemId: "nhiet-lo", chunkId: r.report.hijacks[0].chunkId, note: "cố ý" });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().report.hijacks ?? []).toEqual([]);
    expect((await send("POST", "/api/kb/decide", await login(9003), { versionId: r.version.id, itemId: "nhiet-lo", chunkId: r.report.hijacks[0].chunkId })).statusCode).toBe(403);
  });

  it("thêm nội dung mâu thuẫn với nội dung đang dùng: hiện khung, CHẶN publish tới khi xử lý; AI không kiểm tra được cũng chặn", async () => {
    const admin = await login(9002);
    const G1 = { id: "nhan-thuong-game", group: "Game", keywords: ["claim game reward"], examples: ["how do I claim the game reward", "claim reward in the game", "where to claim game rewards"], answer_en: "Rewards are claimed in the Game tab every Monday." };
    nextDraft = () => answerDraft(G1, "Nhận thưởng game");
    const first = (await send("POST", "/api/kb/intake", admin, { rawText: "Nhận thưởng game ở tab Game mỗi thứ Hai." })).json();
    expect((await send("POST", `/api/kb/versions/${first.version.id}/publish`, admin, {})).json().status).toBe("published");

    // nội dung mới nói khác về cùng việc: AI kết luận mâu thuẫn trực tiếp
    nextReview = async () => ({ verdict: "contradiction", reason: "A nói thứ Sáu tự động, B nói thứ Hai trong tab Game" });
    nextDraft = () => answerDraft({ id: "nhan-thuong-game-moi", group: "Game", keywords: ["claim the game reward now"], examples: ["how can I claim the game reward", "claim the reward in game", "where do I claim game rewards"], answer_en: "Rewards are paid automatically every Friday." }, "Nhận thưởng game (mới)");
    const r = (await send("POST", "/api/kb/intake", admin, { rawText: "Thưởng game được trả tự động mỗi thứ Sáu." })).json();
    const box = r.boxes.find((b: { verdict: string }) => b.verdict === "contradiction");
    expect(box).toMatchObject({ aKey: "item:nhan-thuong-game-moi", bKey: "item:nhan-thuong-game" });
    expect(r.report.ok).toBe(false);
    const blk = r.report.reviewBlocks.find((x: { aKey: string; bKey: string }) => [x.aKey, x.bKey].includes("item:nhan-thuong-game-moi"));
    expect(blk).toMatchObject({ need: "decide", verdict: "contradiction" });
    expect(JSON.stringify(r.report.steps)).toContain("mâu thuẫn trực tiếp");
    const pub = await send("POST", `/api/kb/versions/${r.version.id}/publish`, admin, {});
    expect(pub.statusCode).not.toBe(200); // không publish được khi còn mâu thuẫn chưa xử lý

    // mở lại trang: dùng lại nhận xét đã ghi, không gọi AI lần nữa
    const calls = reviewCalls;
    const again = (await get(`/api/kb/intake/${r.version.id}/boxes`, admin)).json();
    expect(again.boxes.some((b: { verdict: string }) => b.verdict === "contradiction")).toBe(true);
    expect(reviewCalls).toBe(calls);

    // người duyệt xác nhận hai trường hợp khác nhau -> hết chặn vì mâu thuẫn
    const d = await send("POST", "/api/kb/decide", admin, { docSlug: box.a.doc, aKey: box.aKey, bKey: box.bKey, decision: "keep_both", note: "khác đối tượng" });
    expect(d.statusCode, d.body).toBe(200);
    expect((d.json().report.reviewBlocks ?? []).filter((x: { aKey: string; bKey: string }) => [x.aKey, x.bKey].includes("item:nhan-thuong-game-moi"))).toEqual([]);

    // AI không kiểm tra được (lỗi) -> cặp bị chặn, cần kiểm tra lại; kiểm tra lại được thì hết chặn
    nextReview = async () => {
      throw new Error("bad json");
    };
    nextDraft = () => answerDraft({ id: "thuong-game-3", group: "Game", keywords: ["game reward claim help"], examples: ["help me claim the game reward", "game reward claim problem", "cannot find where to claim game rewards"], answer_en: "Open the Game tab and tap Claim." }, "Nhận thưởng game 3");
    const r3 = (await send("POST", "/api/kb/intake", admin, { rawText: "Mở tab Game và bấm Claim để nhận thưởng." })).json();
    const b3 = (r3.report.reviewBlocks ?? []).filter((x: { aKey: string; bKey: string }) => [x.aKey, x.bKey].includes("item:thuong-game-3"));
    expect(b3.length).toBeGreaterThan(0);
    expect(b3[0]).toMatchObject({ need: "recheck", verdict: "unchecked" });
    nextReview = async () => ({ verdict: "complement" });
    const rc = await send("POST", "/api/kb/recheck-conflicts", admin, { versionId: r3.version.id });
    expect(rc.statusCode, rc.body).toBe(200);
    expect((rc.json().report.reviewBlocks ?? []).filter((x: { aKey: string; bKey: string }) => [x.aKey, x.bKey].includes("item:thuong-game-3"))).toEqual([]);
    nextReview = async () => ({ verdict: "distinct" });
  });

  it("nhập file rà soát khách trả về: thêm cách hỏi + giữ cả hai (ghi ngữ cảnh) thành bản nháp, câu hỏi lại để người quản lý viết", async () => {
    const admin = await login(9002);
    const wb = new ExcelJS.Workbook();
    const s1 = wb.addWorksheet("1. Câu trả lời soạn sẵn");
    s1.addRow(["STT", "Tên", "Quyết định", "Thêm câu khách hay hỏi (mỗi dòng một câu)", "Mã hệ thống"]);
    s1.addRow([1, "Quên mã PIN ứng dụng", "Giữ nguyên", "lost the pin of the app\ncannot open app, pin forgotten", "quen-ma-pin-ung-dung"]);
    const s3 = wb.addWorksheet("3. Cặp cần xem");
    s3.addRow(["Mã cặp", "Quyết định", "Nếu giữ cả hai: mục thứ nhất dùng khi khách hỏi gì / trường hợp nào", "Nếu giữ cả hai: mục thứ hai dùng khi khách hỏi gì / trường hợp nào", "Mã hệ thống mục thứ nhất", "Mã hệ thống mục thứ hai"]);
    s3.addRow(["X001", "Trùng - giữ cả hai (ghi ngữ cảnh)", "quên PIN mở app", "hỏi nhiệt độ lò", "template:quen-ma-pin-ung-dung", "template:nhiet-lo"]);
    s3.addRow(["X002", "Lựa chọn lạ", "", "", "template:quen-ma-pin-ung-dung", "template:nhiet-lo"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const boundary = "----reviewboundary";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ra-soat.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = (await app.inject({ method: "POST", url: "/api/kb/import-review", headers: { cookie: admin, "x-requested-with": "admin-web", "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body })) as Res;
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(j.drafts.map((d: { topic: string }) => d.topic).sort()).toEqual(["account", "general"]); // "giữ cả hai" ghi ngữ cảnh cho cả hai mục
    expect(j.todo.join("\n")).toMatch(/không hiểu lựa chọn "Lựa chọn lạ"/);
    expect(j.todo.join("\n")).toMatch(/viết câu hỏi lại khách/);
    const account = j.drafts.find((d: { topic: string }) => d.topic === "account");
    const it = await itemIn(account.versionId, "quen-ma-pin-ung-dung", admin);
    expect(it.questions).toContain("cannot open app, pin forgotten");
    expect(it.applies_when).toBe("quên PIN mở app");
    expect(it.distinct_from[0]).toMatchObject({ item: "nhiet-lo", clarify: "" });
    // bản nháp sửa trước đó của chủ đề account được cập nhật tiếp (câu trả lời mới vẫn còn), không tạo bản thứ hai
    expect(it.steps[0]!.say).toEqual({ en: "Go to Security and choose Reset PIN." });
    const pending = (await get("/api/kb/content", admin)).json().pending;
    expect(pending.filter((p: { slug: string }) => p.slug === "items-account")).toEqual([expect.objectContaining({ versionId: account.versionId })]);
  });
});
