import type { ZodType } from "zod";

export type ContentPart = { type: "text"; text: string } | { type: "image"; mime: string; base64: string };

export interface SystemBlock {
  text: string;
  /** Khối ổn định giữa các lượt: bật prompt caching để lượt sau gần như miễn phí. */
  cache?: boolean;
}

export type ModelTier = "fast" | "strong";
export type Purpose = "vision" | "classify" | "grounded" | "translate" | "summarize";

export interface JsonRequest<T> {
  tier: ModelTier;
  purpose: Purpose;
  system: SystemBlock[];
  user: ContentPart[];
  schema: ZodType<T>;
  maxTokens: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface JsonResult<T> {
  data: T;
  usage: Usage;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>>;
}

/** Lỗi tạm thời / hạ tầng: chuyển sang provider dự phòng, cuối cùng báo "high traffic" cho khách. */
export class ProviderUnavailableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/** Model từ chối trả lời (refusal / bộ lọc an toàn). Không thử lại; coi như không có câu trả lời. */
export class LlmRefusalError extends Error {
  constructor(message = "refused") {
    super(message);
    this.name = "LlmRefusalError";
  }
}

/** Đầu ra không đúng schema. */
export class LlmBadOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmBadOutputError";
  }
}
