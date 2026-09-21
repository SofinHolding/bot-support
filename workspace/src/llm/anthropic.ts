/** Provider chính: SDK chính thức của Anthropic, structured output bằng zod, prompt caching cho khối system ổn định. */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LlmBadOutputError, LlmRefusalError, ProviderUnavailableError, type JsonRequest, type JsonResult, type LlmProvider, type ModelTier } from "./types";

export interface AnthropicConfig {
  apiKey?: string;
  baseURL?: string;
  models: Record<ModelTier, string>;
  timeoutMs?: number;
  /** cho test: truyền client giả */
  client?: Anthropic;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly cfg: AnthropicConfig) {
    this.client =
      cfg.client ??
      new Anthropic({
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
        timeout: cfg.timeoutMs ?? 30_000,
        maxRetries: 1, // retry nhanh ở SDK; phần còn lại do ProviderChain (dự phòng + circuit breaker)
      });
  }

  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const model = this.cfg.models[req.tier];
    const started = Date.now();
    try {
      const res = await this.client.messages.parse({
        model,
        max_tokens: req.maxTokens,
        system: req.system.map((b) => ({ type: "text" as const, text: b.text, ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}) })),
        messages: [
          {
            role: "user",
            content: req.user.map((p) =>
              p.type === "text"
                ? { type: "text" as const, text: p.text }
                : { type: "image" as const, source: { type: "base64" as const, media_type: p.mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: p.base64 } },
            ),
          },
        ],
        output_config: { format: zodOutputFormat(req.schema as never) },
      });
      if (res.stop_reason === "refusal") throw new LlmRefusalError("stop_reason=refusal");
      if (res.stop_reason === "max_tokens") throw new LlmBadOutputError("bị cắt do max_tokens");
      const parsed = res.parsed_output as T | null | undefined;
      if (parsed === null || parsed === undefined) throw new LlmBadOutputError("không parse được đầu ra theo schema");
      const u = res.usage;
      return {
        data: parsed,
        provider: this.name,
        model,
        latencyMs: Date.now() - started,
        usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
      };
    } catch (e) {
      throw mapError(e);
    }
  }
}

/** Lỗi hạ tầng -> ProviderUnavailableError (thử provider khác). Lỗi khác giữ nguyên. */
function mapError(e: unknown): unknown {
  if (e instanceof LlmRefusalError || e instanceof LlmBadOutputError) return e;
  if (e instanceof Anthropic.RateLimitError) {
    const ra = Number(e.headers?.get?.("retry-after"));
    return new ProviderUnavailableError("rate limited", Number.isFinite(ra) ? ra * 1000 : undefined);
  }
  if (e instanceof Anthropic.APIConnectionError) return new ProviderUnavailableError("connection error");
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderUnavailableError("credentials rejected");
  if (e instanceof Anthropic.NotFoundError) return new ProviderUnavailableError("model or endpoint not found");
  if (e instanceof Anthropic.APIError && (e.status === undefined || e.status >= 500 || e.status === 529)) return new ProviderUnavailableError(`server error ${e.status}`);
  if (e instanceof Anthropic.APIError) return new LlmBadOutputError(`API ${e.status}: ${e.message}`);
  return e;
}
