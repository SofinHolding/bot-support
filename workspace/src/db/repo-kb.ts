/** Truy cập kho tri thức: tài liệu + phiên bản, template đã publish, chunk vector, bản dịch, cache embedding, eval, settings. */
import type { Template } from "../domain/types";
import { iso, num, numOrNull, type Db } from "./db";
import type { PairDecision, PairDecisionKind, PairReview } from "../kb/pair-decisions";

export type VersionStatus = "draft" | "pending_approval" | "published" | "archived" | "rejected";

export interface DocumentRow {
  slug: string;
  title: string;
  kind: "templates" | "knowledge" | "guide" | "items";
  created_at: Date;
  published_version: number | null;
  latest_version: number;
}

/** Một cặp nội dung ĐÃ PUBLISH mà bước kiểm tra lúc publish cờ là xung đột (xem migrations/005 + KbRepo.syncConflicts). */
export interface ConflictRow {
  id: number;
  pairKey: string;
  a: { kind: "template" | "chunk"; id: string; doc: string; title: string };
  b: { kind: "template" | "chunk"; id: string; doc: string; title: string };
  score: number;
  signals: string[];
  narrow: { templateId: string; phrase: string } | null;
  verdict: string | null;
  reason: string | null;
  suggestion: string | null;
  createdAt: Date;
}

export interface ConflictInput {
  a: { kind: "template" | "chunk"; id: string; doc: string; title: string };
  b: { kind: "template" | "chunk"; id: string; doc: string; title: string };
  score: number;
  signals: string[];
  narrow?: { templateId: string; phrase: string } | null;
  verdict?: string | null;
  reason?: string | null;
  suggestion?: string | null;
}

function mapConflictRow(x: Record<string, unknown>): ConflictRow {
  return {
    id: num(x.id),
    pairKey: String(x.pair_key),
    a: { kind: x.a_kind as "template" | "chunk", id: String(x.a_id), doc: String(x.a_doc), title: String(x.a_title) },
    b: { kind: x.b_kind as "template" | "chunk", id: String(x.b_id), doc: String(x.b_doc), title: String(x.b_title) },
    score: Number(x.score),
    signals: (x.signals as string[] | null) ?? [],
    narrow: (x.narrow as { templateId: string; phrase: string } | null) ?? null,
    verdict: (x.verdict as string | null) ?? null,
    reason: (x.reason as string | null) ?? null,
    suggestion: (x.suggestion as string | null) ?? null,
    createdAt: new Date(String(x.created_at)),
  };
}

export interface VersionRow {
  id: number;
  slug: string;
  version: number;
  source_md: string;
  status: VersionStatus;
  requires_second_approval: boolean;
  author: string | null;
  approved_by: string | null;
  report: unknown;
  created_at: Date;
  published_at: Date | null;
}

const mapVersion = (r: Record<string, unknown>): VersionRow => ({ ...(r as unknown as VersionRow), id: num(r.id), version: num(r.version) });

/** Đoạn tài liệu đang trong thời gian hiệu lực (metadata valid_from / valid_until, YYYY-MM-DD, theo ngày UTC). */
const ACTIVE_CHUNK = `(c.metadata->>'valid_from' IS NULL OR c.metadata->>'valid_from' <= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
  AND (c.metadata->>'valid_until' IS NULL OR c.metadata->>'valid_until' >= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'))`;

export interface ChunkInsert {
  index: number;
  heading: string;
  text: string;
  url?: string;
  searchText: string;
  hash: string;
  lang?: string;
  valid?: { from?: string; until?: string };
  embedding?: number[];
  embeddingModel?: string;
}

export interface ChunkHit {
  chunkId: string;
  docSlug: string;
  heading: string;
  text: string;
  url?: string;
  lang?: string;
  searchText: string;
  vectorScore: number | null;
  lexicalRank: number;
}

const vecLiteral = (v: number[]) => `[${v.map((x) => Number(x.toFixed(6))).join(",")}]`;

export function kbRepo(db: Db) {
  return {
    // ---- Tài liệu và phiên bản ----
    async upsertDocument(slug: string, title: string, kind: "templates" | "knowledge" | "guide" | "items") {
      await db.query("INSERT INTO kb_documents (slug, title, kind) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title", [slug, title, kind]);
    },
    async listDocuments(): Promise<DocumentRow[]> {
      const r = await db.query(
        `SELECT d.slug, d.title, d.kind, d.created_at,
                (SELECT version FROM kb_document_versions v WHERE v.slug = d.slug AND v.status = 'published') AS published_version,
                COALESCE((SELECT max(version) FROM kb_document_versions v WHERE v.slug = d.slug), 0) AS latest_version
         FROM kb_documents d ORDER BY d.kind, d.slug`,
      );
      return r.rows.map((x) => ({ ...(x as unknown as DocumentRow), published_version: numOrNull(x.published_version), latest_version: num(x.latest_version) }));
    },
    async getDocument(slug: string) {
      const r = await db.query("SELECT * FROM kb_documents WHERE slug = $1", [slug]);
      return r.rows[0] as { slug: string; title: string; kind: "templates" | "knowledge" | "guide" | "items" } | undefined;
    },
    /** Xoá hẳn tài liệu + mọi phiên bản (cascade xoá templates/kb_chunks của từng phiên bản). Gọi sau khi kb/service.ts đã kiểm tra chưa từng publish. */
    async deleteDocument(slug: string) {
      await db.query("DELETE FROM kb_document_versions WHERE slug = $1", [slug]);
      await db.query("DELETE FROM kb_documents WHERE slug = $1", [slug]);
    },
    async listVersions(slug: string): Promise<VersionRow[]> {
      const r = await db.query("SELECT * FROM kb_document_versions WHERE slug = $1 ORDER BY version DESC", [slug]);
      return r.rows.map(mapVersion);
    },
    async getVersion(id: number): Promise<VersionRow | null> {
      const r = await db.query("SELECT * FROM kb_document_versions WHERE id = $1", [id]);
      return r.rows[0] ? mapVersion(r.rows[0]) : null;
    },
    async getPublished(slug: string): Promise<VersionRow | null> {
      const r = await db.query("SELECT * FROM kb_document_versions WHERE slug = $1 AND status = 'published'", [slug]);
      return r.rows[0] ? mapVersion(r.rows[0]) : null;
    },
    async createVersion(v: { slug: string; sourceMd: string; status: VersionStatus; author: string | null; report: unknown; requiresSecondApproval: boolean }): Promise<VersionRow> {
      const r = await db.query(
        `INSERT INTO kb_document_versions (slug, version, source_md, status, author, report, requires_second_approval)
         VALUES ($1, COALESCE((SELECT max(version) FROM kb_document_versions WHERE slug = $1), 0) + 1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
        [v.slug, v.sourceMd, v.status, v.author, JSON.stringify(v.report ?? null), v.requiresSecondApproval],
      );
      return mapVersion(r.rows[0]!);
    },
    async updateVersion(id: number, p: { sourceMd?: string; status?: VersionStatus; report?: unknown; approvedBy?: string | null; requiresSecondApproval?: boolean }) {
      await db.query(
        `UPDATE kb_document_versions SET source_md = COALESCE($2, source_md), status = COALESCE($3, status), report = COALESCE($4::jsonb, report),
           approved_by = COALESCE($5, approved_by), requires_second_approval = COALESCE($6, requires_second_approval) WHERE id = $1`,
        [id, p.sourceMd ?? null, p.status ?? null, p.report === undefined ? null : JSON.stringify(p.report), p.approvedBy ?? null, p.requiresSecondApproval ?? null],
      );
    },
    /** Kích hoạt một phiên bản: phiên bản đang publish cũ chuyển archived. Gọi trong transaction. */
    async activateVersion(id: number, slug: string, approvedBy: string | null, now: Date) {
      await db.query("UPDATE kb_document_versions SET status = 'archived' WHERE slug = $1 AND status = 'published' AND id <> $2", [slug, id]);
      await db.query("UPDATE kb_document_versions SET status = 'published', published_at = $2, approved_by = COALESCE($3, approved_by) WHERE id = $1", [id, iso(now), approvedBy]);
    },
    /**
     * Dọn dữ liệu (template/chunk + vector — kb_chunk_embeddings cascade theo kb_chunks) của MỌI phiên bản đã archived
     * của tài liệu này. `source_md` của các phiên bản đó vẫn giữ nguyên (xem lại được, Rollback vẫn dựng lại được
     * template/chunk từ đó) — chỉ xoá phần đã tách sẵn để đỡ tích luỹ rác. Gọi ngay sau `activateVersion` trong cùng transaction.
     */
    async clearArchivedContent(slug: string) {
      await db.query("DELETE FROM templates WHERE version_id IN (SELECT id FROM kb_document_versions WHERE slug = $1 AND status = 'archived')", [slug]);
      await db.query("DELETE FROM kb_chunks WHERE version_id IN (SELECT id FROM kb_document_versions WHERE slug = $1 AND status = 'archived')", [slug]);
    },

    // ---- Template ----
    async replaceTemplates(versionId: number, slug: string, templates: Template[]) {
      await db.query("DELETE FROM templates WHERE version_id = $1", [versionId]);
      for (const t of templates) {
        await db.query("INSERT INTO templates (id, version_id, doc_slug, definition) VALUES ($1,$2,$3,$4::jsonb)", [t.id, versionId, slug, JSON.stringify(t)]);
      }
    },
    /**
     * Template đang chạy. Mục hỏi đáp (tài liệu loại "items") THAY CHỖ template cũ cùng mã: khi một chủ đề mục hỏi đáp được
     * publish, template cũ trùng mã bị che (không nạp) — chuyển dần từng chủ đề, hoàn tác chủ đề thì template cũ tự hiện lại.
     */
    async loadPublishedTemplateRows(): Promise<{ docSlug: string; kind: string; template: Template }[]> {
      const r = await db.query<{ doc_slug: string; kind: string; definition: Template }>(
        "SELECT t.doc_slug, d.kind, t.definition FROM templates t JOIN kb_document_versions v ON v.id = t.version_id JOIN kb_documents d ON d.slug = t.doc_slug WHERE v.status = 'published' ORDER BY t.id",
      );
      const claimed = new Set(r.rows.filter((x) => x.kind === "items").map((x) => x.definition.id));
      return r.rows.filter((x) => x.kind === "items" || !claimed.has(x.definition.id)).map((x) => ({ docSlug: x.doc_slug, kind: x.kind, template: x.definition }));
    },
    async loadPublishedTemplates(): Promise<Template[]> {
      return (await this.loadPublishedTemplateRows()).map((x) => x.template);
    },

    // ---- Bản dịch ----
    async getTranslation(templateId: string, lang: string): Promise<{ text: string; source_hash: string; status: string } | null> {
      const r = await db.query<{ text: string; source_hash: string; status: string }>("SELECT text, source_hash, status FROM template_translations WHERE template_id = $1 AND lang = $2", [templateId, lang]);
      return r.rows[0] ?? null;
    },
    async saveTranslation(templateId: string, lang: string, text: string, sourceHash: string, origin: "llm" | "human", status: "pending" | "approved", approvedBy?: string) {
      await db.query(
        `INSERT INTO template_translations (template_id, lang, text, source_hash, origin, status, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (template_id, lang) DO UPDATE SET text = $3, source_hash = $4, origin = $5, status = $6, approved_by = $7, created_at = now()`,
        [templateId, lang, text, sourceHash, origin, status, approvedBy ?? null],
      );
    },
    async listTranslations(status?: string) {
      const r = await db.query("SELECT * FROM template_translations WHERE $1::text IS NULL OR status = $1 ORDER BY created_at DESC LIMIT 500", [status ?? null]);
      return r.rows as { template_id: string; lang: string; text: string; status: string; origin: string; source_hash: string }[];
    },
    async approveTranslation(templateId: string, lang: string, by: string, text?: string) {
      await db.query("UPDATE template_translations SET status = 'approved', approved_by = $3, text = COALESCE($4, text), origin = CASE WHEN $4::text IS NULL THEN origin ELSE 'human' END WHERE template_id = $1 AND lang = $2", [templateId, lang, by, text ?? null]);
    },

    // ---- Chunk tri thức ----
    async replaceChunks(versionId: number, slug: string, chunks: ChunkInsert[]) {
      await db.query("DELETE FROM kb_chunks WHERE version_id = $1", [versionId]);
      for (const c of chunks) {
        await db.query(
          `INSERT INTO kb_chunks (version_id, doc_slug, chunk_index, chunk_hash, heading, text, url, search_text, tsv, embedding, embedding_model, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_tsvector('simple', $8), $9::vector, $10, $11::jsonb)`,
          [versionId, slug, c.index, c.hash, c.heading, c.text, c.url ?? null, c.searchText, c.embedding ? vecLiteral(c.embedding) : null, c.embeddingModel ?? null, JSON.stringify({ ...(c.lang ? { lang: c.lang } : {}), ...(c.valid?.from ? { valid_from: c.valid.from } : {}), ...(c.valid?.until ? { valid_until: c.valid.until } : {}) })],
        );
      }
      // bảng vector theo model (kb_chunks.embedding chỉ còn là bản sao của model lúc publish)
      await db.query(
        `INSERT INTO kb_chunk_embeddings (chunk_id, model, embedding)
         SELECT id, embedding_model, embedding FROM kb_chunks WHERE version_id = $1 AND embedding IS NOT NULL AND embedding_model IS NOT NULL
         ON CONFLICT (chunk_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [versionId],
      );
    },
    /** Tìm chunk trong các tài liệu đang publish: gộp kết quả từ khoá (tsvector) và vector (pgvector). */
    async searchChunks(opts: { tsQuery: string; embedding?: number[]; embeddingModel?: string; limit: number }): Promise<ChunkHit[]> {
      const lex = opts.tsQuery
        ? await db.query(
            `SELECT c.id, c.doc_slug, c.heading, c.text, c.url, c.search_text, c.metadata->>'lang' AS lang, ts_rank(c.tsv, to_tsquery('simple', $1))::float8 AS rank
             FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id
             WHERE v.status = 'published' AND c.tsv @@ to_tsquery('simple', $1) AND ${ACTIVE_CHUNK} ORDER BY rank DESC LIMIT $2`,
            [opts.tsQuery, opts.limit],
          )
        : { rows: [] as Record<string, unknown>[] };
      const vec =
        opts.embedding && opts.embeddingModel
          ? await db.query(
              `SELECT c.id, c.doc_slug, c.heading, c.text, c.url, c.search_text, c.metadata->>'lang' AS lang, (1 - (e.embedding <=> $1::vector))::float8 AS sim
               FROM kb_chunk_embeddings e JOIN kb_chunks c ON c.id = e.chunk_id JOIN kb_document_versions v ON v.id = c.version_id
               WHERE v.status = 'published' AND e.model = $2 AND ${ACTIVE_CHUNK}
               ORDER BY e.embedding <=> $1::vector LIMIT $3`,
              [vecLiteral(opts.embedding), opts.embeddingModel, opts.limit],
            )
          : { rows: [] as Record<string, unknown>[] };
      const byId = new Map<string, ChunkHit>();
      const put = (x: Record<string, unknown>, lexicalRank: number, vectorScore: number | null) => {
        const id = String(x.id);
        const cur = byId.get(id);
        if (cur) {
          cur.lexicalRank = Math.max(cur.lexicalRank, lexicalRank);
          if (vectorScore !== null) cur.vectorScore = vectorScore;
        } else byId.set(id, { chunkId: id, docSlug: String(x.doc_slug), heading: String(x.heading), text: String(x.text), url: (x.url as string | null) ?? undefined, lang: (x.lang as string | null) ?? undefined, searchText: String(x.search_text), lexicalRank, vectorScore });
      };
      for (const x of lex.rows) put(x, num(x.rank), null);
      for (const x of vec.rows) put(x, 0, num(x.sim));
      return [...byId.values()];
    },
    /** Chunk đang publish mà chưa có vector của `embeddingModel` (model mới cấu hình, model dự phòng, hoặc lúc publish dịch vụ đang lỗi). */
    async listStaleChunks(embeddingModel: string, limit: number): Promise<{ id: string; heading: string; text: string }[]> {
      const r = await db.query<{ id: string; heading: string; text: string }>(
        `SELECT c.id::text AS id, c.heading, c.text FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id
         WHERE v.status = 'published' AND NOT EXISTS (SELECT 1 FROM kb_chunk_embeddings e WHERE e.chunk_id = c.id AND e.model = $1) ORDER BY c.id LIMIT $2`,
        [embeddingModel, limit],
      );
      return r.rows;
    },
    async setChunkEmbedding(id: string, embedding: number[], embeddingModel: string) {
      await db.query("INSERT INTO kb_chunk_embeddings (chunk_id, model, embedding) VALUES ($1::bigint, $2, $3::vector) ON CONFLICT (chunk_id, model) DO UPDATE SET embedding = EXCLUDED.embedding", [id, embeddingModel, vecLiteral(embedding)]);
    },
    /** Số chunk đang publish có vector theo từng model: Admin Web thấy kho đã được đánh chỉ mục đủ cho model chính lẫn dự phòng chưa. */
    async chunkEmbeddingCoverage(): Promise<{ model: string; n: number }[]> {
      const r = await db.query<{ model: string; n: number }>("SELECT e.model, count(*)::int AS n FROM kb_chunk_embeddings e JOIN kb_chunks c ON c.id = e.chunk_id JOIN kb_document_versions v ON v.id = c.version_id WHERE v.status = 'published' GROUP BY e.model ORDER BY n DESC");
      return r.rows.map((x) => ({ model: x.model, n: num(x.n) }));
    },
    async countChunks(): Promise<number> {
      const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id WHERE v.status = 'published'");
      return num(r.rows[0]!.n);
    },

    /** Mọi đoạn tri thức đang publish (cho máy quét chồng lấn kb/overlap.ts). */
    async listPublishedChunks(): Promise<{ chunkId: string; docSlug: string; heading: string; text: string; searchText: string; lang?: string; url?: string }[]> {
      const r = await db.query(
        `SELECT c.id::text AS id, c.doc_slug, c.heading, c.text, c.search_text, c.url, c.metadata->>'lang' AS lang
         FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id WHERE v.status = 'published' ORDER BY c.doc_slug, c.chunk_index`,
      );
      return r.rows.map((x) => ({ chunkId: String(x.id), docSlug: String(x.doc_slug), heading: String(x.heading), text: String(x.text), searchText: String(x.search_text), lang: (x.lang as string | null) ?? undefined, url: (x.url as string | null) ?? undefined }));
    },

    /** Các đoạn đang publish VÀ đang trong thời gian hiệu lực, theo id (khách trả lời câu hỏi lại, câu trả lời gần nhất của vụ việc). */
    async listActiveChunksByIds(ids: string[]): Promise<{ chunkId: string; docSlug: string; heading: string; text: string; lang?: string; url?: string }[]> {
      const want = ids.filter((x) => /^\d+$/.test(x));
      if (!want.length) return [];
      const r = await db.query(
        `SELECT c.id::text AS id, c.doc_slug, c.heading, c.text, c.url, c.metadata->>'lang' AS lang
         FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id
         WHERE v.status = 'published' AND c.id = ANY($1::bigint[]) AND ${ACTIVE_CHUNK} ORDER BY c.id`,
        [want],
      );
      return r.rows.map((x) => ({ chunkId: String(x.id), docSlug: String(x.doc_slug), heading: String(x.heading), text: String(x.text), lang: (x.lang as string | null) ?? undefined, url: (x.url as string | null) ?? undefined }));
    },

    /** Vector đã lưu của mọi đoạn đang publish theo `model` (máy quét chồng lấn dùng lại, không gọi API embed). */
    async listPublishedChunkVectors(model: string): Promise<Map<string, number[]>> {
      const r = await db.query<{ id: string; v: string }>(
        `SELECT e.chunk_id::text AS id, e.embedding::text AS v FROM kb_chunk_embeddings e JOIN kb_chunks c ON c.id = e.chunk_id
         JOIN kb_document_versions v ON v.id = c.version_id WHERE v.status = 'published' AND e.model = $1`,
        [model],
      );
      return new Map(r.rows.map((x) => [String(x.id), JSON.parse(x.v) as number[]]));
    },

    /**
     * Chốt lại bộ xung đột ĐANG MỞ của một tài liệu tại thời điểm nó vừa publish (bước 3 đã cảnh báo nhưng người dùng vẫn
     * đưa lên). Mọi dòng cũ liên quan tới `doc` (là `a_doc` hoặc `b_doc`) chuyển 'resolved', rồi ghi lại đúng bộ hiện tại —
     * cách này tự dọn xung đột đã hết (ví dụ sau khi gỡ từ khoá) mà không cần việc dọn riêng.
     */
    async syncConflicts(doc: string, pairs: ConflictInput[]): Promise<void> {
      await db.query("UPDATE kb_conflicts SET status = 'resolved', resolved_at = now() WHERE status = 'open' AND (a_doc = $1 OR b_doc = $1)", [doc]);
      for (const p of pairs) {
        const pairKey = [`${p.a.kind}:${p.a.id}`, `${p.b.kind}:${p.b.id}`].sort().join("|");
        await db.query(
          `INSERT INTO kb_conflicts (pair_key, a_kind, a_id, a_doc, a_title, b_kind, b_id, b_doc, b_title, score, signals, narrow, verdict, reason, suggestion, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'open')`,
          [
            pairKey,
            p.a.kind,
            p.a.id,
            p.a.doc,
            p.a.title,
            p.b.kind,
            p.b.id,
            p.b.doc,
            p.b.title,
            p.score,
            JSON.stringify(p.signals),
            p.narrow ? JSON.stringify(p.narrow) : null,
            p.verdict ?? null,
            p.reason ?? null,
            p.suggestion ?? null,
          ],
        );
      }
    },

    /** Số xung đột đang mở chạm tới mỗi tài liệu, kèm cặp điểm cao nhất (cho dấu chấm đỏ + tooltip trên danh sách Tài liệu). */
    async listOpenConflictCounts(): Promise<Map<string, { count: number; topOtherDoc: string; topOtherTitle: string; topScore: number }>> {
      const r = await db.query<{ doc: string; other_doc: string; other_title: string; score: number }>(
        `SELECT a_doc AS doc, b_doc AS other_doc, b_title AS other_title, score FROM kb_conflicts WHERE status = 'open'
         UNION ALL
         SELECT b_doc AS doc, a_doc AS other_doc, a_title AS other_title, score FROM kb_conflicts WHERE status = 'open'`,
      );
      const out = new Map<string, { count: number; topOtherDoc: string; topOtherTitle: string; topScore: number }>();
      for (const row of r.rows) {
        const score = Number(row.score);
        const cur = out.get(row.doc);
        if (!cur) out.set(row.doc, { count: 1, topOtherDoc: row.other_doc, topOtherTitle: row.other_title, topScore: score });
        else {
          cur.count++;
          if (score > cur.topScore) {
            cur.topOtherDoc = row.other_doc;
            cur.topOtherTitle = row.other_title;
            cur.topScore = score;
          }
        }
      }
      return out;
    },

    /** Toàn bộ xung đột đang mở trong cả kho — dùng để hiện cảnh báo "dễ nhầm với" ngay trên danh sách Template, không cần mở từng tài liệu. */
    async listAllConflicts(): Promise<ConflictRow[]> {
      const r = await db.query(`SELECT * FROM kb_conflicts WHERE status = 'open' ORDER BY score DESC`);
      return r.rows.map(mapConflictRow);
    },

    /** Toàn bộ xung đột đang mở chạm tới một tài liệu (cả khi tài liệu đó là bên A hay bên B), điểm cao nhất trước. */
    async listConflicts(doc: string): Promise<ConflictRow[]> {
      const r = await db.query(`SELECT * FROM kb_conflicts WHERE status = 'open' AND (a_doc = $1 OR b_doc = $1) ORDER BY score DESC`, [doc]);
      return r.rows.map(mapConflictRow);
    },

    // ---- Cache embedding ----
    async getEmbeddings(hashes: string[], embedder: string): Promise<Map<string, number[]>> {
      if (!hashes.length) return new Map();
      const r = await db.query<{ hash: string; vector: number[] }>("SELECT hash, vector FROM embedding_cache WHERE embedder = $1 AND hash = ANY($2::text[])", [embedder, hashes]);
      return new Map(r.rows.map((x) => [x.hash, x.vector]));
    },
    async putEmbeddings(entries: { hash: string; vector: number[] }[], embedder: string) {
      for (const e of entries) {
        await db.query("INSERT INTO embedding_cache (hash, embedder, vector) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING", [e.hash, embedder, JSON.stringify(e.vector)]);
      }
    },

    // ---- Quyết định về cặp nội dung chồng lấn (kb/pair-decisions.ts) ----
    // ---- Lịch sử theo từng phần (007_content_history.sql) ----
    async addContentHistory(rows: { unitKey: string; unitTitle: string; part: string; change: string; before: string | null; after: string | null; docSlug: string; version: number; changedBy: string | null; changedAt: Date }[]) {
      for (const r of rows) {
        await db.query(
          "INSERT INTO kb_content_history (unit_key, unit_title, part, change, before_value, after_value, doc_slug, version, changed_by, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [r.unitKey, r.unitTitle, r.part, r.change, r.before, r.after, r.docSlug, r.version, r.changedBy, iso(r.changedAt)],
        );
      }
    },
    async hasContentHistory(docSlug: string): Promise<boolean> {
      const r = await db.query("SELECT 1 FROM kb_content_history WHERE doc_slug = $1 LIMIT 1", [docSlug]);
      return r.rows.length > 0;
    },
    async listContentHistory(unitKey: string) {
      const r = await db.query("SELECT * FROM kb_content_history WHERE unit_key = $1 ORDER BY changed_at DESC, id DESC", [unitKey]);
      return r.rows.map((x) => ({ part: String(x.part), change: String(x.change), before: (x.before_value as string | null) ?? null, after: (x.after_value as string | null) ?? null, docSlug: String(x.doc_slug), version: num(x.version), changedBy: (x.changed_by as string | null) ?? null, changedAt: new Date(String(x.changed_at)) }));
    },

    async listPairDecisions(): Promise<PairDecision[]> {
      const r = await db.query("SELECT * FROM kb_pair_decisions ORDER BY decided_at DESC");
      return r.rows.map((x) => ({ aKey: String(x.a_key), bKey: String(x.b_key), aHash: String(x.a_hash), bHash: String(x.b_hash), decision: x.decision as PairDecisionKind, note: (x.note as string | null) ?? null, decidedBy: String(x.decided_by), decidedAt: new Date(String(x.decided_at)), winnerKey: (x.winner_key as string | null) ?? null }));
    },
    /** Ghi (hoặc ghi đè) quyết định cho một cặp — `a`/`b` phải đã được sắp theo `orderPair`. */
    async savePairDecision(d: { aKey: string; bKey: string; aHash: string; bHash: string; decision: PairDecisionKind; note?: string | null; decidedBy: string; winnerKey?: string | null }) {
      await db.query(
        `INSERT INTO kb_pair_decisions (a_key, b_key, a_hash, b_hash, decision, note, decided_by, winner_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (a_key, b_key) DO UPDATE SET a_hash = EXCLUDED.a_hash, b_hash = EXCLUDED.b_hash, decision = EXCLUDED.decision, note = EXCLUDED.note, decided_by = EXCLUDED.decided_by, winner_key = EXCLUDED.winner_key, decided_at = now()`,
        [d.aKey, d.bKey, d.aHash, d.bHash, d.decision, d.note ?? null, d.decidedBy, d.winnerKey ?? null],
      );
    },

    // ---- Nhận xét của AI theo cặp nội dung (009_pair_reviews.sql) ----
    /** Ghi nhận xét cho một cặp — `a`/`b` phải đã được sắp theo `orderPair`. Cùng nội dung hai bên thì ghi đè. */
    async savePairReview(r: PairReview) {
      await db.query(
        `INSERT INTO kb_pair_reviews (a_key, a_hash, a_title, b_key, b_hash, b_title, verdict, reason, suggestion) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (a_key, a_hash, b_key, b_hash) DO UPDATE SET a_title = EXCLUDED.a_title, b_title = EXCLUDED.b_title, verdict = EXCLUDED.verdict, reason = EXCLUDED.reason, suggestion = EXCLUDED.suggestion, reviewed_at = now()`,
        [r.aKey, r.aHash, r.aTitle, r.bKey, r.bHash, r.bTitle, r.verdict, r.reason ?? null, r.suggestion ?? null],
      );
    },
    /** Mọi nhận xét có một bên thuộc `keys`, mới nhất trước. */
    async listPairReviews(keys: string[]): Promise<(PairReview & { reviewedAt: Date })[]> {
      if (!keys.length) return [];
      const r = await db.query("SELECT * FROM kb_pair_reviews WHERE a_key = ANY($1) OR b_key = ANY($1) ORDER BY reviewed_at DESC, id DESC", [keys]);
      return r.rows.map((x) => ({ aKey: String(x.a_key), aHash: String(x.a_hash), aTitle: String(x.a_title), bKey: String(x.b_key), bHash: String(x.b_hash), bTitle: String(x.b_title), verdict: String(x.verdict), reason: (x.reason as string | null) ?? null, suggestion: (x.suggestion as string | null) ?? null, reviewedAt: new Date(String(x.reviewed_at)) }));
    },
    /** Mốc thời gian mới nhất phần TRẢ LỜI / NỘI DUNG của từng nội dung đổi (kb_content_history): dùng khi hai nội dung mâu thuẫn cùng được tìm thấy lúc chạy. */
    async latestAnswerTimes(): Promise<Map<string, number>> {
      const r = await db.query<{ unit_key: string; at: string }>("SELECT unit_key, max(changed_at) AS at FROM kb_content_history WHERE change <> 'removed' AND (part LIKE 'Trả lời%' OR part = 'Nội dung') GROUP BY unit_key");
      return new Map(r.rows.map((x) => [String(x.unit_key), new Date(String(x.at)).getTime()]));
    },

    // ---- Eval ----
    async listEvalCases() {
      const r = await db.query("SELECT * FROM eval_cases ORDER BY id");
      return r.rows.map((x) => ({ id: num(x.id), question: String(x.question), expected_template_id: (x.expected_template_id as string | null) ?? null, image_type: (x.image_type as string | null) ?? null, lang: (x.lang as string | null) ?? null, source: (x.source as string | null) ?? null }));
    },
    async addEvalCase(c: { question: string; expected: string | null; imageType?: string | null; lang?: string | null; source?: string | null }) {
      const r = await db.query<{ id: string }>("INSERT INTO eval_cases (question, expected_template_id, image_type, lang, source) VALUES ($1,$2,$3,$4,$5) RETURNING id", [c.question, c.expected, c.imageType ?? null, c.lang ?? null, c.source ?? null]);
      return num(r.rows[0]!.id);
    },
    async deleteEvalCase(id: number) {
      await db.query("DELETE FROM eval_cases WHERE id = $1", [id]);
    },
    async countEvalCases(): Promise<number> {
      const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM eval_cases");
      return num(r.rows[0]!.n);
    },
  };
}

export type KbRepo = ReturnType<typeof kbRepo>;
