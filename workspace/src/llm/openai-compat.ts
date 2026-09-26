/**
 * Provider chính: endpoint tương thích OpenAI (`/chat/completions`) — 9router, OpenRouter, Ollama, vLLM...
 * Model (nhanh/mạnh) do gateway định tuyến; bot chỉ gửi tên model đã chọn trong Admin Web.
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

/** Nguồn cấu hình: giá trị cố định, hoặc hàm đọc lại mỗi lần gọi (cấu hình chỉnh được từ Admin Web). null = chưa cấu hình. */
export type OpenAICompatSource = OpenAICompatConfig | (() => Promise<OpenAICompatConfig | null>);

export class OpenAICompatProvider implements LlmProvider {
  readonly name: string;

  constructor(private readonly source: OpenAICompatSource, name?: string) {
    this.name = name ?? (typeof source === "function" ? "openai-compat" : (source.name ?? "openai-compat"));
  }

  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const cfg = typeof this.source === "function" ? await this.source() : this.source;
    if (!cfg) throw new ProviderUnavailableError("gateway LLM chưa được cấu hình");
    const f = cfg.fetchImpl ?? fetch;
    const model = cfg.models[req.tier];
    const started = Date.now();
    const schemaHint = safeJsonSchema(req.schema);
    const system = req.system.map((b) => b.text).join("\n\n") + `\n\nRespond with ONLY a JSON object that matches this JSON Schema, no prose:\n${schemaHint}`;
    const userContent = req.user.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.base64}` } }));

    let res: Response;
    try {
      res = await f(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? cfg.timeoutMs ?? 30_000),
      });
    } catch {
      throw new ProviderUnavailableError("connection error");
    }
    if (!res.ok) {
      const detail = `status ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
      if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 404) throw new ProviderUnavailableError(detail);
      throw new LlmBadOutputError(detail);
    }

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
