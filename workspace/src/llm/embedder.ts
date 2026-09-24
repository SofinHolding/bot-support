import type { Embedder } from "../core/embedding";
import { HashEmbedder } from "../core/embedding";
import { ProviderUnavailableError } from "./types";

/** TEI (text-embeddings-inference) mặc định từ chối lô > 32 đoạn; 16 đoạn/lần cũng giữ độ trễ mỗi lời gọi ổn trên CPU. */
const BATCH = 16;
const RETRIES = 2;

/** Embedding qua endpoint tương thích OpenAI `/embeddings` (OpenAI, Voyage, TEI/bge-m3, Ollama...). */
export class HttpEmbedder implements Embedder {
  readonly version: string;
  constructor(private readonly cfg: { url: string; apiKey?: string; model: string; dimensions?: number; fetchImpl?: typeof fetch }) {
    // số chiều nằm trong định danh: cùng model nhưng khác số chiều là hai không gian vector khác nhau
    this.version = `http:${cfg.model}${cfg.dimensions ? `@${cfg.dimensions}` : ""}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const f = this.cfg.fetchImpl ?? fetch;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      // API ngoài qua gateway (vd beeknoee -> Google) có lỗi rải rác không phụ thuộc nội dung: thử lại vài lần trước khi coi là lỗi
      let lastErr = "";
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, (lastErr.startsWith("embedding status 429") || lastErr.startsWith("embedding status 5") ? 2000 : 400) * attempt));
        let res: Response;
        try {
          res = await f(`${this.cfg.url.replace(/\/$/, "")}/embeddings`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
            body: JSON.stringify({ model: this.cfg.model, input: batch, ...(this.cfg.dimensions ? { dimensions: this.cfg.dimensions } : {}) }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch {
          lastErr = "embedding connection error";
          continue;
        }
        if (res.status === 401 || res.status === 403) throw new ProviderUnavailableError(`embedding status ${res.status}`); // sai khoá: thử lại vô ích
        if (!res.ok) {
          // thân phản hồi của gateway (không chứa khoá) giúp admin biết API từ chối vì gì: giới hạn tốc độ, lô quá dài, model sai...
          const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
          lastErr = `embedding status ${res.status}${body ? `: ${body}` : ""}`;
          continue;
        }
        const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
        out.push(...[...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
        lastErr = "";
        break;
      }
      if (lastErr) throw new ProviderUnavailableError(lastErr);
    }
    return out;
  }
}

export type EmbeddingProvider = "local" | "external";

/** Lựa chọn của người vận hành (Admin Web → Cấu hình → Embedding), đọc lại từ DB theo TTL ngắn ở mọi tiến trình. */
export interface EmbeddingSelection {
  provider: EmbeddingProvider;
  /** null = chưa cấu hình URL/model API ngoài (chỉ dùng được cục bộ) */
  external: { url: string; apiKey?: string; model: string; dimensions?: number } | null;
}

/**
 * Embedder theo LỰA CHỌN: đúng MỘT model cho toàn bộ kho lẫn câu hỏi. Không có dự phòng ngầm theo từng lời gọi —
 * vector của hai model không so sánh được, nên kho chỉ được đánh chỉ mục cho model đang chọn (kb_chunk_embeddings phân
 * vùng theo model; model kia có vector thì để nguyên, không dùng).
 * API ngoài lỗi hẳn (HttpEmbedder đã hết số lần thử lại) -> gọi `onExternalFailure` MỘT lần: nơi nối dây (app.ts) chuyển hẳn
 * lựa chọn sang cục bộ trong DB, KHOÁ lựa chọn API, xếp việc đánh chỉ mục lại toàn bộ nội dung đã publish và ghi audit;
 * lời gọi hiện tại được phục vụ bằng model cục bộ ngay (đúng không gian với bộ chỉ mục cục bộ). Quay lại API chỉ khi admin
 * kiểm tra và mở khoá thủ công trên Admin Web.
 */
export class SelectedEmbedder implements Embedder {
  private external: Embedder | null = null;
  private externalKey = "";
  private lastActive: Embedder;
  private switching: Promise<void> | null = null;
  /** cấu hình API đã gây sự cố gần nhất: các lời gọi đang bay cùng lỗi không gọi hook lặp lại */
  private failedKey = "";

  constructor(
    private readonly getSelection: () => Promise<EmbeddingSelection>,
    readonly local: Embedder,
    private readonly opts: { onExternalFailure?: (error: string) => Promise<void>; fetchImpl?: typeof fetch; log?: (msg: string) => void } = {},
  ) {
    this.lastActive = local;
  }

  /** Model đang dùng theo lần embed / lần active() gần nhất. */
  get version(): string {
    return this.lastActive.version;
  }

  private resolveExternal(sel: EmbeddingSelection): Embedder | null {
    const cfg = sel.external;
    if (!cfg) return (this.external = null);
    const key = `${cfg.url}|${cfg.model}|${cfg.dimensions ?? ""}|${cfg.apiKey ? "k" : ""}`;
    if (key !== this.externalKey) {
      this.externalKey = key;
      this.external = new HttpEmbedder({ url: cfg.url, apiKey: cfg.apiKey, model: cfg.model, dimensions: cfg.dimensions, fetchImpl: this.opts.fetchImpl });
    }
    return this.external;
  }

  /** Model API ngoài theo cấu hình hiện tại (dù đang chọn hay không), để hiển thị/kiểm tra. */
  async externalEmbedder(): Promise<Embedder | null> {
    const sel = await this.getSelection().catch(() => null);
    return sel ? this.resolveExternal(sel) : null;
  }

  /** Embedder sẽ được dùng ngay bây giờ theo lựa chọn (không gọi mạng). Lựa chọn đọc lỗi -> cục bộ. */
  async active(): Promise<Embedder> {
    const sel = await this.getSelection().catch((): EmbeddingSelection => ({ provider: "local", external: null }));
    const ext = sel.provider === "external" ? this.resolveExternal(sel) : null;
    // Đang ở cục bộ mà lựa chọn lại là API => admin đã mở khoá và chọn lại: sự cố kế tiếp phải khoá lại được
    if (ext && this.lastActive === this.local) this.failedKey = "";
    return (this.lastActive = ext ?? this.local);
  }

  async embedTagged(texts: string[]): Promise<{ vectors: number[][]; model: string }> {
    const e = await this.active();
    if (e === this.local) return { vectors: await this.local.embed(texts), model: this.local.version };
    try {
      const vectors = await e.embed(texts);
      return { vectors, model: e.version };
    } catch (err) {
      const msg = (err as Error).message;
      if (this.failedKey !== this.externalKey) {
        this.failedKey = this.externalKey;
        this.opts.log?.(`embedding API (${e.version}) lỗi: ${msg} -> chuyển hẳn sang cục bộ (${this.local.version}) và khoá lựa chọn API`);
        this.switching = (this.opts.onExternalFailure?.(msg) ?? Promise.resolve()).catch(() => undefined).finally(() => (this.switching = null));
      }
      await this.switching; // các lời gọi đang bay cùng lỗi chờ chung một lần chuyển
      this.lastActive = this.local;
      return { vectors: await this.local.embed(texts), model: this.local.version };
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    return (await this.embedTagged(texts)).vectors;
  }
}

export function createEmbedder(cfg: { EMBEDDING_URL?: string; EMBEDDING_MODEL?: string; EMBEDDING_API_KEY?: string }): Embedder {
  if (cfg.EMBEDDING_URL && cfg.EMBEDDING_MODEL) return new HttpEmbedder({ url: cfg.EMBEDDING_URL, model: cfg.EMBEDDING_MODEL, apiKey: cfg.EMBEDDING_API_KEY });
  return new HashEmbedder();
}
