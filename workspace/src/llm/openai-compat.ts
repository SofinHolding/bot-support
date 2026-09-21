/**
 * Provider dự phòng: endpoint tương thích OpenAI (`/chat/completions`) — dùng cho gateway hiện có (9router...), OpenRouter,
 * Ollama, vLLM... Đây là NHÀ CUNG CẤP KHÁC, không phải cách gọi Claude.
 */
import { z, type ZodType } from "zod";
import { LlmBadOutputError, ProviderUnavailableError, type JsonRequest, type JsonResult, type LlmProvider, type ModelTier } from "./types";

export interface OpenAICompatConfig {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  models: Record<ModelTier, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatProvider implements LlmProvider {
  readonly name: string;
  private readonly f: typeof fetch;

  constructor(private readonly cfg: OpenAICompatConfig) {
    this.name = cfg.name ?? "openai-compat";
    this.f = cfg.fetchImpl ?? fetch;
  }

  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const model = this.cfg.models[req.tier];
    const started = Date.now();
    const schemaHint = safeJsonSchema(req.schema);
    const system = req.system.map((b) => b.text).join("\n\n") + `\n\nRespond with ONLY a JSON object that matches this JSON Schema, no prose:\n${schemaHint}`;
    const userContent = req.user.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.base64}` } }));

    let res: Response;
    try {
      res = await this.f(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
      });
    } catch {
      throw new ProviderUnavailableError("connection error");
    }
    if (res.status === 429 || res.status >= 500) throw new ProviderUnavailableError(`status ${res.status}`);
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new ProviderUnavailableError(`status ${res.status}`);
    if (!res.ok) throw new LlmBadOutputError(`status ${res.status}`);

    const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = body.choices?.[0]?.message?.content ?? "";
    let data: T;
    try {
      data = req.schema.parse(JSON.parse(extractJson(content)));
    } catch (e) {
      throw new LlmBadOutputError(`đầu ra không hợp lệ: ${(e as Error).message}`);
    }
    return {
      data,
      provider: this.name,
      model,
      latencyMs: Date.now() - started,
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 },
    };
  }
}

function extractJson(s: string): string {
  const t = s.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) return fence[1]!.trim();
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  return i >= 0 && j > i ? t.slice(i, j + 1) : t;
}

function safeJsonSchema(schema: ZodType): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema));
  } catch {
    return "{}";
  }
}
