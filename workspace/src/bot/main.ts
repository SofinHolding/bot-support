/** Bot Service: nhận tin Telegram (webhook hoặc polling), gom tin, chạy pipeline. */
import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { isMain } from "../entry";
import { createServices, type Services } from "../app";
import { loadConfig } from "../config";
import { Coalescer } from "./coalescer";
import { parseUpdate, type TgUpdate } from "./telegram";

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function startBot(svc: Services) {
  const { cfg, log, pipeline } = svc;
  if (!svc.telegram) throw new Error("Cần TELEGRAM_BOT_TOKEN để chạy bot");
  const me = await svc.telegram.getMe();
  const bot = { id: me.id, username: me.username ?? "" };
  log("info", "bot sẵn sàng", { username: bot.username });

  const coalescer = new Coalescer(
    (b) => pipeline.handle(b),
    () => 2000, // gateway cũ debounce 2000ms
    (e) => log("error", "xử lý lượt lỗi", { err: (e as Error).message }),
  );
  const ingest = (u: TgUpdate) => {
    const b = parseUpdate(u, bot);
    if (b) coalescer.push(b);
  };

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  app.get("/healthz", async () => ({ ok: true, service: "bot", kbVersion: svc.live.version }));

  let stopPolling = false;
  if (cfg.TELEGRAM_MODE === "webhook") {
    const secret = cfg.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) throw new Error("Chế độ webhook cần TELEGRAM_WEBHOOK_SECRET");
    app.post("/telegram/webhook", async (req, reply) => {
      // Chống giả mạo webhook: Telegram gửi kèm secret token đã đăng ký
      const got = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
      if (!safeEq(got, secret)) return reply.code(401).send({ ok: false });
      ingest(req.body as TgUpdate); // trả 200 ngay; xử lý chạy nền, idempotency đảm bảo gửi lại không gây trùng
      return { ok: true };
    });
    if (cfg.PUBLIC_BOT_URL) await svc.telegram.setWebhook(`${cfg.PUBLIC_BOT_URL.replace(/\/$/, "")}/telegram/webhook`, secret);
  } else {
    await svc.telegram.deleteWebhook(); // polling và webhook loại trừ nhau
    void (async () => {
      let offset = 0;
      while (!stopPolling) {
        try {
          const updates = await svc.telegram!.getUpdates(offset, 25);
          for (const u of updates) {
            offset = u.update_id + 1;
            ingest(u);
          }
        } catch (e) {
          log("warn", "polling lỗi, thử lại sau 3s", { err: (e as Error).message });
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
  }

  await app.listen({ port: cfg.BOT_PORT, host: "0.0.0.0" });
  log("info", `bot lắng nghe :${cfg.BOT_PORT} (${cfg.TELEGRAM_MODE})`);
  return {
    async stop() {
      stopPolling = true;
      await coalescer.flush();
      await app.close();
    },
  };
}

if (isMain("bot.js", import.meta.url)) {
  const cfg = loadConfig();
  const svc = await createServices(cfg, "bot");
  const running = await startBot(svc);
  const shutdown = async () => {
    await running.stop();
    await svc.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
