export interface InboundItem {
  updateId: number;
  messageId: number;
  text?: string;
  photoFileId?: string;
  sticker?: boolean;
  /** video, voice, tài liệu... (không phải ảnh) */
  otherMedia?: boolean;
}

/** Các tin nhắn liên tiếp của cùng một khách trong cửa sổ gom tin (gateway cũ debounce 2 giây). */
export interface InboundBatch {
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  userId: number;
  name?: string | null;
  username?: string | null;
  items: InboundItem[];
  /** Trong nhóm: chỉ trả lời khi được nhắc tên / reply vào bot (AGENTS.md > Group Chats) */
  isMention: boolean;
  at: Date;
}

/** Định dạng một đoạn tin (Telegram MessageEntity), dùng thay parse_mode để không phải escape ký tự. offset/length tính theo UTF-16. */
export interface MessageEntity {
  type: "pre";
  offset: number;
  length: number;
}

export interface Channel {
  send(chatId: number, text: string, opts?: { entities?: MessageEntity[] }): Promise<{ messageId?: number }>;
  downloadImage(fileId: string): Promise<{ mime: string; base64: string }>;
  /** Báo "đang soạn" (tuỳ chọn). Telegram hiển thị ~5 giây mỗi lần gọi. */
  typing?(chatId: number): Promise<void>;
  /** Tin cho ADMIN kèm nút bấm (inline keyboard). `data` của nút: 1-64 byte (xem vault/telegram-flow.ts). */
  sendButtons?(chatId: number, text: string, rows: InlineButton[][]): Promise<{ messageId?: number }>;
  /** Tin hỏi lại ADMIN, ép trả lời (force reply): dùng để nhận nội dung "Gộp / nhập lại" bằng chữ thường, không phải nút. */
  sendForceReply?(chatId: number, text: string): Promise<{ messageId?: number }>;
  /** Sửa tin đã gửi; `rows` rỗng = bỏ hết nút. */
  editMessage?(chatId: number, messageId: number, text: string, rows?: InlineButton[][]): Promise<void>;
  /** Trả lời lần bấm nút (bắt buộc, nếu không nút bị treo ở trạng thái đang tải). */
  answerCallback?(callbackId: string, text?: string): Promise<void>;
}

export interface InlineButton {
  text: string;
  data: string;
}

/** Một lần admin bấm nút dưới tin của bot. */
export interface CallbackPress {
  id: string;
  fromId: number;
  fromName: string | null;
  chatId: number | null;
  messageId: number | null;
  data: string;
}

/** Admin trả lời (reply) một tin cụ thể của bot bằng chữ thường — dùng để nhận nội dung "Gộp / nhập lại". */
export interface AdminTextReply {
  fromId: number;
  fromName: string | null;
  chatId: number;
  /** id tin admin vừa gửi (để sửa/trả lời lại đúng chỗ nếu cần) */
  messageId: number;
  /** id tin của BOT mà admin đang trả lời — khoá để khớp với prompt đang chờ */
  replyToMessageId: number;
  text: string;
}

export interface PipelineResult {
  status: "ok" | "ignored" | "duplicate" | "in_progress" | "error";
  replies: string[];
  decisionKind?: string;
  templateId?: string | null;
  tier?: number;
}
