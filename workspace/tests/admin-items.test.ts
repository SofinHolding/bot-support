import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAdminServer } from "../src/admin/server";
import { createServices, type Services } from "../src/app";
import { loadConfig } from "../src/config";
import { FakeChannel } from "./helpers";

let svc: Services;
let app: FastifyInstance;
let channel: FakeChannel;
const media = mkdtempSync(join(tmpdir(), "admin-items-media-"));
const clock = { now: new Date("2026-09-21T03:00:00Z") };
let ipSeq = 1;
const ip = () => `10.1.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`; // mỗi lần đăng nhập một IP để không dính giới hạn theo IP

const H = { "x-requested-with": "admin-web", "content-type": "application/json" };
type Res = { statusCode: number; json: () => any; body: string; headers: Record<string, unknown> };

beforeAll(async () => {
  const cfg = loadConfig({ DATABASE_URL: "pglite:memory", ADMIN_TELEGRAM_IDS: "9001,9002", OWNER_TELEGRAM_ID: "9001", SECRETS_KEY: "test-secrets-key-0123456789-abcdefghij", MEDIA_DIR: media, CONTENT_DIR: "content", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  svc = await createServices(cfg, "admin");
  channel = new FakeChannel();
  (svc as { channel: unknown }).channel = channel;
  await svc.ops.upsertAdmin(9003, "viewer", null);
  await svc.ops.setSetting("router.mode", "code_first", "test"); // các test ở đây kiểm luồng luật/từ khoá; luồng "AI hiểu trước" có test riêng (llm-first.test.ts)
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

describe("Admin Web: mục hỏi đáp dạng form", () => {
  const item = (answer: string, extra: Record<string, unknown> = {}) => ({
    title: "Quên mã PIN ứng dụng",
    kind: "answer",
    questions: ["I forgot my app pin code", "how to reset the app lock pin code", "app pin code forgotten what now"],
    phrases: ["app pin code"],
    steps: [{ say: { en: answer }, next: { negative: "handoff" } }],
    ...extra,
  });

  it("tạo mục mới: mã tự sinh từ tên, lưu thành bản nháp của chủ đề, qua kiểm tra rồi publish; bot dùng ngay", async () => {
    const admin = await login(9002);
    const list = (await get("/api/items", admin)).json();
    expect(list.topics).toHaveLength(12);
    expect(list.topics.every((t: { exists: boolean }) => !t.exists)).toBe(true);

    const r = await send("POST", "/api/items/account", admin, { item: item("Open Settings and tap Reset app PIN.") });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.itemId).toBe("quen-ma-pin-ung-dung");
    expect(body.report.steps.filter((s: { status: string }) => s.status === "error")).toEqual([]);

    const pub = await send("POST", `/api/kb/versions/${body.versionId}/publish`, admin, {});
    expect(pub.json().status).toBe("published");
    const t = (await send("POST", "/api/items/try", admin, { question: "app pin code" })).json();
    expect(t).toMatchObject({ result: "TEMPLATE", itemId: "quen-ma-pin-ung-dung", title: "Quên mã PIN ứng dụng", answer: "Open Settings and tap Reset app PIN." });
  });

  it("sửa mục: mã giữ nguyên, tạo bản nháp mới; thử hỏi trên bản nháp thấy câu trả lời mới, bộ đang chạy vẫn là câu cũ", async () => {
    const admin = await login(9002);
    const r = (await send("POST", "/api/items/account", admin, { originalId: "quen-ma-pin-ung-dung", item: item("Go to Security and choose Reset PIN.") })).json();
    expect(r.itemId).toBe("quen-ma-pin-ung-dung");
    const draft = (await send("POST", "/api/items/try", admin, { question: "app pin code", versionId: r.versionId })).json();
    expect(draft.answer).toBe("Go to Security and choose Reset PIN.");
    const live = (await send("POST", "/api/items/try", admin, { question: "app pin code" })).json();
    expect(live.answer).toBe("Open Settings and tap Reset app PIN.");
    const topic = (await get("/api/items", admin)).json().topics.find((x: { topic: string }) => x.topic === "account");
    expect(topic.draft.id).toBe(r.versionId);
    expect(topic.items[0].steps[0].say.en).toBe("Go to Security and choose Reset PIN.");
  });

  it("thử hỏi trên bản nháp: mục mới (chưa có vector) vẫn được so theo nghĩa", async () => {
    const admin = await login(9002);
    const r = (await send("POST", "/api/items/wallet", admin, { item: { title: "Đổi mạng lưới ví", kind: "answer", questions: ["how do I switch the wallet network", "change network in my wallet", "wallet shows the wrong chain network"], phrases: [], steps: [{ say: { en: "Tap the network name and choose another." } }] } })).json();
    const t = (await send("POST", "/api/items/try", admin, { question: "switch wallet network please", versionId: r.versionId })).json();
    expect([t.itemId, ...t.suggestions.map((s: { id: string }) => s.id)]).toContain("doi-mang-luoi-vi");
  });

  it("viewer không được sửa; dữ liệu sai bị từ chối", async () => {
    const viewer = await login(9003);
    expect((await send("POST", "/api/items/account", viewer, { item: item("x") })).statusCode).toBe(403);
    const admin = await login(9002);
    expect((await send("POST", "/api/items/account", admin, { item: { ...item("x"), kind: "weird" } })).statusCode).toBe(400);
    expect((await send("POST", "/api/items/no-such-topic", admin, { item: item("x") })).statusCode).toBe(400);
  });

  it("mục giành câu hỏi của đoạn tài liệu: báo cáo có nút xử lý; ghi nhận giữ nguyên thì hết chặn", async () => {
    const admin = await login(9002);
    const kmd = "---\nslug: oven-guide\ntitle: Oven guide\nresponse_mode: GROUNDED_GENERATION\n---\n# Oven guide\n\n## Pizza oven temperature\n\nThe pizza oven temperature depends on the dough and the stone used for baking.\n";
    const k = (await send("POST", "/api/kb/documents", admin, { slug: "oven-guide", kind: "knowledge", md: kmd })).json();
    await send("POST", `/api/kb/versions/${k.version.id}/publish`, admin, {});
    const r = (await send("POST", "/api/items/general", admin, { item: { title: "Nhiệt lò", kind: "answer", questions: ["how hot is the oven", "oven heat level please", "what heat for baking"], phrases: ["pizza oven temperature"], steps: [{ say: { en: "250 degrees." } }] } })).json();
    expect(r.report.hijacks?.[0]).toMatchObject({ itemId: "nhiet-lo", heading: "Pizza oven temperature" });
    const d = (await send("POST", "/api/items/decide", admin, { versionId: r.versionId, itemId: "nhiet-lo", chunkId: r.report.hijacks[0].chunkId, note: "cố ý" })).json();
    expect(d.report.hijacks ?? []).toEqual([]);
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
    const r = (await app.inject({ method: "POST", url: "/api/items/import-review", headers: { cookie: admin, "x-requested-with": "admin-web", "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body })) as Res;
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(j.drafts.map((d: { topic: string }) => d.topic).sort()).toEqual(["account", "general"]); // "giữ cả hai" ghi ngữ cảnh cho cả hai mục
    expect(j.todo.join("\n")).toMatch(/không hiểu lựa chọn "Lựa chọn lạ"/);
    expect(j.todo.join("\n")).toMatch(/viết câu hỏi lại khách/);
    const topic = (await get("/api/items", admin)).json().topics.find((x: { topic: string }) => x.topic === "account");
    const it = topic.items.find((x: { id: string }) => x.id === "quen-ma-pin-ung-dung");
    expect(it.questions).toContain("cannot open app, pin forgotten");
    expect(it.applies_when).toBe("quên PIN mở app");
    expect(it.distinct_from[0]).toMatchObject({ item: "nhiet-lo", clarify: "" });
  });
});
