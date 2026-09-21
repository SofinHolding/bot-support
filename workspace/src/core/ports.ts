/** Các cổng (interface) mà router cần. Cài đặt thật nằm ở src/llm và src/db; test dùng bản giả. */
import type { VisionResult } from "../domain/types";

export interface ContextPack {
  /** 1-2 dòng về khách: ngôn ngữ, episode trước, cờ */
  profile: string;
  /** Sự kiện do CODE ghi (luôn đúng): template đã gửi, ảnh đã nhận... */
  events: string[];
  /** Tóm tắt cuộn do LLM viết — chỉ để hiểu ngữ cảnh, không dùng để ra quyết định */
  summary?: string;
  /** Các tin sau mốc tóm tắt, đã che dữ liệu nhạy cảm */
  recent: { role: "user" | "bot"; text: string }[];
}

export interface ClassifyRequest {
  text: string;
  lang: string;
  context: ContextPack;
  /** Chỉ những template này được phép chọn */
  candidates: { id: string; group: string; gist: string }[];
}

export type ClassifyResult =
  | { action: "template"; template_id: string }
  | { action: "knowledge" }
  | { action: "escalate" }
  | { action: "offtopic" };

export interface GroundedChunk {
  id: string;
  heading: string;
  text: string;
  url?: string;
}

export interface GroundedResult {
  answerable: boolean;
  answer: string;
  cited: string[];
}

export interface SummaryInput {
  previous?: { issue?: string; user_reported?: string; unresolved_points?: string };
  messages: { role: "user" | "bot"; text: string }[];
}

export interface SummaryResult {
  issue: string;
  user_reported: string;
  unresolved_points: string;
}

export class LlmUnavailableError extends Error {
  constructor(message = "LLM unavailable") {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export interface LlmPort {
  classify(req: ClassifyRequest): Promise<ClassifyResult>;
  grounded(req: { question: string; lang: string; chunks: GroundedChunk[] }): Promise<GroundedResult>;
  vision(req: { mime: string; base64: string; caption?: string }): Promise<VisionResult>;
  /** Dịch nguyên văn; bên gọi kiểm tra các token bảo vệ (URL, tên sản phẩm, handle) còn nguyên. */
  translate(req: { text: string; lang: string }): Promise<string>;
  summarize(req: SummaryInput): Promise<SummaryResult>;
}

export interface KnowledgeHit {
  chunkId: string;
  docSlug: string;
  heading: string;
  text: string;
  url?: string;
  score: number;
}

export interface KnowledgePort {
  search(query: string, k: number): Promise<KnowledgeHit[]>;
}
