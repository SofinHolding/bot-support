/** Truy cập dữ liệu hội thoại: user, antispam, episode, message, event, decision, ticket, idempotency, LLM usage. */
import { randomInt } from "node:crypto";
import type { AntispamState } from "../core/antispam";
import { iso, num, numOrNull, type Db } from "./db";

export interface UserRow {
  telegram_id: number;
  name: string | null;
  username: string | null;
  language: string | null;
  flags: Record<string, unknown>;
  /** Giá trị ổn định khách đã nêu (thiết bị, phiên bản app), do code trích: { device?: { value, seen_at }, app_version?: {...} } */
  profile: Record<string, { value: string; seen_at: string }>;
  first_seen: Date;
  last_seen: Date;
  seen_count: number;
}

export type EpisodeStatus = "open" | "dormant" | "resolved" | "escalated" | "security_alerted";

export interface EpisodeRow {
  id: number;
  user_id: number;
  parent_episode_id: number | null;
  issue: string | null;
  topic_group: string | null;
  status: EpisodeStatus;
  summary: Record<string, unknown> | null;
  summary_version: number;
  summary_upto_message_id: number | null;
  last_template_id: string | null;
  last_bot_action: string | null;
  /** bot vừa hỏi lại khách để phân biệt các mục này (tối đa 1 lần); lượt sau chỉ chọn trong đây */
  pending_clarify: { items: string[] } | null;
  /** mã tham chiếu khách nhìn thấy ("EP-XXXXX"), sinh khi mở episode; null với episode mở trước migration 010 */
  ref_code: string | null;
  /** khoá chủ đề chuẩn hoá (core/items.ts topicKeyOf); null = chưa biết chủ đề */
  topic_key: string | null;
  /** tin khách nêu vấn đề (ghi một lần) và câu truy vấn tiếng Anh AI viết cho tin đó */
  anchor_message_id: number | null;
  anchor_query_en: string | null;
  /** nội dung gửi gần nhất: "T:<template id>" | "K:<chunk id>" */
  last_ref: string | null;
  clarify_count: number;
  opened_at: Date;
  last_activity_at: Date;
  closed_at: Date | null;
}

export interface MessageRow {
  id: number;
  episode_id: number | null;
  user_id: number;
  direction: "in" | "out";
  text: string | null;
  image_ref: string | null;
  image_type: string | null;
  language: string | null;
  tier: number | null;
  template_id: string | null;
  created_at: Date;
}

export interface EventRow {
  id: number;
  user_id: number;
  episode_id: number | null;
  type: string;
  payload: Record<string, unknown>;
  at: Date;
}

export interface TicketRow {
  id: number;
  episode_id: number | null;
  user_id: number;
  category: string | null;
  error_code: string | null;
  pic: string | null;
  status: "open" | "in_progress" | "closed";
  reason: string | null;
  required_info: string[] | null;
  source_template_id: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

const mapUser = (r: Record<string, unknown>): UserRow => ({ ...(r as unknown as UserRow), telegram_id: num(r.telegram_id), seen_count: num(r.seen_count) });
const mapEpisode = (r: Record<string, unknown>): EpisodeRow => ({
  ...(r as unknown as EpisodeRow),
  id: num(r.id),
  user_id: num(r.user_id),
  parent_episode_id: numOrNull(r.parent_episode_id),
  summary_upto_message_id: numOrNull(r.summary_upto_message_id),
  summary_version: num(r.summary_version),
  anchor_message_id: numOrNull(r.anchor_message_id),
  clarify_count: num(r.clarify_count ?? 0),
});
const mapMessage = (r: Record<string, unknown>): MessageRow => ({ ...(r as unknown as MessageRow), id: num(r.id), user_id: num(r.user_id), episode_id: numOrNull(r.episode_id), tier: numOrNull(r.tier) });
const mapEvent = (r: Record<string, unknown>): EventRow => ({ ...(r as unknown as EventRow), id: num(r.id), user_id: num(r.user_id), episode_id: numOrNull(r.episode_id) });
const mapTicket = (r: Record<string, unknown>): TicketRow => ({ ...(r as unknown as TicketRow), id: num(r.id), user_id: num(r.user_id), episode_id: numOrNull(r.episode_id) });

export function convRepo(db: Db) {
  return {
    // ---- Idempotency webhook ----
    /** true nếu update này CHƯA từng được nhận (và đã được đánh dấu là đã nhận). */
    async claimUpdate(updateId: number): Promise<boolean> {
      // Update đã claim nhưng chưa xử lý xong sau 2 phút = tiến trình trước đã chết giữa chừng: cho nhận lại (at-least-once).
      const r = await db.query(
        `INSERT INTO inbound_updates (telegram_update_id) VALUES ($1)
         ON CONFLICT (telegram_update_id) DO UPDATE SET received_at = now(), status = 'retried'
           WHERE inbound_updates.processed_at IS NULL AND inbound_updates.received_at < now() - interval '2 minutes'
         RETURNING telegram_update_id`,
        [updateId],
      );
      return r.rowCount === 1;
    },
    /** true khi update đã được nhận nhưng CHƯA xử lý xong (một lượt khác đang chạy, hoặc tiến trình trước vừa chết). */
    async updateUnfinished(updateId: number): Promise<boolean> {
      const r = await db.query("SELECT 1 FROM inbound_updates WHERE telegram_update_id = $1 AND processed_at IS NULL", [updateId]);
      return r.rowCount > 0;
    },
    async finishUpdate(updateId: number, status: string) {
      await db.query("UPDATE inbound_updates SET processed_at = now(), status = $2 WHERE telegram_update_id = $1", [updateId, status]);
    },

    // ---- Người dùng ----
    async touchUser(u: { id: number; name?: string | null; username?: string | null }, now: Date): Promise<UserRow> {
      const r = await db.query(
        `INSERT INTO users (telegram_id, name, username, first_seen, last_seen, seen_count)
         VALUES ($1, $2, $3, $4, $4, 1)
         ON CONFLICT (telegram_id) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, users.name),
           username = COALESCE(EXCLUDED.username, users.username),
           last_seen = EXCLUDED.last_seen,
           seen_count = users.seen_count + 1
         RETURNING *`,
        [u.id, u.name ?? null, u.username ?? null, iso(now)],
      );
      return mapUser(r.rows[0]!);
    },
    async getUser(id: number): Promise<UserRow | null> {
      const r = await db.query("SELECT * FROM users WHERE telegram_id = $1", [id]);
      return r.rows[0] ? mapUser(r.rows[0]) : null;
    },
    async setLanguage(id: number, lang: string) {
      await db.query("UPDATE users SET language = $2 WHERE telegram_id = $1", [id, lang]);
    },
    /** Ghi đè từng khoá hồ sơ (vd thiết bị mới nhất khách nêu). */
    async updateProfile(id: number, patch: Record<string, { value: string; seen_at: string }>) {
      await db.query("UPDATE users SET profile = profile || $2::jsonb WHERE telegram_id = $1", [id, JSON.stringify(patch)]);
    },
    async setFlag(id: number, key: string, value: unknown) {
      await db.query("UPDATE users SET flags = flags || $2::jsonb WHERE telegram_id = $1", [id, JSON.stringify({ [key]: value })]);
    },
    async listUsers(opts: { q?: string; limit: number; offset: number }) {
      const q = opts.q ? `%${opts.q.replace(/[%_]/g, "")}%` : null;
      const r = await db.query(
        `SELECT u.*, (SELECT count(*)::int FROM episodes e WHERE e.user_id = u.telegram_id) AS episode_count
         FROM users u
         WHERE $1::text IS NULL OR u.username ILIKE $1 OR u.name ILIKE $1 OR u.telegram_id::text LIKE $1
         ORDER BY u.last_seen DESC LIMIT $2 OFFSET $3`,
        [q, opts.limit, opts.offset],
      );
      return r.rows.map((x) => ({ ...mapUser(x), episode_count: num(x.episode_count) }));
    },
    /** Mọi ngôn ngữ khách đã dùng (users.language) — danh sách dịch sẵn câu khẩn. */
    async knownLanguages(): Promise<string[]> {
      const r = await db.query<{ language: string }>("SELECT DISTINCT language FROM users WHERE language IS NOT NULL ORDER BY language");
      return r.rows.map((x) => x.language);
    },
    async allUserIds(): Promise<number[]> {
      const r = await db.query("SELECT telegram_id FROM users ORDER BY telegram_id");
      return r.rows.map((x) => num(x.telegram_id));
    },

    // ---- Anti-spam ----
    async getAntispam(userId: number): Promise<AntispamState | null> {
      const r = await db.query<{ offtopic_count: number; blocked_until: Date | null; last_seen: Date }>("SELECT * FROM antispam WHERE user_id = $1", [userId]);
      const x = r.rows[0];
      return x ? { offtopic_count: num(x.offtopic_count), blocked_until: x.blocked_until, last_seen: x.last_seen } : null;
    },
    async saveAntispam(userId: number, s: AntispamState) {
      await db.query(
        `INSERT INTO antispam (user_id, offtopic_count, blocked_until, last_seen) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET offtopic_count = $2, blocked_until = $3, last_seen = $4`,
        [userId, s.offtopic_count, s.blocked_until ? iso(s.blocked_until) : null, iso(s.last_seen)],
      );
    },
    /** Dọn antispam không hoạt động quá `days` ngày (HEARTBEAT.md: 30 ngày). Trả về số dòng đã xoá. */
    async deleteStaleAntispam(cutoff: Date): Promise<number> {
      const r = await db.query("DELETE FROM antispam WHERE last_seen < $1", [iso(cutoff)]);
      return r.rowCount;
    },

    // ---- Episode ----
    async getActiveEpisode(userId: number): Promise<EpisodeRow | null> {
      const r = await db.query("SELECT * FROM episodes WHERE user_id = $1 AND status IN ('open', 'dormant') ORDER BY last_activity_at DESC, id DESC LIMIT 1", [userId]);
      return r.rows[0] ? mapEpisode(r.rows[0]) : null;
    },
    /** Episode đã đóng gần đây cùng chủ đề (để nối tiếp khi khách quay lại). */
    async getRecentClosedEpisode(userId: number, topicKey: string, since: Date): Promise<EpisodeRow | null> {
      const r = await db.query(
        "SELECT * FROM episodes WHERE user_id = $1 AND topic_key = $2 AND status IN ('resolved', 'escalated') AND last_activity_at >= $3 ORDER BY last_activity_at DESC LIMIT 1",
        [userId, topicKey, iso(since)],
      );
      return r.rows[0] ? mapEpisode(r.rows[0]) : null;
    },
    /** Vụ việc đang tạm lắng cùng chủ đề (khách quay lại vấn đề cũ): mở lại thay vì tạo mới. */
    async getDormantEpisodeByTopic(userId: number, topicKey: string, since: Date, excludeId: number | null): Promise<EpisodeRow | null> {
      const r = await db.query(
        "SELECT * FROM episodes WHERE user_id = $1 AND topic_key = $2 AND status = 'dormant' AND last_activity_at >= $3 AND id IS DISTINCT FROM $4::bigint ORDER BY last_activity_at DESC LIMIT 1",
        [userId, topicKey, iso(since), excludeId],
      );
      return r.rows[0] ? mapEpisode(r.rows[0]) : null;
    },
    async getLatestEpisode(userId: number): Promise<EpisodeRow | null> {
      const r = await db.query("SELECT * FROM episodes WHERE user_id = $1 ORDER BY last_activity_at DESC LIMIT 1", [userId]);
      return r.rows[0] ? mapEpisode(r.rows[0]) : null;
    },
    async getEpisode(id: number): Promise<EpisodeRow | null> {
      const r = await db.query("SELECT * FROM episodes WHERE id = $1", [id]);
      return r.rows[0] ? mapEpisode(r.rows[0]) : null;
    },
    /** Mở episode mới kèm mã tham chiếu (sinh ngẫu nhiên, trùng thì sinh lại). */
    async openEpisode(e: { userId: number; parentId?: number | null; issue?: string | null; topicGroup?: string | null; topicKey?: string | null }, now: Date): Promise<EpisodeRow> {
      let code = newRefCode();
      for (let attempt = 0; attempt < 10 && (await db.query("SELECT 1 FROM episodes WHERE ref_code = $1", [code])).rowCount > 0; attempt++) code = newRefCode();
      const r = await db.query(
        "INSERT INTO episodes (user_id, parent_episode_id, issue, topic_group, topic_key, ref_code, opened_at, last_activity_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *",
        [e.userId, e.parentId ?? null, e.issue ?? null, e.topicGroup ?? null, e.topicKey ?? null, code, iso(now)],
      );
      return mapEpisode(r.rows[0]!);
    },
    /** Ghi điểm neo MỘT lần: episode đã có neo thì giữ nguyên. */
    async setAnchor(id: number, messageId: number, queryEn: string | null) {
      await db.query("UPDATE episodes SET anchor_message_id = $2, anchor_query_en = $3 WHERE id = $1 AND anchor_message_id IS NULL", [id, messageId, queryEn]);
    },
    async updateEpisode(
      id: number,
      p: Partial<{ issue: string | null; topic_group: string | null; topic_key: string | null; status: EpisodeStatus; last_template_id: string | null; last_ref: string | null; last_bot_action: string | null; last_activity_at: Date; closed_at: Date | null; pending_clarify: { items: string[] } | null; clarify_count: number }>,
    ) {
      const sets: string[] = [];
      const vals: unknown[] = [id];
      for (const [k, v] of Object.entries(p)) {
        vals.push(v instanceof Date ? iso(v) : v);
        sets.push(`${k} = $${vals.length}`);
      }
      if (sets.length) await db.query(`UPDATE episodes SET ${sets.join(", ")} WHERE id = $1`, vals);
    },
    async saveSummary(id: number, summary: Record<string, unknown>, uptoMessageId: number | null) {
      await db.query("UPDATE episodes SET summary = $2::jsonb, summary_version = summary_version + 1, summary_upto_message_id = $3 WHERE id = $1", [id, JSON.stringify(summary), uptoMessageId]);
    },
    async recentEpisodes(userId: number, limit = 5): Promise<EpisodeRow[]> {
      const r = await db.query("SELECT * FROM episodes WHERE user_id = $1 ORDER BY last_activity_at DESC LIMIT $2", [userId, limit]);
      return r.rows.map(mapEpisode);
    },
    /** Episode im lặng quá ngưỡng: open -> dormant. Trả về số dòng. */
    async markDormant(before: Date): Promise<number> {
      const r = await db.query("UPDATE episodes SET status = 'dormant', pending_clarify = NULL WHERE status = 'open' AND last_activity_at < $1", [iso(before)]);
      return r.rowCount;
    },
    /** Episode bỏ dở quá lâu: dormant -> resolved (không xoá, lịch sử còn cho admin). */
    async closeAbandoned(before: Date, now: Date): Promise<number> {
      const r = await db.query("UPDATE episodes SET status = 'resolved', closed_at = $2 WHERE status = 'dormant' AND last_activity_at < $1", [iso(before), iso(now)]);
      return r.rowCount;
    },

    // ---- Tin nhắn / sự kiện / quyết định ----
    async addMessage(m: {
      episodeId: number | null;
      userId: number;
      direction: "in" | "out";
      text: string | null;
      imageRef?: string | null;
      imageType?: string | null;
      language?: string | null;
      tier?: number | null;
      templateId?: string | null;
      telegramMessageId?: number | null;
      latencyMs?: number | null;
      /** mốc thời gian theo đồng hồ của pipeline (mặc định: now() của DB) */
      at?: Date;
    }): Promise<number> {
      const r = await db.query<{ id: string }>(
        `INSERT INTO messages (episode_id, user_id, direction, text, image_ref, image_type, language, tier, template_id, telegram_message_id, latency_ms, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::timestamptz, now())) RETURNING id`,
        [m.episodeId, m.userId, m.direction, m.text, m.imageRef ?? null, m.imageType ?? null, m.language ?? null, m.tier ?? null, m.templateId ?? null, m.telegramMessageId ?? null, m.latencyMs ?? null, m.at ? iso(m.at) : null],
      );
      return num(r.rows[0]!.id);
    },
    async messagesAfter(episodeId: number, afterId: number | null, limit = 12): Promise<MessageRow[]> {
      const r = await db.query("SELECT * FROM (SELECT * FROM messages WHERE episode_id = $1 AND id > $2 ORDER BY id DESC LIMIT $3) t ORDER BY id", [episodeId, afterId ?? 0, limit]);
      return r.rows.map(mapMessage);
    },
    /** Ảnh khách gửi kèm tin (đường dẫn trong MEDIA_DIR, nhiều ảnh ngăn bằng dấu phẩy): để xoá / mở ảnh theo khách. */
    async setMessageImages(messageId: number, refs: string[], imageType: string | null) {
      await db.query("UPDATE messages SET image_ref = $2, image_type = $3 WHERE id = $1", [messageId, refs.length ? refs.join(",") : null, imageType]);
    },
    async linkMessage(messageId: number, episodeId: number) {
      await db.query("UPDATE messages SET episode_id = $2 WHERE id = $1", [messageId, episodeId]);
    },
    /** Tin khách gửi lúc mất kết nối AI, chưa thuộc vụ việc nào, từ `since` (event unanswered_question). Cũ nhất trước. */
    async unansweredMessages(userId: number, since: Date): Promise<number[]> {
      const r = await db.query<{ id: string }>(
        `SELECT m.id FROM events e JOIN messages m ON m.id = (e.payload->>'message_id')::bigint
         WHERE e.user_id = $1 AND e.type = 'unanswered_question' AND e.at >= $2 AND m.episode_id IS NULL ORDER BY m.id`,
        [userId, iso(since)],
      );
      return r.rows.map((x) => num(x.id));
    },
    async allMessages(episodeId: number): Promise<MessageRow[]> {
      const r = await db.query("SELECT * FROM messages WHERE episode_id = $1 ORDER BY id", [episodeId]);
      return r.rows.map(mapMessage);
    },
    async countUnsummarized(episodeId: number, afterId: number | null): Promise<number> {
      const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM messages WHERE episode_id = $1 AND id > $2", [episodeId, afterId ?? 0]);
      return num(r.rows[0]!.n);
    },
    async lastMessageId(episodeId: number): Promise<number | null> {
      const r = await db.query<{ id: string | null }>("SELECT max(id) AS id FROM messages WHERE episode_id = $1", [episodeId]);
      return numOrNull(r.rows[0]?.id);
    },

    async addEvent(e: { userId: number; episodeId?: number | null; type: string; payload?: Record<string, unknown> }, now?: Date): Promise<number> {
      const r = await db.query<{ id: string }>(
        "INSERT INTO events (user_id, episode_id, type, payload, at) VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::timestamptz, now())) RETURNING id",
        [e.userId, e.episodeId ?? null, e.type, JSON.stringify(e.payload ?? {}), now ? iso(now) : null],
      );
      return num(r.rows[0]!.id);
    },
    async episodeEvents(episodeId: number): Promise<EventRow[]> {
      const r = await db.query("SELECT * FROM events WHERE episode_id = $1 ORDER BY id", [episodeId]);
      return r.rows.map(mapEvent);
    },
    async userEvents(userId: number, types: string[], limit = 50): Promise<EventRow[]> {
      const r = await db.query("SELECT * FROM events WHERE user_id = $1 AND type = ANY($2::text[]) ORDER BY id DESC LIMIT $3", [userId, types, limit]);
      return r.rows.map(mapEvent);
    },

    async addDecision(d: {
      messageId: number | null;
      episodeId: number | null;
      userId: number;
      kind: string;
      tier?: number | null;
      templateId?: string | null;
      via?: string | null;
      reason?: string | null;
      candidates?: unknown;
      gates?: unknown;
      notes?: unknown;
      kbVersion?: number | null;
      at?: Date;
    }): Promise<number> {
      const r = await db.query<{ id: string }>(
        `INSERT INTO decisions (message_id, episode_id, user_id, kind, tier, template_id, via, reason, candidates, gates, notes, kb_version, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12, COALESCE($13::timestamptz, now())) RETURNING id`,
        [d.messageId, d.episodeId, d.userId, d.kind, d.tier ?? null, d.templateId ?? null, d.via ?? null, d.reason ?? null, JSON.stringify(d.candidates ?? null), JSON.stringify(d.gates ?? null), JSON.stringify(d.notes ?? null), d.kbVersion ?? null, d.at ? iso(d.at) : null],
      );
      return num(r.rows[0]!.id);
    },

    // ---- Ticket ----
    async createTicket(t: { episodeId: number | null; userId: number; category?: string | null; errorCode?: string | null; pic?: string | null; reason?: string | null; requiredInfo?: string[] | null; sourceTemplateId?: string | null; episodeRefCode?: string | null }): Promise<TicketRow> {
      const r = await db.query(
        `INSERT INTO tickets (episode_id, user_id, category, error_code, pic, reason, required_info, source_template_id, episode_ref_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
        [t.episodeId, t.userId, t.category ?? null, t.errorCode ?? null, t.pic ?? null, t.reason ?? null, JSON.stringify(t.requiredInfo ?? null), t.sourceTemplateId ?? null, t.episodeRefCode ?? null],
      );
      return mapTicket(r.rows[0]!);
    },
    /** Ticket còn mở của khách (nối tiếp thay vì tạo trùng khi khách quay lại chủ đề đã escalate). */
    async openTicketFor(userId: number, category: string | null): Promise<TicketRow | null> {
      const r = await db.query("SELECT * FROM tickets WHERE user_id = $1 AND status <> 'closed' AND category IS NOT DISTINCT FROM $2::text ORDER BY created_at DESC LIMIT 1", [userId, category]);
      return r.rows[0] ? mapTicket(r.rows[0]) : null;
    },
    async appendTicketNote(id: number, note: string, episodeRefCode?: string | null) {
      await db.query("UPDATE tickets SET notes = COALESCE(notes || E'\\n', '') || $2, episode_ref_code = COALESCE(episode_ref_code, $3), updated_at = now() WHERE id = $1", [id, note, episodeRefCode ?? null]);
    },
    /** `ref`: mã tham chiếu khách gửi cho support ("EP-XXXXX") — tìm ticket của đúng vụ việc đó. */
    async listTickets(opts: { status?: string; ref?: string; limit: number; offset: number }) {
      const r = await db.query(
        `SELECT t.*, u.name AS user_name, u.username AS user_username FROM tickets t LEFT JOIN users u ON u.telegram_id = t.user_id
         WHERE ($1::text IS NULL OR t.status = $1) AND ($4::text IS NULL OR t.episode_ref_code = $4) ORDER BY t.created_at DESC LIMIT $2 OFFSET $3`,
        [opts.status ?? null, opts.limit, opts.offset, opts.ref ? opts.ref.trim().toUpperCase() : null],
      );
      return r.rows.map((x) => ({ ...mapTicket(x), user_name: x.user_name as string | null, user_username: x.user_username as string | null }));
    },
    async updateTicket(id: number, p: { status?: string; pic?: string | null; notes?: string | null }) {
      // Trường có trong `p` được ghi (kể cả null để xoá PIC/ghi chú); trường vắng mặt giữ nguyên.
      const sets: string[] = ["updated_at = now()"];
      const vals: unknown[] = [id];
      for (const k of ["status", "pic", "notes"] as const) {
        if (p[k] === undefined) continue;
        vals.push(p[k]);
        sets.push(`${k} = $${vals.length}`);
      }
      await db.query(`UPDATE tickets SET ${sets.join(", ")} WHERE id = $1`, vals);
    },

    // ---- LLM usage ----
    async addLlmCall(c: { messageId?: number | null; userId?: number | null; purpose: string; provider?: string | null; model?: string | null; inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; cost?: number; latencyMs?: number | null; ok?: boolean; error?: string | null }, at?: Date) {
      await db.query(
        `INSERT INTO llm_calls (message_id, user_id, purpose, provider, model, input_tokens, output_tokens, cache_read, cache_write, cost, latency_ms, ok, error, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, COALESCE($14::timestamptz, now()))`,
        [c.messageId ?? null, c.userId ?? null, c.purpose, c.provider ?? null, c.model ?? null, c.inputTokens ?? 0, c.outputTokens ?? 0, c.cacheRead ?? 0, c.cacheWrite ?? 0, c.cost ?? 0, c.latencyMs ?? null, c.ok ?? true, c.error ?? null, at ? iso(at) : null],
      );
    },
  };
}

export type ConvRepo = ReturnType<typeof convRepo>;

/** Bảng chữ của mã tham chiếu: bỏ 0/O, 1/I/L để khách đọc và gõ lại không nhầm (khớp REF_CODE_PATTERN ở core/translate.ts). */
const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newRefCode(): string {
  let s = "EP-";
  for (let i = 0; i < 5; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return s;
}
export { mapEpisode, mapEvent, mapMessage, mapTicket, mapUser };
