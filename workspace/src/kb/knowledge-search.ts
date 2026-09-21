import type { Embedder } from "../core/embedding";
import { contentTokens } from "../core/knowledge";
import type { KnowledgeHit, KnowledgePort } from "../core/ports";
import type { KbRepo } from "../db/repo-kb";

/** Tìm chunk trong tài liệu tri thức đã publish: kết hợp từ khoá (tsvector) và vector (pgvector). */
export class PgKnowledge implements KnowledgePort {
  constructor(private readonly kb: KbRepo, private readonly embedder: Embedder) {}

  async search(query: string, k: number): Promise<KnowledgeHit[]> {
    const tokens = [...new Set(contentTokens(query))];
    if (!tokens.length) return [];
    const tsQuery = tokens
      .map((t) => t.replace(/[^a-z0-9]/g, ""))
      .filter((t) => t.length > 1)
      .slice(0, 12)
      .join(" | ");
    let embedding: number[] | undefined;
    try {
      [embedding] = await this.embedder.embed([query]);
    } catch {
      embedding = undefined; // chỉ dùng từ khoá
    }
    const rows = await this.kb.searchChunks({ tsQuery, embedding, embeddingModel: this.embedder.version, limit: 20 });
    const scored = rows.map((r) => {
      const coverage = tokens.filter((t) => r.searchText.includes(t.replace(/\$/g, ""))).length / tokens.length;
      const cos = Math.max(0, r.vectorScore ?? 0);
      return { r, score: embedding ? 0.6 * coverage + 0.4 * cos : coverage };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ r, score }) => ({ chunkId: r.chunkId, docSlug: r.docSlug, heading: r.heading, text: r.text, url: r.url, score }));
  }
}
