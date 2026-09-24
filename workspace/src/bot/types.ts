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

export interface Channel {
  send(chatId: number, text: string): Promise<{ messageId?: number }>;
  downloadImage(fileId: string): Promise<{ mime: string; base64: string }>;
  /** Báo "đang soạn" (tuỳ chọn). Telegram hiển thị ~5 giây mỗi lần gọi. */
  typing?(chatId: number): Promise<void>;
}

export interface PipelineResult {
  status: "ok" | "ignored" | "duplicate" | "in_progress" | "error";
  replies: string[];
  decisionKind?: string;
  templateId?: string | null;
  tier?: number;
}
