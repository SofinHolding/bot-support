import type { Embedder } from "../core/embedding";
import { HashEmbedder } from "../core/embedding";
import { ProviderUnavailableError } from "./types";

/** Embedding qua endpoint tương thích OpenAI `/embeddings` (OpenAI, Voyage, TEI/bge-m3, Ollama...). */
export class HttpEmbedder implements Embedder {
  readonly version: string;
  constructor(private readonly cfg: { url: string; apiKey?: string; model: string; fetchImpl?: typeof fetch }) {
    this.version = `http:${cfg.model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const f = this.cfg.fetchImpl ?? fetch;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      let res: Response;
      try {
        res = await f(`${this.cfg.url.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
          body: JSON.stringify({ model: this.cfg.model, input: batch }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new ProviderUnavailableError("embedding connection error");
      }
      if (!res.ok) throw new ProviderUnavailableError(`embedding status ${res.status}`);
      const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      out.push(...[...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  }
}

export function createEmbedder(cfg: { EMBEDDING_URL?: string; EMBEDDING_MODEL?: string; EMBEDDING_API_KEY?: string }): Embedder {
  if (cfg.EMBEDDING_URL && cfg.EMBEDDING_MODEL) return new HttpEmbedder({ url: cfg.EMBEDDING_URL, model: cfg.EMBEDDING_MODEL, apiKey: cfg.EMBEDDING_API_KEY });
  return new HashEmbedder();
}
