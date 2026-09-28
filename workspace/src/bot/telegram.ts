/** Adapter Telegram Bot API (fetch thuần, không phụ thuộc thư viện). */
import type { CallbackPress, Channel, InboundBatch, InboundItem, InlineButton, MessageEntity } from "./types";

export class TelegramError extends Error {
  constructor(message: string, readonly code: number, readonly retryAfter?: number) {
    super(message);
  }
}

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  entities?: { type: string; offset: number; length: number }[];
  caption_entities?: { type: string; offset: number; length: number }[];
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
  sticker?: { emoji?: string };
  reply_to_message?: { from?: TgUser };
  voice?: unknown;
  video?: unknown;
  video_note?: unknown;
  audio?: unknown;
  document?: unknown;
  animation?: unknown;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** Tin nhắn thường + lần bấm nút (duyệt xung đột dữ liệu qua Telegram). */
const ALLOWED_UPDATES = ["message", "callback_query"];

const keyboard = (rows: InlineButton[][]) => ({ inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) });

const MAX = 4096;

export class TelegramClient implements Channel {
  constructor(private readonly token: string, private readonly f: typeof fetch = fetch) {}

  async api<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const res = await this.f(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null;
    if (!json?.ok) throw new TelegramError(json?.description ?? `HTTP ${res.status}`, json?.error_code ?? res.status, json?.parameters?.retry_after);
    return json.result as T;
  }

  /**
   * Văn bản thuần (không parse_mode) nên không bao giờ bị lỗi định dạng; tách khi quá 4096 ký tự. Tin có `entities` (khối tóm tắt
   * dạng "pre") gửi nguyên một tin — tách sẽ làm lệch offset; bên gọi bảo đảm độ dài.
   */
  async send(chatId: number, text: string, opts?: { entities?: MessageEntity[] }): Promise<{ messageId?: number }> {
    if (opts?.entities?.length) {
      const r = await this.api<{ message_id: number }>("sendMessage", { chat_id: chatId, text: text.slice(0, MAX), entities: opts.entities });
      return { messageId: r.message_id };
    }
    let first: number | undefined;
    for (let i = 0; i < text.length || i === 0; i += MAX) {
      const r = await this.api<{ message_id: number }>("sendMessage", { chat_id: chatId, text: text.slice(i, i + MAX) });
      first ??= r.message_id;
    }
    return { messageId: first };
  }

  async sendButtons(chatId: number, text: string, rows: InlineButton[][]): Promise<{ messageId?: number }> {
    const r = await this.api<{ message_id: number }>("sendMessage", { chat_id: chatId, text: text.slice(0, MAX), reply_markup: keyboard(rows) });
    return { messageId: r.message_id };
  }

  async editMessage(chatId: number, messageId: number, text: string, rows: InlineButton[][] = []): Promise<void> {
    try {
      await this.api("editMessageText", { chat_id: chatId, message_id: messageId, text: text.slice(0, MAX), reply_markup: keyboard(rows) });
    } catch (e) {
      // sửa với đúng nội dung cũ -> Telegram báo "message is not modified": coi là xong
      if (!(e instanceof TelegramError && /not modified/i.test(e.message))) throw e;
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.api("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text: text.slice(0, 200) } : {}) });
  }

  async typing(chatId: number): Promise<void> {
    await this.api("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  async downloadImage(fileId: string): Promise<{ mime: string; base64: string }> {
    const file = await this.api<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new TelegramError("không có file_path", 400);
    if ((file.file_size ?? 0) > 10 * 1024 * 1024) throw new TelegramError("ảnh quá lớn", 413);
    const res = await this.f(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new TelegramError(`tải ảnh lỗi HTTP ${res.status}`, res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = file.file_path.split(".").pop()?.toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
    return { mime, base64: buf.toString("base64") };
  }

  getMe() {
    return this.api<TgUser>("getMe");
  }
  setWebhook(url: string, secret: string) {
    return this.api<boolean>("setWebhook", { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES, drop_pending_updates: false });
  }
  deleteWebhook() {
    return this.api<boolean>("deleteWebhook", { drop_pending_updates: false });
  }
  getUpdates(offset: number, timeoutSec: number) {
    return this.api<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ALLOWED_UPDATES }, (timeoutSec + 10) * 1000);
  }
}

export function parseCallback(u: TgUpdate): CallbackPress | null {
  const q = u.callback_query;
  if (!q || !q.data || q.from.is_bot) return null;
  const name = [q.from.first_name, q.from.last_name].filter(Boolean).join(" ") || q.from.username || null;
  return { id: q.id, fromId: q.from.id, fromName: name, chatId: q.message?.chat.id ?? null, messageId: q.message?.message_id ?? null, data: q.data };
}

/** Chuyển update Telegram thành InboundBatch (một tin). Trả null nếu không phải tin nhắn cần xử lý. */
export function parseUpdate(u: TgUpdate, bot: { id: number; username: string }): InboundBatch | null {
  const m = u.message;
  if (!m || !m.from || m.from.is_bot) return null;
  const chatType = (["private", "group", "supergroup", "channel"].includes(m.chat.type) ? m.chat.type : "private") as InboundBatch["chatType"];
  const rawText = m.text ?? m.caption;

  const mention = new RegExp(`@${bot.username}\\b`, "i");
  const isMention = chatType === "private" || (rawText ? mention.test(rawText) : false) || m.reply_to_message?.from?.id === bot.id;
  const text = rawText ? rawText.replace(new RegExp(`@${bot.username}\\b`, "gi"), "").trim() : undefined;

  const item: InboundItem = { updateId: u.update_id, messageId: m.message_id, text: text || undefined };
  if (m.photo?.length) {
    const largest = [...m.photo].sort((a, b) => (b.file_size ?? b.width * b.height) - (a.file_size ?? a.width * a.height))[0]!;
    item.photoFileId = largest.file_id;
  } else if (m.sticker) {
    item.sticker = true;
    item.text = item.text ?? m.sticker.emoji;
  } else if (m.voice || m.video || m.video_note || m.audio || m.document || m.animation) {
    item.otherMedia = true;
  }
  if (!item.text && !item.photoFileId && !item.sticker && !item.otherMedia) return null;

  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || null;
  return { chatId: m.chat.id, chatType, userId: m.from.id, name, username: m.from.username ?? null, items: [item], isMention, at: new Date(m.date * 1000) };
}
