import type { ZodType } from "zod";

export type ContentPart = { type: "text"; text: string } | { type: "image"; mime: string; base64: string };

export interface SystemBlock {
  text: string;
  /** Khối ổn định giữa các lượt: bật prompt caching để lượt sau gần như miễn phí. */
  cache?: boolean;
}

/** "intake": tầng riêng cho trợ lý nạp nội dung mới (Admin Web → Nạp nội dung mới) — admin có thể trỏ sang model khác hẳn
 * model nhanh/mạnh đang phục vụ khách để tách quota; chưa cấu hình thì tự dùng lại model nhanh (xem GatewayConfig.resolve). */
export type ModelTier = "fast" | "strong" | "intake";
export type Purpose = "vision" | "understand" | "select" | "verify" | "review" | "classify" | "grounded" | "translate" | "summarize" | "intake";

export interface JsonRequest<T> {
  tier: ModelTier;
  purpose: Purpose;
  system: SystemBlock[];
  user: ContentPart[];
  schema: ZodType<T>;
  maxTokens: number;
  /** Thời gian chờ tối đa của lời gọi này (ms). Không có = mặc định của provider (30 giây). Dùng cho câu khẩn: chờ ngắn rồi dùng phương án dự phòng. */
  timeoutMs?: number;
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
