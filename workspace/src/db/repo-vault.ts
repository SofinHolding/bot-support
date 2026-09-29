/** Truy cập các bảng của vault (migrations/011): lượt nạp, bản sao note, chunk + vector, xung đột khi nạp. */
import { toPgVector } from "../core/embedding";
import { SERVABLE } from "../vault/note";
import { iso, num, type Db } from "./db";

export type BatchStatus = "queued" | "running" | "done" | "failed";

export interface BatchRow {
  id: number;
  fileName: string;
  rawPath: string;
  status: BatchStatus;
  report: Record<string, unknown> | null;
  error: string | null;
  createdBy: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface NoteRow {
  id: string;
  title: string;
  category: string;
  versionGroup: string;
  status: string;
  langSource: string;
  ingestedAt: Date;
  path: string;
  contentHash: string;
  meta: Record<string, unknown>;
  body: string;
  batchId: number | null;
}

export interface ChunkPayload {
  status: string;
  category: string;
  versionGroup: string;
  path: string;
  langSource: string;
  ingestedAt: string;
}

export interface ChunkUpsert extends ChunkPayload {
  chunkId: string;
  noteId: string;
  seq: number;
  heading: string;
  text: string;
  embedInput: string;
  embedHash: string;
  searchText: string;
}

export interface VaultChunkHit {
  chunkId: string;
  noteId: string;
  heading: string;
  text: string;
  langSource: string;
  score: number;
}

export type ConflictType = "in_file" | "tie" | "version";
export type ConflictStatus = "open" | "sent" | "deciding" | "resolved";
/** "a".."z" = giữ phương án có nhãn đó; "old" = giữ bản cũ; "merge" = gộp / nhập lại; "drop_all" = bỏ các phương án mới */
export type ConflictDecision = string;

/** Một bên trong xung đột. label: A, B, C… cho note mới; "O" cho note cũ đang dùng. */
export interface ConflictCandidate {
  label: string;
  noteId: string;
  title: string;
  sourceFile: string;
  sourceRefs: string[];
  excerpt: string;
  ingestedAt: string;
  old?: boolean;
}

export interface ConflictRow {
  id: number;
  type: ConflictType;
  priority: "block" | "low";
  versionGroup: string;
  candidates: ConflictCandidate[];
  activeNoteId: string | null;
  reasons: string[];
  batchId: number | null;
  notificationFile: string | null;
  status: ConflictStatus;
  telegramMessages: { chatId: number; messageId: number }[];
  decision: ConflictDecision | null;
  decisionPayload: Record<string, unknown> | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  remindCount: number;
  lastNotifiedAt: Date | null;
  createdAt: Date;
}

const d = (v: unknown) => (v === null || v === undefined ? null : new Date(String(v)));

const mapBatch = (x: Record<string, unknown>): BatchRow => ({
  id: num(x.id),
  fileName: String(x.file_name),
  rawPath: String(x.raw_path),
  status: x.status as BatchStatus,
  report: (x.report as Record<string, unknown> | null) ?? null,
  error: (x.error as string | null) ?? null,
  createdBy: (x.created_by as string | null) ?? null,
  createdAt: new Date(String(x.created_at)),
  finishedAt: d(x.finished_at),
});

const mapNote = (x: Record<string, unknown>): NoteRow => ({
  id: String(x.id),
  title: String(x.title),
  category: String(x.category),
  versionGroup: String(x.version_group),
  status: String(x.status),
  langSource: String(x.lang_source),
  ingestedAt: new Date(String(x.ingested_at)),
  path: String(x.path),
  contentHash: String(x.content_hash),
  meta: (x.meta as Record<string, unknown>) ?? {},
  body: String(x.body),
  batchId: x.batch_id === null || x.batch_id === undefined ? null : num(x.batch_id),
});

const mapConflict = (x: Record<string, unknown>): ConflictRow => ({
  id: num(x.id),
  type: x.type as ConflictType,
  priority: x.priority as "block" | "low",
  versionGroup: String(x.version_group),
  candidates: (x.candidates as ConflictCandidate[]) ?? [],
  activeNoteId: (x.active_note_id as string | null) ?? null,
  reasons: (x.reasons as string[]) ?? [],
  batchId: x.batch_id === null || x.batch_id === undefined ? null : num(x.batch_id),
  notificationFile: (x.notification_file as string | null) ?? null,
  status: x.status as ConflictStatus,
  telegramMessages: (x.telegram_messages as { chatId: number; messageId: number }[]) ?? [],
  decision: (x.decision as ConflictDecision | null) ?? null,
  decisionPayload: (x.decision_payload as Record<string, unknown> | null) ?? null,
  decidedBy: (x.decided_by as string | null) ?? null,
  decidedAt: d(x.decided_at),
  remindCount: num(x.remind_count),
  lastNotifiedAt: d(x.last_notified_at),
  createdAt: new Date(String(x.created_at)),
});

export function vaultRepo(db: Db) {
  return {
    // ---- Lượt nạp ----
    async createBatch(fileName: string, rawPath: string, by: string | null): Promise<number> {
      const r = await db.query("INSERT INTO ingest_batches (file_name, raw_path, created_by) VALUES ($1, $2, $3) RETURNING id", [fileName, rawPath, by]);
      return num(r.rows[0]!.id);
    },
    async getBatch(id: number): Promise<BatchRow | null> {
      const r = await db.query("SELECT * FROM ingest_batches WHERE id = $1", [id]);
      return r.rows[0] ? mapBatch(r.rows[0]) : null;
    },
    async listBatches(limit = 50): Promise<BatchRow[]> {
      const r = await db.query("SELECT * FROM ingest_batches ORDER BY id DESC LIMIT $1", [limit]);
      return r.rows.map(mapBatch);
    },
    async markBatch(id: number, status: BatchStatus, extra: { report?: Record<string, unknown>; error?: string | null } = {}) {
      await db.query(
        `UPDATE ingest_batches SET status = $2, report = COALESCE($3::jsonb, report), error = $4,
           finished_at = CASE WHEN $2 IN ('done', 'failed') THEN now() ELSE NULL END WHERE id = $1`,
        [id, status, extra.report ? JSON.stringify(extra.report) : null, extra.error ?? null],
      );
    },

    // ---- Bản sao note ----
    async upsertNote(n: Omit<NoteRow, "ingestedAt"> & { ingestedAt: string }) {
      await db.query(
        `INSERT INTO vault_notes (id, title, category, version_group, status, lang_source, ingested_at, path, content_hash, meta, body, batch_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12, now())
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, category = EXCLUDED.category, version_group = EXCLUDED.version_group,
           status = EXCLUDED.status, lang_source = EXCLUDED.lang_source, ingested_at = EXCLUDED.ingested_at, path = EXCLUDED.path,
           content_hash = EXCLUDED.content_hash, meta = EXCLUDED.meta, body = EXCLUDED.body, batch_id = COALESCE(EXCLUDED.batch_id, vault_notes.batch_id), updated_at = now()`,
        [n.id, n.title, n.category, n.versionGroup, n.status, n.langSource, n.ingestedAt, n.path, n.contentHash, JSON.stringify(n.meta), n.body, n.batchId],
      );
    },
    async getNote(id: string): Promise<NoteRow | null> {
      const r = await db.query("SELECT * FROM vault_notes WHERE id = $1", [id]);
      return r.rows[0] ? mapNote(r.rows[0]) : null;
    },
    async notesByIds(ids: string[]): Promise<NoteRow[]> {
      if (!ids.length) return [];
      const r = await db.query("SELECT * FROM vault_notes WHERE id = ANY($1::text[])", [ids]);
      return r.rows.map(mapNote);
    },
    async notesInGroups(groups: string[], statuses: string[]): Promise<NoteRow[]> {
      if (!groups.length) return [];
      const r = await db.query("SELECT * FROM vault_notes WHERE version_group = ANY($1::text[]) AND status = ANY($2::text[]) ORDER BY ingested_at", [groups, statuses]);
      return r.rows.map(mapNote);
    },
    /** Chủ đề đang dùng (kèm tiêu đề chuẩn hoá) để skill tái dùng version_group thay vì tạo id mới cho cùng chủ đề. */
    async activeGroups(limit = 400): Promise<{ versionGroup: string; category: string; canonicalTitle: string }[]> {
      const r = await db.query(
        `SELECT DISTINCT ON (version_group) version_group, category, meta->>'canonical_title' AS ct
         FROM vault_notes WHERE status = ANY($1::text[]) ORDER BY version_group, ingested_at DESC LIMIT $2`,
        [SERVABLE, limit],
      );
      return r.rows.map((x) => ({ versionGroup: String(x.version_group), category: String(x.category), canonicalTitle: String(x.ct ?? "") }));
    },
    /** Id đã dùng có dạng `<prefix>-<số>` (id note = `<version_group>-<nnn>`, không bao giờ dùng lại id cũ). */
    async idsWithPrefix(prefix: string): Promise<string[]> {
      const r = await db.query("SELECT id FROM vault_notes WHERE id LIKE $1", [`${prefix.replace(/[%_\\]/g, "\\$&")}-%`]);
      return r.rows.map((x) => String(x.id));
    },
    async countNotes(): Promise<Record<string, number>> {
      const r = await db.query("SELECT status, count(*)::int AS n FROM vault_notes GROUP BY status");
      return Object.fromEntries(r.rows.map((x) => [String(x.status), num(x.n)]));
    },

    // ---- Chunk ----
    async chunkHashes(noteId: string): Promise<Map<string, string>> {
      const r = await db.query("SELECT chunk_id, embed_hash FROM vault_chunks WHERE note_id = $1", [noteId]);
      return new Map(r.rows.map((x) => [String(x.chunk_id), String(x.embed_hash)]));
    },
    async upsertChunk(c: ChunkUpsert) {
      await db.query(
        `INSERT INTO vault_chunks (chunk_id, note_id, seq, status, category, version_group, path, lang_source, ingested_at, heading, text, embed_input, embed_hash, search_text, tsv)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, to_tsvector('simple', $14))
         ON CONFLICT (chunk_id) DO UPDATE SET seq = EXCLUDED.seq, status = EXCLUDED.status, category = EXCLUDED.category, version_group = EXCLUDED.version_group,
           path = EXCLUDED.path, lang_source = EXCLUDED.lang_source, ingested_at = EXCLUDED.ingested_at, heading = EXCLUDED.heading, text = EXCLUDED.text,
           embed_input = EXCLUDED.embed_input, embed_hash = EXCLUDED.embed_hash, search_text = EXCLUDED.search_text, tsv = EXCLUDED.tsv`,
        [c.chunkId, c.noteId, c.seq, c.status, c.category, c.versionGroup, c.path, c.langSource, c.ingestedAt, c.heading, c.text, c.embedInput, c.embedHash, c.searchText],
      );
    },
    /** update_payload: chỉ đổi trạng thái/metadata, không đụng vector. */
    async setChunkPayload(noteId: string, p: ChunkPayload): Promise<number> {
      const r = await db.query(
        "UPDATE vault_chunks SET status = $2, category = $3, version_group = $4, path = $5, lang_source = $6, ingested_at = $7 WHERE note_id = $1",
        [noteId, p.status, p.category, p.versionGroup, p.path, p.langSource, p.ingestedAt],
      );
      return r.rowCount;
    },
    /** Xoá chunk của note; `keep` = các chunk_id còn dùng (note bị sửa ngắn đi thì chunk thừa bị xoá). */
    async removeChunks(noteId: string, keep: string[] = []): Promise<number> {
      const r = await db.query("DELETE FROM vault_chunks WHERE note_id = $1 AND NOT (chunk_id = ANY($2::text[]))", [noteId, keep]);
      return r.rowCount;
    },
    async vectorHash(chunkId: string, model: string): Promise<string | null> {
      const r = await db.query("SELECT embed_hash FROM vault_chunk_vectors WHERE chunk_id = $1 AND model = $2", [chunkId, model]);
      return r.rows[0] ? String(r.rows[0].embed_hash) : null;
    },
    async putVector(chunkId: string, model: string, embedHash: string, v: number[]) {
      await db.query(
        `INSERT INTO vault_chunk_vectors (chunk_id, model, embed_hash, embedding) VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (chunk_id, model) DO UPDATE SET embed_hash = EXCLUDED.embed_hash, embedding = EXCLUDED.embedding`,
        [chunkId, model, embedHash, toPgVector(v)],
      );
    },
    /** Chunk chưa có vector (hoặc vector cũ) của `model`: đổi model / API từng lỗi lúc index. */
    async chunksMissingVector(model: string, limit: number): Promise<{ chunkId: string; embedInput: string; embedHash: string }[]> {
      const r = await db.query(
        `SELECT c.chunk_id, c.embed_input, c.embed_hash FROM vault_chunks c
         LEFT JOIN vault_chunk_vectors v ON v.chunk_id = c.chunk_id AND v.model = $1
         WHERE v.chunk_id IS NULL OR v.embed_hash <> c.embed_hash ORDER BY c.chunk_id LIMIT $2`,
        [model, limit],
      );
      return r.rows.map((x) => ({ chunkId: String(x.chunk_id), embedInput: String(x.embed_input), embedHash: String(x.embed_hash) }));
    },
    async chunkStats(model?: string) {
      const r = await db.query(
        `SELECT count(*)::int AS chunks, count(DISTINCT note_id)::int AS notes,
           (SELECT count(*)::int FROM vault_chunk_vectors WHERE $1::text IS NULL OR model = $1) AS vectors FROM vault_chunks`,
        [model ?? null],
      );
      const x = r.rows[0]!;
      return { chunks: num(x.chunks), notes: num(x.notes), vectors: num(x.vectors) };
    },

    // ---- Tìm kiếm (chỉ chunk có status dùng được) ----
    async searchLexical(tsQuery: string, limit: number): Promise<VaultChunkHit[]> {
      if (!tsQuery) return [];
      const r = await db.query(
        `SELECT chunk_id, note_id, heading, text, lang_source, ts_rank(tsv, to_tsquery('simple', $1))::float8 AS score
         FROM vault_chunks WHERE status = ANY($3::text[]) AND tsv @@ to_tsquery('simple', $1) ORDER BY score DESC, chunk_id LIMIT $2`,
        [tsQuery, limit, SERVABLE],
      );
      return r.rows.map((x) => ({ chunkId: String(x.chunk_id), noteId: String(x.note_id), heading: String(x.heading), text: String(x.text), langSource: String(x.lang_source), score: num(x.score) }));
    },
    async searchVector(v: number[], model: string, limit: number): Promise<VaultChunkHit[]> {
      const r = await db.query(
        `SELECT c.chunk_id, c.note_id, c.heading, c.text, c.lang_source, (1 - (e.embedding <=> $1::vector))::float8 AS score
         FROM vault_chunk_vectors e JOIN vault_chunks c ON c.chunk_id = e.chunk_id
         WHERE e.model = $2 AND c.status = ANY($4::text[]) ORDER BY e.embedding <=> $1::vector LIMIT $3`,
        [toPgVector(v), model, limit, SERVABLE],
      );
      return r.rows.map((x) => ({ chunkId: String(x.chunk_id), noteId: String(x.note_id), heading: String(x.heading), text: String(x.text), langSource: String(x.lang_source), score: num(x.score) }));
    },
    async chunksByIds(ids: string[]): Promise<VaultChunkHit[]> {
      if (!ids.length) return [];
      const r = await db.query(
        "SELECT chunk_id, note_id, heading, text, lang_source FROM vault_chunks WHERE chunk_id = ANY($1::text[]) AND status = ANY($2::text[])",
        [ids, SERVABLE],
      );
      return r.rows.map((x) => ({ chunkId: String(x.chunk_id), noteId: String(x.note_id), heading: String(x.heading), text: String(x.text), langSource: String(x.lang_source), score: 1 }));
    },
    async firstChunksOfNotes(noteIds: string[]): Promise<VaultChunkHit[]> {
      if (!noteIds.length) return [];
      const r = await db.query(
        `SELECT DISTINCT ON (note_id) chunk_id, note_id, heading, text, lang_source FROM vault_chunks
         WHERE note_id = ANY($1::text[]) AND status = ANY($2::text[]) ORDER BY note_id, seq`,
        [noteIds, SERVABLE],
      );
      return r.rows.map((x) => ({ chunkId: String(x.chunk_id), noteId: String(x.note_id), heading: String(x.heading), text: String(x.text), langSource: String(x.lang_source), score: 0 }));
    },

    // ---- Xung đột ----
    async openConflictForGroup(group: string): Promise<ConflictRow | null> {
      const r = await db.query("SELECT * FROM ingest_conflicts WHERE version_group = $1 AND status IN ('open', 'sent', 'deciding')", [group]);
      return r.rows[0] ? mapConflict(r.rows[0]) : null;
    },
    async createConflict(c: { type: ConflictType; versionGroup: string; candidates: ConflictCandidate[]; activeNoteId: string | null; reasons: string[]; batchId: number | null }): Promise<number> {
      const r = await db.query(
        "INSERT INTO ingest_conflicts (type, version_group, candidates, active_note_id, reasons, batch_id) VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6) RETURNING id",
        [c.type, c.versionGroup, JSON.stringify(c.candidates), c.activeNoteId, JSON.stringify(c.reasons), c.batchId],
      );
      return num(r.rows[0]!.id);
    },
    /** Xung đột mới cùng chủ đề: gộp ứng viên vào bản ghi đang mở và đưa về "open" để gửi lại tin cập nhật. */
    async extendConflict(id: number, candidates: ConflictCandidate[], reasons: string[]) {
      await db.query("UPDATE ingest_conflicts SET candidates = $2::jsonb, reasons = $3::jsonb, status = CASE WHEN status = 'sent' THEN 'open' ELSE status END WHERE id = $1", [id, JSON.stringify(candidates), JSON.stringify(reasons)]);
    },
    async setNotificationFile(id: number, file: string) {
      await db.query("UPDATE ingest_conflicts SET notification_file = $2 WHERE id = $1", [id, file]);
    },
    async getConflict(id: number): Promise<ConflictRow | null> {
      const r = await db.query("SELECT * FROM ingest_conflicts WHERE id = $1", [id]);
      return r.rows[0] ? mapConflict(r.rows[0]) : null;
    },
    async listConflicts(statuses: ConflictStatus[], limit = 100): Promise<ConflictRow[]> {
      const r = await db.query("SELECT * FROM ingest_conflicts WHERE status = ANY($1::text[]) ORDER BY id DESC LIMIT $2", [statuses, limit]);
      return r.rows.map(mapConflict);
    },
    async countOpenConflicts(): Promise<number> {
      const r = await db.query("SELECT count(*)::int AS n FROM ingest_conflicts WHERE status IN ('open', 'sent')");
      return num(r.rows[0]!.n);
    },
    /** Người bấm đầu tiên thắng: chỉ ghi khi xung đột còn mở. null = đã có người quyết định trước. */
    async claimDecision(id: number, decision: ConflictDecision, payload: Record<string, unknown> | null, by: string, at: Date): Promise<ConflictRow | null> {
      const r = await db.query(
        // ảnh chụp danh sách ứng viên lúc bấm: note đổ vào sau đó không bị quyết định thay (xem vault/decide.ts)
        `UPDATE ingest_conflicts SET status = 'deciding', decision = $2, decided_by = $4, decided_at = $5,
           decision_payload = COALESCE($3::jsonb, '{}'::jsonb) || jsonb_build_object('candidateIds', (SELECT COALESCE(jsonb_agg(c->>'noteId'), '[]'::jsonb) FROM jsonb_array_elements(candidates) c))
         WHERE id = $1 AND status IN ('open', 'sent') RETURNING *`,
        [id, decision, payload ? JSON.stringify(payload) : null, by, iso(at)],
      );
      return r.rows[0] ? mapConflict(r.rows[0]) : null;
    },
    async resolveConflict(id: number) {
      await db.query("UPDATE ingest_conflicts SET status = 'resolved' WHERE id = $1", [id]);
    },
    async markConflictSent(id: number, messages: { chatId: number; messageId: number }[], at: Date, reminder = false) {
      await db.query(
        `UPDATE ingest_conflicts SET status = CASE WHEN status = 'open' THEN 'sent' ELSE status END, telegram_messages = $2::jsonb, last_notified_at = $3,
           remind_count = remind_count + CASE WHEN $4 THEN 1 ELSE 0 END WHERE id = $1`,
        [id, JSON.stringify(messages), iso(at), reminder],
      );
    },

    // ---- Gộp / nhập lại qua Telegram (force-reply) ----
    ...mergePromptRepo(db),
  };
}

export type MergePromptStatus = "awaiting_text" | "awaiting_confirm" | "done" | "cancelled";

export interface MergePromptRow {
  id: number;
  conflictId: number;
  chatId: number;
  adminId: number;
  promptMessageId: number;
  previewMessageId: number | null;
  status: MergePromptStatus;
  draftNote: Record<string, unknown> | null;
  createdAt: Date;
}

const mapMergePrompt = (x: Record<string, unknown>): MergePromptRow => ({
  id: num(x.id),
  conflictId: num(x.conflict_id),
  chatId: num(x.chat_id),
  adminId: num(x.admin_id),
  promptMessageId: num(x.prompt_message_id),
  previewMessageId: x.preview_message_id === null || x.preview_message_id === undefined ? null : num(x.preview_message_id),
  status: x.status as MergePromptStatus,
  draftNote: (x.draft_note as Record<string, unknown> | null) ?? null,
  createdAt: new Date(String(x.created_at)),
});

function mergePromptRepo(db: Db) {
  return {
    async createMergePrompt(conflictId: number, chatId: number, adminId: number, promptMessageId: number): Promise<number> {
      const r = await db.query("INSERT INTO vault_merge_prompts (conflict_id, chat_id, admin_id, prompt_message_id) VALUES ($1,$2,$3,$4) RETURNING id", [conflictId, chatId, adminId, promptMessageId]);
      return num(r.rows[0]!.id);
    },
    /** Khớp tin admin vừa trả lời với đúng prompt còn chờ chữ (mỗi chat + tin gốc chỉ một prompt). */
    async mergePromptByReply(chatId: number, promptMessageId: number): Promise<MergePromptRow | null> {
      const r = await db.query("SELECT * FROM vault_merge_prompts WHERE chat_id = $1 AND prompt_message_id = $2 AND status = 'awaiting_text'", [chatId, promptMessageId]);
      return r.rows[0] ? mapMergePrompt(r.rows[0]) : null;
    },
    async getMergePrompt(id: number): Promise<MergePromptRow | null> {
      const r = await db.query("SELECT * FROM vault_merge_prompts WHERE id = $1", [id]);
      return r.rows[0] ? mapMergePrompt(r.rows[0]) : null;
    },
    /** AI đã soạn xong note từ chữ admin trả lời: chuyển sang chờ admin xác nhận trên bản xem trước. */
    async setMergePromptDraft(id: number, previewMessageId: number, draftNote: Record<string, unknown>) {
      await db.query("UPDATE vault_merge_prompts SET status = 'awaiting_confirm', preview_message_id = $2, draft_note = $3::jsonb WHERE id = $1", [id, previewMessageId, JSON.stringify(draftNote)]);
    },
    async resolveMergePrompt(id: number, status: "done" | "cancelled") {
      await db.query("UPDATE vault_merge_prompts SET status = $2 WHERE id = $1", [id, status]);
    },
  };
}

export type VaultRepo = ReturnType<typeof vaultRepo>;
