/**
 * Test thực tế: gửi vài câu hỏi như khách thật qua ĐÚNG pipeline trả lời (router hybrid, hiểu → chọn → xác nhận → dịch),
 * dùng LLM thật + embedding thật + dữ liệu vault thật đang có trong DB. Không gửi qua Telegram thật (dùng kênh giả chỉ để
 * BẮT lại chữ bot định gửi, không giao hàng) — nhưng MỌI THỨ KHÁC đều thật: gọi AI thật (tốn phí), tìm kiếm trên
 * vault_chunks/kb_chunks thật, và GHI THẬT vào bảng users/episodes/messages (đánh dấu bằng chatId giả rõ ràng, xoá được
 * bằng --cleanup).
 *
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/test-live-response.ts [--cleanup]
 */
import { createServices } from "../src/app";
import { loadConfig } from "../src/config";
import { ProviderChain } from "../src/llm/chain";
import { LlmClient } from "../src/llm/client";
import { OpenAICompatProvider } from "../src/llm/openai-compat";
import { BotPipeline } from "../src/bot/pipeline";
import { ResponseResolver } from "../src/bot/resolver";
import type { Channel, InboundBatch, MessageEntity } from "../src/bot/types";

const TEST_CHAT_ID = -900000001; // âm + rất lớn: không trùng id Telegram thật nào, dễ nhận ra và xoá sau
const cleanupOnly = process.argv.includes("--cleanup");

class CapturingChannel implements Channel {
  sent: { text: string; entities?: MessageEntity[] }[] = [];
  async send(_chatId: number, text: string, opts?: { entities?: MessageEntity[] }) {
    this.sent.push({ text, entities: opts?.entities });
    return { messageId: 1 };
  }
  async downloadImage(): Promise<{ mime: string; base64: string }> {
    throw new Error("không dùng trong test này");
  }
}

const CASES: { label: string; text: string }[] = [
  { label: "Đúng chủ đề vault đã duyệt — tiếng Anh, hỏi thẳng", text: "how can i earn more ITLG?" },
  { label: "Đúng chủ đề vault đã duyệt — tiếng Việt, diễn đạt khác", text: "làm sao để kiếm thêm nhiều ITLG hơn vậy" },
  { label: "Đúng chủ đề vault đã duyệt — hỏi vòng vo, không trùng từ khoá", text: "I mine every single day but my ITLG keeps going down, why" },
  { label: "Chủ đề còn đang chờ duyệt (xung đột Ambassador chưa xử lý)", text: "how do I become an interlink ambassador?" },
  { label: "Ngoài phạm vi dự án", text: "what's the weather like today" },
];

async function main() {
  const cfg = loadConfig();
  const svc = await createServices(cfg, "worker", { seed: false });
  try {
    if (!cfg.LLM_BASE_URL) throw new Error("thiếu LLM_BASE_URL trong .env/.env.local");
    // Cấu hình gateway lưu trong DB trỏ host.docker.internal (đúng khi chạy TRONG container); script chạy từ host nên
    // dùng thẳng .env(.local) — không đụng cấu hình đã lưu cho container thật (xem scripts/run-vault-ingest-once.ts).
    const chain = new ProviderChain([new OpenAICompatProvider({ baseUrl: cfg.LLM_BASE_URL, apiKey: cfg.LLM_API_KEY, models: { fast: cfg.LLM_MODEL_FAST, strong: cfg.LLM_MODEL_STRONG, intake: cfg.LLM_MODEL_FAST }, timeoutMs: 60_000 }, "gateway-host")]);
    const llm = new LlmClient(chain, () => svc.skills.get(), () => true, async () => { await svc.live.ensureFresh(10_000); return svc.live.guide; });

    if (cleanupOnly) {
      await svc.db.query("DELETE FROM episodes WHERE user_id = $1", [TEST_CHAT_ID]);
      await svc.db.query("DELETE FROM messages WHERE user_id = $1", [TEST_CHAT_ID]);
      await svc.db.query("DELETE FROM users WHERE telegram_id = $1", [TEST_CHAT_ID]);
      console.log("Đã xoá dữ liệu test (chatId", TEST_CHAT_ID, ")");
      return;
    }

    const channel = new CapturingChannel();
    const resolver = new ResponseResolver(svc.kb, llm, () => svc.live.index, () => svc.live.urlHosts);
    const pipeline = new BotPipeline({
      db: svc.db, conv: svc.conv, kb: svc.kb, ops: svc.ops, live: svc.live, settings: svc.settings, resolver, channel, llm,
      knowledge: svc.knowledge, media: svc.media, ownerId: svc.cfg.ownerId, adminWebUrl: svc.cfg.PUBLIC_ADMIN_URL, log: svc.log,
    });

    console.log(`Router mode hiện tại: ${(await svc.settings.get())["router.mode"]}\n`);
    let updateId = 1;
    for (const c of CASES) {
      channel.sent = [];
      const t0 = Date.now();
      const batch: InboundBatch = { chatId: TEST_CHAT_ID, chatType: "private", userId: TEST_CHAT_ID, name: "Test khách", username: "test_khach", isMention: true, at: new Date(), items: [{ updateId: updateId++, messageId: updateId, text: c.text }] };
      const res = await pipeline.handle(batch);
      const ms = Date.now() - t0;
      console.log(`=== ${c.label} ===`);
      console.log(`Khách hỏi: "${c.text}"`);
      console.log(`Kết quả: ${res.status} | outcome=${res.decisionKind ?? "?"} | tier=${res.tier ?? "?"} | ${ms}ms`);
      console.log(`Bot trả lời:\n${channel.sent.map((s) => s.text).join("\n---\n") || "(không gửi gì)"}\n`);
    }
  } finally {
    await svc.close();
  }
}

await main();
