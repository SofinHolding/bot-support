import { embedTagged, type Embedder } from "../core/embedding";
import { contentTokens } from "../core/knowledge";
import { sourceLangOf } from "../core/language";
import type { KnowledgeHit, KnowledgePort } from "../core/ports";
import type { KbRepo } from "../db/repo-kb";

/** Tìm chunk trong tài liệu tri thức đã publish: kết hợp từ khoá (tsvector) và vector (pgvector). */
export class PgKnowledge implements KnowledgePort {
  constructor(private readonly kb: KbRepo, private readonly embedder: Embedder) {}

  async byIds(ids: string[]): Promise<KnowledgeHit[]> {
    const want = new Set(ids);
    return (await this.kb.listPublishedChunks()).filter((c) => want.has(c.chunkId)).map((c) => ({ chunkId: c.chunkId, docSlug: c.docSlug, heading: c.heading, text: c.text, url: c.url, lang: sourceLangOf(c.text, c.lang), score: 1 }));
  }

  async search(query: string, k: number, queryLang?: string): Promise<KnowledgeHit[]> {
    const tokens = [...new Set(contentTokens(query))];
    if (!tokens.length) return [];
    const tsQuery = tokens
      .map((t) => t.replace(/[^a-z0-9]/g, ""))
      .filter((t) => t.length > 1)
      .slice(0, 12)
      .join(" | ");
    let embedding: number[] | undefined;
    let embeddingModel = this.embedder.version;
    try {
      const t = await embedTagged(this.embedder, [query]); // model THẬT đã tạo vector (có thể là dự phòng): tìm trên bộ vector của đúng model đó
      embedding = t.vectors[0];
      embeddingModel = t.model;
    } catch {
      embedding = undefined; // chỉ dùng từ khoá
    }
    const rows = await this.kb.searchChunks({ tsQuery, embedding, embeddingModel, limit: 20 });
    const scored = rows.map((r) => {
      const lang = sourceLangOf(r.text, r.lang);
      const coverage = tokens.filter((t) => r.searchText.includes(t.replace(/\$/g, ""))).length / tokens.length;
      const cos = Math.max(0, r.vectorScore ?? 0);
      // Truy vấn và đoạn khác ngôn ngữ (vd hỏi tiếng Anh, tài liệu tiếng Việt): trùng từ khoá gần như không có nghĩa và công thức
      // 0,6·phủ + 0,4·cos chặn điểm ở ~0,4·cos nên luôn rớt dưới ngưỡng. Dùng điểm vector; độ chính xác do bước LLM xác nhận đảm bảo.
      const cross = !!queryLang && queryLang !== lang;
      const score = !embedding ? coverage : cross ? cos : 0.6 * coverage + 0.4 * cos;
      return { r, lang, score };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ r, lang, score }) => ({ chunkId: r.chunkId, docSlug: r.docSlug, heading: r.heading, text: r.text, url: r.url, lang, score }));
  }
}
