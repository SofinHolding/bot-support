/**
 * Tìm kiếm trong vault khi trả lời khách (trang Notion "Xây dựng bộ nhớ LLM" mục 7):
 *   nhánh vector (embedQuery, RETRIEVAL_QUERY) + nhánh chữ (tsvector trên chữ gốc, title/keywords và các trường canonical_*)
 *   -> gộp RRF theo chunk_id (k = 60) -> còn chỗ thì mở rộng 1 hop theo `related` -> lọc trạng thái lần cuối qua vault_notes.
 * Chỉ chunk của note confirmed/provisional nằm trong chỉ mục; note chờ duyệt / bị thay thế không bao giờ được trả về.
 * Chunk vault mang id "v:<note_id>#<n>" để không lẫn với đoạn của tài liệu cũ (kb_chunks) khi hai nguồn cùng chạy.
 * Chưa có bước rerank riêng: select-answer của router chọn trong vài ứng viên này (mục "Việc còn phải chọn" của Notion).
 */
import { activeEmbedder, type Embedder } from "../core/embedding";
import { contentTokens } from "../core/knowledge";
import { sourceLangOf } from "../core/language";
import { normalize } from "../core/text";
import type { KnowledgeHit, KnowledgePort } from "../core/ports";
import type { VaultChunkHit, VaultRepo } from "../db/repo-vault";
import { embedQuery } from "./embed-roles";
import { relatedTarget, SERVABLE } from "./note";

export const VAULT_PREFIX = "v:";
export const RRF_K = 60;
const BRANCH_LIMIT = 20;

/** Reciprocal Rank Fusion: điểm = tổng 1/(k + hạng) trên các danh sách; mục có trong nhiều danh sách lên cao. */
export function rrf<T>(lists: T[][], key: (x: T) => string, k = RRF_K): { item: T; score: number }[] {
  const acc = new Map<string, { item: T; score: number }>();
  for (const list of lists)
    list.forEach((x, rank) => {
      const id = key(x);
      const cur = acc.get(id) ?? { item: x, score: 0 };
      cur.score += 1 / (k + rank + 1);
      acc.set(id, cur);
    });
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

export function tsQueryOf(query: string): string {
  return [...new Set(contentTokens(query))]
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 1)
    .slice(0, 12)
    .join(" | ");
}

export class VaultKnowledge implements KnowledgePort {
  constructor(private readonly repo: VaultRepo, private readonly embedder: Embedder) {}

  private hit(c: VaultChunkHit, score: number): KnowledgeHit {
    return { chunkId: `${VAULT_PREFIX}${c.chunkId}`, docSlug: `vault/${c.noteId}`, heading: c.heading, text: c.text, lang: sourceLangOf(c.text, c.langSource === "mixed" ? null : c.langSource), score };
  }

  /** Lọc trạng thái lần cuối qua bản sao note (phòng chỉ mục chưa kịp cập nhật sau một lần duyệt). */
  private async servable(noteIds: string[]): Promise<Map<string, string[]>> {
    const rows = await this.repo.notesByIds([...new Set(noteIds)]);
    return new Map(rows.filter((r) => (SERVABLE as readonly string[]).includes(r.status)).map((r) => [r.id, ((r.meta.related as string[] | undefined) ?? []).map(relatedTarget)]));
  }

  async byIds(ids: string[]): Promise<KnowledgeHit[]> {
    const own = ids.filter((id) => id.startsWith(VAULT_PREFIX)).map((id) => id.slice(VAULT_PREFIX.length));
    const rows = await this.repo.chunksByIds(own);
    const ok = await this.servable(rows.map((r) => r.noteId));
    return rows.filter((r) => ok.has(r.noteId)).map((r) => this.hit(r, 1));
  }

  async search(query: string, k: number, queryLang?: string): Promise<KnowledgeHit[]> {
    const tokens = [...new Set(contentTokens(query))];
    const lexical = await this.repo.searchLexical(tsQueryOf(query), BRANCH_LIMIT);
    let vector: VaultChunkHit[] = [];
    try {
      const e = await embedQuery(this.embedder, [query]);
      vector = await this.repo.searchVector(e.vectors[0]!, e.model, BRANCH_LIMIT);
    } catch {
      /* dịch vụ embed lỗi: chỉ dùng nhánh chữ */
    }
    const cos = new Map(vector.map((v) => [v.chunkId, Math.max(0, v.score)]));
    const fused = rrf([vector, lexical], (x) => x.chunkId);
    // Điểm trả cho router cùng thang với tài liệu cũ (PgKnowledge): độ phủ từ khoá và/hoặc cosine. Thứ tự lấy theo RRF.
    const scoreOf = (c: VaultChunkHit) => {
      const text = ` ${normalize(`${c.heading} ${c.text}`)} `;
      const coverage = tokens.length ? tokens.filter((t) => text.includes(` ${t} `)).length / tokens.length : 0;
      const lexHit = lexical.some((l) => l.chunkId === c.chunkId);
      const cv = cos.get(c.chunkId);
      const lang = c.langSource === "mixed" ? undefined : c.langSource;
      if (cv === undefined) return Math.max(coverage, lexHit ? 0.5 : 0);
      if (queryLang && lang && queryLang !== lang) return cv; // khác ngôn ngữ: trùng từ khoá không phải bằng chứng
      return Math.max(0.6 * Math.max(coverage, lexHit ? 0.5 : 0) + 0.4 * cv, cv);
    };
    const ok = await this.servable(fused.map((f) => f.item.noteId));
    const picked: KnowledgeHit[] = [];
    const seenNotes = new Set<string>();
    for (const f of fused) {
      if (picked.length >= k) break;
      if (!ok.has(f.item.noteId)) continue;
      picked.push(this.hit(f.item, scoreOf(f.item)));
      seenNotes.add(f.item.noteId);
    }
    // 1 hop theo related (không đi quá 1 hop), chỉ khi còn chỗ trong ngân sách ứng viên
    if (picked.length < k && picked.length) {
      const parentScore = new Map<string, number>();
      for (const h of picked) {
        const noteId = h.docSlug.slice("vault/".length);
        for (const rel of ok.get(noteId) ?? []) if (!seenNotes.has(rel) && !parentScore.has(rel)) parentScore.set(rel, h.score);
      }
      const relOk = await this.servable([...parentScore.keys()]);
      for (const c of await this.repo.firstChunksOfNotes([...parentScore.keys()].filter((id) => relOk.has(id)))) {
        if (picked.length >= k) break;
        picked.push(this.hit(c, parentScore.get(c.noteId)! * 0.9));
      }
    }
    return picked;
  }
}

/**
 * Gộp tài liệu tri thức cũ (kb_chunks đã publish) với vault bằng RRF, để hai nguồn cùng dùng được trong lúc chuyển đổi.
 * byIds chuyển đúng nguồn theo tiền tố id.
 */
export class CompositeKnowledge implements KnowledgePort {
  constructor(private readonly legacy: KnowledgePort, private readonly vault: KnowledgePort) {}

  async search(query: string, k: number, queryLang?: string): Promise<KnowledgeHit[]> {
    const lists = await Promise.all([this.vault, this.legacy].map((s) => s.search(query, k, queryLang).catch(() => [] as KnowledgeHit[])));
    return rrf(lists, (h) => h.chunkId).slice(0, k).map((x) => x.item);
  }

  async byIds(ids: string[]): Promise<KnowledgeHit[]> {
    const mine = ids.filter((id) => id.startsWith(VAULT_PREFIX));
    const theirs = ids.filter((id) => !id.startsWith(VAULT_PREFIX));
    const [a, b] = await Promise.all([
      mine.length && this.vault.byIds ? this.vault.byIds(mine) : Promise.resolve([] as KnowledgeHit[]),
      theirs.length && this.legacy.byIds ? this.legacy.byIds(theirs) : Promise.resolve([] as KnowledgeHit[]),
    ]);
    const byId = new Map([...a, ...b].map((h) => [h.chunkId, h]));
    return ids.map((id) => byId.get(id)).filter((h): h is KnowledgeHit => !!h);
  }
}
