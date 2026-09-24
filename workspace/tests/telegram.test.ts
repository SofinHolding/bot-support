import { describe, expect, it } from "vitest";
import { Coalescer } from "../src/bot/coalescer";
import { startBot } from "../src/bot/main";
import { BotPipeline } from "../src/bot/pipeline";
import { parseUpdate, TelegramClient, TelegramError, type TgUpdate } from "../src/bot/telegram";
import { createServices } from "../src/app";
import { loadConfig } from "../src/config";
import type { InboundBatch } from "../src/bot/types";
import { fakeLlm } from "./helpers";

const BOT = { id: 42, username: "SupportBot" };
const upd = (m: Record<string, unknown>, id = 1): TgUpdate => ({ update_id: id, message: { message_id: 7, date: 1_780_000_000, chat: { id: 100, type: "private" }, from: { id: 100, first_name: "An", last_name: "Nguyen", username: "an" }, ...m } as never });

describe("parseUpdate", () => {
  it("tin nhắn văn bản riêng tư luôn là mention; lấy tên và username", () => {
    const b = parseUpdate(upd({ text: "how to withdraw" }), BOT)!;
    expect(b).toMatchObject({ chatId: 100, userId: 100, chatType: "private", isMention: true, name: "An Nguyen", username: "an" });
    expect(b.items[0]).toMatchObject({ updateId: 1, text: "how to withdraw" });
  });

  it("nhóm: chỉ là mention khi nhắc @bot hoặc reply vào bot; bỏ @bot khỏi nội dung", () => {
    const g = (extra: Record<string, unknown>) => parseUpdate(upd({ chat: { id: -5, type: "supergroup" }, ...extra }), BOT)!;
    expect(g({ text: "how to withdraw" }).isMention).toBe(false);
    const m = g({ text: "@SupportBot how to withdraw" });
    expect(m.isMention).toBe(true);
    expect(m.items[0]!.text).toBe("how to withdraw");
    expect(g({ text: "how to withdraw", reply_to_message: { from: { id: 42 } } }).isMention).toBe(true);
  });

  it("ảnh: lấy bản lớn nhất, caption làm text; sticker; tệp khác; tin bot bị bỏ", () => {
    const p = parseUpdate(upd({ caption: "help", photo: [{ file_id: "s", width: 10, height: 10 }, { file_id: "L", width: 800, height: 600, file_size: 90000 }] }), BOT)!;
    expect(p.items[0]).toMatchObject({ photoFileId: "L", text: "help" });
    expect(parseUpdate(upd({ sticker: { emoji: "👍" } }), BOT)!.items[0]).toMatchObject({ sticker: true, text: "👍" });
    expect(parseUpdate(upd({ video: {} }), BOT)!.items[0]).toMatchObject({ otherMedia: true });
    expect(parseUpdate(upd({ from: { id: 5, is_bot: true } }), BOT)).toBeNull();
    expect(parseUpdate({ update_id: 3 }, BOT)).toBeNull();
    expect(parseUpdate(upd({ new_chat_members: [] }), BOT)).toBeNull();
  });
});

function fakeApi(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/file/bot")) return new Response(Buffer.from("PNGDATA"), { status: 200 });
    const method = u.split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    const h = handlers[method];
    if (!h) return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    const out = h(body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ ok: true, result: out }), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

describe("TelegramClient", () => {
  it("gửi văn bản thuần, tách khi quá 4096 ký tự", async () => {
    const { f, calls } = fakeApi({ sendMessage: () => ({ message_id: 11 }) });
    const tg = new TelegramClient("TOKEN", f);
    const r = await tg.send(100, "x".repeat(5000));
    expect(r.messageId).toBe(11);
    expect(calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text).length)).toEqual([4096, 904]);
    expect(calls[0]!.body).not.toHaveProperty("parse_mode"); // không parse_mode: không bao giờ lỗi định dạng
  });

  it("lỗi API -> TelegramError kèm retry_after", async () => {
    const { f } = fakeApi({ sendMessage: () => new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }), { status: 429 }) });
    await expect(new TelegramClient("T", f).send(1, "hi")).rejects.toMatchObject({ code: 429, retryAfter: 7 });
    await expect(new TelegramClient("T", f).send(1, "hi")).rejects.toBeInstanceOf(TelegramError);
  });

  it("tải ảnh: getFile -> tải nội dung -> base64 + mime theo đuôi", async () => {
    const { f } = fakeApi({ getFile: () => ({ file_path: "photos/file_1.png", file_size: 7 }) });
    const img = await new TelegramClient("T", f).downloadImage("FID");
    expect(img.mime).toBe("image/png");
    expect(Buffer.from(img.base64, "base64").toString()).toBe("PNGDATA");
  });

  it("từ chối ảnh quá lớn (> 10 MB)", async () => {
    const { f } = fakeApi({ getFile: () => ({ file_path: "a.jpg", file_size: 11 * 1024 * 1024 }) });
    await expect(new TelegramClient("T", f).downloadImage("F")).rejects.toMatchObject({ code: 413 });
  });
});

describe("Coalescer", () => {
  const b = (text: string, updateId: number, userId = 1): InboundBatch => ({ chatId: userId, chatType: "private", userId, isMention: true, at: new Date(), items: [{ updateId, messageId: updateId, text }] });

  it("gom các tin liên tiếp của cùng một khách trong cửa sổ thành MỘT lượt", async () => {
    const seen: InboundBatch[] = [];
    const c = new Coalescer(async (x) => void seen.push(x), () => 30);
    c.push(b("a", 1));
    c.push(b("b", 2));
    c.push(b("other", 3, 2));
    await new Promise((r) => setTimeout(r, 80));
    await c.flush();
    expect(seen.length).toBe(2);
    expect(seen.find((x) => x.userId === 1)!.items.map((i) => i.text)).toEqual(["a", "b"]);
  });

  it("lượt của cùng một khách chạy tuần tự, không chồng lên nhau", async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const c = new Coalescer(async (x) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(`start:${x.items[0]!.text}`);
      await new Promise((r) => setTimeout(r, 40));
      order.push(`end:${x.items[0]!.text}`);
      running--;
    }, () => 5);
    c.push(b("first", 1));
    await new Promise((r) => setTimeout(r, 15)); // first đã kích hoạt và đang chạy
    c.push(b("second", 2));
    await c.flush();
    expect(maxRunning).toBe(1);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("lỗi của một lượt không làm hỏng các lượt sau", async () => {
    let n = 0;
    const errors: unknown[] = [];
    const c = new Coalescer(async () => { if (n++ === 0) throw new Error("boom"); }, () => 1, (e) => errors.push(e));
    c.push(b("x", 1));
    await c.flush();
    c.push(b("y", 2));
    await c.flush();
    expect(n).toBe(2);
    expect(errors.length).toBe(1);
  });
});

describe("webhook Telegram (Bot Service)", () => {
  it("từ chối secret sai (401), nhận secret đúng, xử lý và trả lời qua Bot API", async () => {
    const port = 39000 + Math.floor(Math.random() * 500);
    const cfg = loadConfig({ DATABASE_URL: "pglite:memory", TELEGRAM_MODE: "webhook", TELEGRAM_WEBHOOK_SECRET: "s3cret-value", BOT_PORT: String(port), ADMIN_TELEGRAM_IDS: "9001", OWNER_TELEGRAM_ID: "9001", CONTENT_DIR: "content", MEDIA_DIR: "/tmp/tg-media-test", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
    const svc = await createServices(cfg, "bot");
    const api = fakeApi({ getMe: () => ({ id: 42, username: "SupportBot", is_bot: true }), sendMessage: () => ({ message_id: 5 }) });
    const tg = new TelegramClient("TOKEN", api.f);
    (svc as { telegram: unknown }).telegram = tg;
    (svc as { pipeline: unknown }).pipeline = new BotPipeline({ db: svc.db, conv: svc.conv, kb: svc.kb, ops: svc.ops, live: svc.live, settings: svc.settings, resolver: svc.resolver, channel: tg, llm: fakeLlm(), knowledge: svc.knowledge, ownerId: 9001, adminWebUrl: "http://x" }); // AI giả: mọi câu trả lời đều phải qua AI

    const running = await startBot(svc);
    try {
      const url = `http://127.0.0.1:${port}/telegram/webhook`;
      const post = (secret: string | null, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) }, body: JSON.stringify(body) });

      expect((await post(null, upd({ text: "how to withdraw" }, 501))).status).toBe(401);
      expect((await post("wrong", upd({ text: "how to withdraw" }, 502))).status).toBe(401);
      expect(api.calls.filter((c) => c.method === "sendMessage").length).toBe(0);

      expect((await post("s3cret-value", upd({ text: "how to withdraw" }, 503))).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    } finally {
      await running.stop(); // flush coalescer -> pipeline chạy xong
    }
    const sent = api.calls.filter((c) => c.method === "sendMessage");
    expect(sent.length).toBe(1);
    expect(String(sent[0]!.body.text)).toContain("you can not withdraw now");
    expect(sent[0]!.body.chat_id).toBe(100);
    await svc.close();
  });
});
