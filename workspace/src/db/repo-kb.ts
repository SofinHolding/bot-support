/** Truy cập kho tri thức: tài liệu + phiên bản, template đã publish, chunk vector, bản dịch, cache embedding, eval, settings. */
import type { Template } from "../domain/types";
import { iso, num, numOrNull, type Db } from "./db";

export type VersionStatus = "draft" | "pending_approval" | "published" | "archived" | "rejected";

export interface DocumentRow {
  slug: string;
  title: string;
  kind: "templates" | "knowledge";
  created_at: Date;
  published_version: number | null;
  latest_version: number;
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

export interface ChunkInsert {
  index: number;
  heading: string;
  text: string;
  url?: string;
  searchText: string;
  hash: string;
  embedding?: number[];
  embeddingModel?: string;
}

export interface ChunkHit {
  chunkId: string;
  docSlug: string;
  heading: string;
  text: string;
  url?: string;
  searchText: string;
  vectorScore: number | null;
  lexicalRank: number;
}

const vecLiteral = (v: number[]) => `[${v.map((x) => Number(x.toFixed(6))).join(",")}]`;

export function kbRepo(db: Db) {
  return {
    // ---- Tài liệu và phiên bản ----
    async upsertDocument(slug: string, title: string, kind: "templates" | "knowledge") {
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
      return r.rows[0] as { slug: string; title: string; kind: "templates" | "knowledge" } | undefined;
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

    // ---- Template ----
    async replaceTemplates(versionId: number, slug: string, templates: Template[]) {
      await db.query("DELETE FROM templates WHERE version_id = $1", [versionId]);
      for (const t of templates) {
        await db.query("INSERT INTO templates (id, version_id, doc_slug, definition) VALUES ($1,$2,$3,$4::jsonb)", [t.id, versionId, slug, JSON.stringify(t)]);
      }
    },
    async loadPublishedTemplateRows(): Promise<{ docSlug: string; template: Template }[]> {
      const r = await db.query<{ doc_slug: string; definition: Template }>(
        "SELECT t.doc_slug, t.definition FROM templates t JOIN kb_document_versions v ON v.id = t.version_id WHERE v.status = 'published' ORDER BY t.id",
      );
      return r.rows.map((x) => ({ docSlug: x.doc_slug, template: x.definition }));
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
          `INSERT INTO kb_chunks (version_id, doc_slug, chunk_index, chunk_hash, heading, text, url, search_text, tsv, embedding, embedding_model)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_tsvector('simple', $8), $9::vector, $10)`,
          [versionId, slug, c.index, c.hash, c.heading, c.text, c.url ?? null, c.searchText, c.embedding ? vecLiteral(c.embedding) : null, c.embeddingModel ?? null],
        );
      }
    },
    /** Tìm chunk trong các tài liệu đang publish: gộp kết quả từ khoá (tsvector) và vector (pgvector). */
    async searchChunks(opts: { tsQuery: string; embedding?: number[]; embeddingModel?: string; limit: number }): Promise<ChunkHit[]> {
      const lex = opts.tsQuery
        ? await db.query(
            `SELECT c.id, c.doc_slug, c.heading, c.text, c.url, c.search_text, ts_rank(c.tsv, to_tsquery('simple', $1))::float8 AS rank
             FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id
             WHERE v.status = 'published' AND c.tsv @@ to_tsquery('simple', $1) ORDER BY rank DESC LIMIT $2`,
            [opts.tsQuery, opts.limit],
          )
        : { rows: [] as Record<string, unknown>[] };
      const vec =
        opts.embedding && opts.embeddingModel
          ? await db.query(
              `SELECT c.id, c.doc_slug, c.heading, c.text, c.url, c.search_text, (1 - (c.embedding <=> $1::vector))::float8 AS sim
               FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id
               WHERE v.status = 'published' AND c.embedding IS NOT NULL AND c.embedding_model = $2
               ORDER BY c.embedding <=> $1::vector LIMIT $3`,
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
        } else byId.set(id, { chunkId: id, docSlug: String(x.doc_slug), heading: String(x.heading), text: String(x.text), url: (x.url as string | null) ?? undefined, searchText: String(x.search_text), lexicalRank, vectorScore });
      };
      for (const x of lex.rows) put(x, num(x.rank), null);
      for (const x of vec.rows) put(x, 0, num(x.sim));
      return [...byId.values()];
    },
    async countChunks(): Promise<number> {
      const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id WHERE v.status = 'published'");
      return num(r.rows[0]!.n);
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
