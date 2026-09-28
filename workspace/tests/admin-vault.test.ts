/** Admin Web: tải file -> lượt nạp -> worker chuyển đổi -> xung đột -> admin chọn -> worker áp dụng. */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAdminServer } from "../src/admin/server";
import { rawFileName } from "../src/admin/vault-routes";
import { createServices, type Services } from "../src/app";
import { loadConfig } from "../src/config";
import type { LlmPort } from "../src/core/ports";
import { runDueJobs } from "../src/worker/runner";
import { jobContext } from "../src/worker/main";
import { fakeLlm, FakeChannel } from "./helpers";

let svc: Services;
let app: FastifyInstance;
let channel: FakeChannel;
let llm: LlmPort;
const vaultDir = mkdtempSync(join(tmpdir(), "vault-"));
const rawDir = mkdtempSync(join(tmpdir(), "raw-"));
const clock = { now: new Date("2026-09-28T03:00:00Z") };
let ipSeq = 1;
const H = { "x-requested-with": "admin-web", "content-type": "application/json" };
type Res = { statusCode: number; json: () => any; body: string };

beforeAll(async () => {
  const cfg = loadConfig({ DATABASE_URL: "pglite:memory", ADMIN_TELEGRAM_IDS: "9001,9002", OWNER_TELEGRAM_ID: "9001", CONTENT_DIR: "content", LOG_LEVEL: "error", VAULT_DIR: vaultDir, RAW_DATA_DIR: rawDir } as NodeJS.ProcessEnv);
  svc = await createServices(cfg, "admin");
  channel = new FakeChannel();
  (svc as { channel: unknown }).channel = channel;
  await svc.ops.upsertAdmin(9003, "viewer", null);
  // hai dòng cùng chủ đề, số liệu khác nhau -> mâu thuẫn; AI gộp: một note đúng chủ đề
  llm = fakeLlm({
    draftVaultNotes: async (r) => ({
      notes: r.units.map((u) => ({
        title: "Phí giao dịch", category: "wallet", tags: [], lang_source: "vi" as const, version_group: r.fixedVersionGroup ?? "phi-giao-dich", related: [], summary: u.text, keywords: ["phí"],
        canonical_title: "Fee", canonical_summary: u.text, canonical_keywords: ["fee"], sections: [{ heading: "", body: u.text }], units: [u.id],
      })),
      unmatched: [],
    }),
    compareVaultNotes: async (r) => ({ results: r.pairs.map((p) => ({ pair: p.id, verdict: "contradiction" as const, reason: "Một bên ghi 1.5%, bên kia ghi 2%." })) }),
  });
  (svc as { llm: unknown }).llm = llm;
  app = await buildAdminServer(svc, { now: () => clock.now, webDir: "src/admin/web" });
});
afterAll(async () => {
  await app.close();
  await svc.close();
  rmSync(vaultDir, { recursive: true, force: true });
  rmSync(rawDir, { recursive: true, force: true });
});

async function login(id: number): Promise<string> {
  const n = channel.sent.length;
  const ip = `10.9.0.${ipSeq++}`;
  await app.inject({ method: "POST", url: "/api/auth/request-code", headers: H, remoteAddress: ip, payload: { telegramId: id } });
  const code = /\b(\d{6})\b/.exec(channel.sent.slice(n).find((s) => s.chatId === id)?.text ?? "")?.[1];
  const r = (await app.inject({ method: "POST", url: "/api/auth/verify", headers: H, remoteAddress: ip, payload: { telegramId: id, code } })) as Res & { cookies: { name: string; value: string }[] };
  return `sid=${r.cookies.find((c) => c.name === "sid")!.value}`;
}
const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } }) as Promise<Res>;
const send = (url: string, cookie: string, payload?: unknown) => app.inject({ method: "POST", url, headers: { ...H, cookie }, payload: payload as never }) as Promise<Res>;

function upload(cookie: string, filename: string, content: string) {
  const boundary = "----vaulttest";
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  return app.inject({ method: "POST", url: "/api/vault/upload", headers: { "x-requested-with": "admin-web", cookie, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body }) as Promise<Res>;
}

async function work() {
  const ctx = { ...jobContext(svc), llm, now: () => clock.now };
  for (let i = 0; i < 5; i++) if (!(await runDueJobs(ctx, 20)).ran) break;
}

describe("Admin Web: thêm nội dung bằng tệp (vault)", () => {
  it("tên tệp thô an toàn, có ngày, không ghi đè", () => {
    expect(rawFileName(rawDir, "../../etc/pass wd?.txt", "2026-09-28")).toBe("2026-09-28_pass wd_.txt");
  });

  it("viewer không tải được; tệp sai định dạng bị từ chối và nói cần làm gì", async () => {
    expect((await upload(await login(9003), "a.txt", "x")).statusCode).toBe(403);
    const r = await upload(await login(9002), "a.exe", "x");
    expect(r.statusCode).toBe(415);
    expect(r.json().error).toContain("chỉ nhận");
  });

  it("tải lên -> lưu raw-data/ -> worker chuyển đổi -> xung đột chờ chọn -> chọn -> note dùng được", async () => {
    const admin = await login(9002);
    const up = await upload(admin, "phi.txt", "Phí giao dịch là 1.5%.\n\n\n\nPhí giao dịch là 2%.");
    expect(up.statusCode).toBe(200);
    expect(readdirSync(rawDir)).toContain("2026-09-28_phi.txt");
    // tệp .txt ngắn thành một đơn vị (dùng được ngay); tệp .md có hai heading -> hai phương án mâu thuẫn nhau và với bản vừa nạp
    const up2 = await upload(admin, "phi.md", "# Phí A\nPhí giao dịch là 1.5%.\n# Phí B\nPhí giao dịch là 2%.");
    expect(up2.statusCode).toBe(200);
    await work();

    const batches = (await get("/api/vault/batches", admin)).json().batches;
    expect(batches.map((b: { status: string }) => b.status)).toEqual(["done", "done"]);
    const summary = (await get("/api/vault/summary", admin)).json();
    expect(summary.openConflicts).toBe(1);

    const [c] = (await get("/api/vault/conflicts", admin)).json().conflicts;
    expect(c.options).toEqual(expect.arrayContaining(["a", "b", "merge", "drop_all"]));
    expect(existsSync(join(vaultDir, "_notifications"))).toBe(true);

    // xem trước bản gộp rồi xác nhận
    const pv = (await send(`/api/vault/conflicts/${c.id}/merge-preview`, admin, { text: "Phí giao dịch hiện tại là 1.5% cho mọi giao dịch." })).json();
    expect(pv.note.version_group).toBe(c.versionGroup);
    const d1 = await send(`/api/vault/conflicts/${c.id}/decide`, admin, { decision: "merge", note: pv.note });
    expect(d1.statusCode).toBe(200);
    // người thứ hai bấm sau: bị từ chối, biết ai đã xử lý
    const d2 = await send(`/api/vault/conflicts/${c.id}/decide`, await login(9001), { decision: "a" });
    expect(d2.statusCode).toBe(409);
    expect(d2.json().error).toContain("đã được xử lý bởi");

    await work();
    expect((await get(`/api/vault/conflicts/${c.id}`, admin)).json().conflict.status).toBe("resolved");
    const notes = (await get("/api/vault/summary", admin)).json().notes;
    expect(notes.confirmed).toBeGreaterThanOrEqual(1);
    expect((await get("/api/vault/summary", admin)).json().index.chunks).toBeGreaterThanOrEqual(1);
  });

  it("lượt nạp lỗi (chưa cấu hình AI) chạy lại được", async () => {
    const admin = await login(9002);
    const up = (await upload(admin, "b.txt", "Nội dung mới.")).json();
    const ctx = { ...jobContext(svc), llm: { ...llm, ready: false }, now: () => clock.now };
    await runDueJobs(ctx, 5);
    const b = (await get(`/api/vault/batches/${up.batchId}`, admin)).json().batch;
    expect(b.status).toBe("failed");
    expect(b.error).toContain("Chạy lại");
    expect((await send(`/api/vault/batches/${up.batchId}/retry`, admin)).statusCode).toBe(200);
  });
});
