import type { EmbedOptions, Embedder } from "../core/embedding";
import { HashEmbedder } from "../core/embedding";
import { ProviderUnavailableError } from "./types";

/** TEI (text-embeddings-inference) mặc định từ chối lô > 32 đoạn; 16 đoạn/lần cũng giữ độ trễ mỗi lời gọi ổn trên CPU. */
const BATCH = 16;
const RETRIES = 2;

/** Embedding qua endpoint tương thích OpenAI `/embeddings` (OpenAI, Voyage, TEI/bge-m3, Ollama...). */
export class HttpEmbedder implements Embedder {
  readonly version: string;
  constructor(private readonly cfg: { url: string; apiKey?: string; model: string; dimensions?: number; taskType?: boolean; fetchImpl?: typeof fetch }) {
    // số chiều nằm trong định danh: cùng model nhưng khác số chiều là hai không gian vector khác nhau
    this.version = `http:${cfg.model}${cfg.dimensions ? `@${cfg.dimensions}` : ""}`;
  }

  async embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
    const f = this.cfg.fetchImpl ?? fetch;
    // task_type chỉ gửi khi dịch vụ nhận tham số này (cấu hình embedding.task_type); gateway chỉ tương thích OpenAI thì bỏ qua
    const task = this.cfg.taskType && opts?.taskType ? { task_type: opts.taskType } : {};
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
            body: JSON.stringify({ model: this.cfg.model, input: batch, ...(this.cfg.dimensions ? { dimensions: this.cfg.dimensions } : {}), ...task }),
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
  external: { url: string; apiKey?: string; model: string; dimensions?: number; taskType?: boolean } | null;
}

/**
 * Embedding theo LỰA CHỌN: đúng MỘT model cho toàn bộ kho lẫn câu hỏi. Không có dự phòng ngầm — chọn "API ngoài" thì
 * MỌI lượt đều gọi API thật, lỗi thì báo lỗi thẳng (không âm thầm đổi sang model khác, không tự khoá/tự chuyển).
 *
 * Đổi 2026-09-30 theo yêu cầu rõ ràng của chủ dự án: trước đây có cơ chế tự chuyển sang model cục bộ + tự khoá khi API
 * lỗi — đã bỏ hẳn. Đánh đổi đã trao đổi và được chấp nhận: cổng API ngoài đang dùng có tỷ lệ lỗi ngẫu nhiên thật
 * ~25%/lượt (đo được cùng ngày); những lượt gặp đúng lúc lỗi giờ THẤT BẠI THẬT (ném lỗi lên trên) thay vì được cứu
 * bằng model cục bộ. Nơi gọi (vd `vault/search.ts`) tự quyết định phải làm gì khi embed lỗi — ví dụ nhánh tìm kiếm
 * chữ (tsvector) vẫn chạy được, chỉ mất phần tìm theo nghĩa cho đúng lượt đó.
 * Chọn "cục bộ" vẫn dùng bình thường (không gọi mạng) — đây không phải "dự phòng", mà là lựa chọn tường minh của admin.
 */
export class SelectedEmbedder implements Embedder {
  private external: Embedder | null = null;
  private externalKey = "";
  private lastActive: Embedder;

  constructor(
    private readonly getSelection: () => Promise<EmbeddingSelection>,
    readonly local: Embedder,
    private readonly opts: { fetchImpl?: typeof fetch; log?: (msg: string) => void } = {},
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
    const key = `${cfg.url}|${cfg.model}|${cfg.dimensions ?? ""}|${cfg.apiKey ? "k" : ""}|${cfg.taskType ? "t" : ""}`;
    if (key !== this.externalKey) {
      this.externalKey = key;
      this.external = new HttpEmbedder({ url: cfg.url, apiKey: cfg.apiKey, model: cfg.model, dimensions: cfg.dimensions, taskType: cfg.taskType, fetchImpl: this.opts.fetchImpl });
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
    return (this.lastActive = ext ?? this.local);
  }

  async embedTagged(texts: string[], opts?: EmbedOptions): Promise<{ vectors: number[][]; model: string }> {
    const e = await this.active();
    if (e === this.local) return { vectors: await this.local.embed(texts, opts), model: this.local.version };
    try {
      const vectors = await e.embed(texts, opts);
      return { vectors, model: e.version };
    } catch (err) {
      this.opts.log?.(`embedding API (${e.version}) lỗi: ${(err as Error).message} -> không dự phòng, báo lỗi thẳng`);
      throw err;
    }
  }

  async embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
    return (await this.embedTagged(texts, opts)).vectors;
  }
}

export function createEmbedder(cfg: { EMBEDDING_URL?: string; EMBEDDING_MODEL?: string; EMBEDDING_API_KEY?: string }): Embedder {
  if (cfg.EMBEDDING_URL && cfg.EMBEDDING_MODEL) return new HttpEmbedder({ url: cfg.EMBEDDING_URL, model: cfg.EMBEDDING_MODEL, apiKey: cfg.EMBEDDING_API_KEY });
  return new HashEmbedder();
}
