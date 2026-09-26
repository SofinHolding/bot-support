/** Truy cập dữ liệu vận hành: cấu hình, quản trị, kiểm toán, job nền, thống kê, usage, hộp thư đi. */
import { iso, num, numOrNull, type Db } from "./db";

export type AdminRole = "owner" | "admin" | "viewer";
export interface AdminRow {
  telegram_id: number;
  role: AdminRole;
  name: string | null;
}

export interface JobRow {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

const TZ = "Asia/Bangkok";

export function opsRepo(db: Db) {
  return {
    // ---- Cấu hình ----
    async getSettings(): Promise<Record<string, unknown>> {
      const r = await db.query<{ key: string; value: unknown }>("SELECT key, value FROM settings");
      return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    },
    async setSetting(key: string, value: unknown, by: string) {
      await db.query("INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_by = $3, updated_at = now()", [key, JSON.stringify(value), by]);
    },
    async getProtected(): Promise<Record<string, unknown>> {
      const r = await db.query<{ key: string; value: unknown }>("SELECT key, value FROM protected_settings");
      return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    },
    async setProtected(key: string, value: unknown, by: string) {
      await db.query("INSERT INTO protected_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_by = $3, updated_at = now()", [key, JSON.stringify(value), by]);
    },
    async getSecret(key: string): Promise<string | null> {
      const r = await db.query<{ value: string }>("SELECT value FROM secrets WHERE key = $1", [key]);
      return r.rows[0]?.value ?? null;
    },
    async setSecret(key: string, value: string, by: string) {
      await db.query("INSERT INTO secrets (key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()", [key, value, by]);
    },
    async deleteSecret(key: string) {
      await db.query("DELETE FROM secrets WHERE key = $1", [key]);
    },
    async deleteSetting(key: string) {
      await db.query("DELETE FROM settings WHERE key = $1", [key]);
    },
    async kbVersion(): Promise<number> {
      const r = await db.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'kb_version'");
      return r.rows[0] ? Number(r.rows[0].value) : 0;
    },
    async bumpKbVersion(by: string): Promise<number> {
      const next = (await this.kbVersion()) + 1;
      await this.setSetting("kb_version", next, by);
      return next;
    },

    // ---- Admin / phiên đăng nhập ----
    async listAdmins(): Promise<AdminRow[]> {
      const r = await db.query("SELECT * FROM admins ORDER BY role, telegram_id");
      return r.rows.map((x) => ({ telegram_id: num(x.telegram_id), role: x.role as AdminRole, name: (x.name as string | null) ?? null }));
    },
    async getAdmin(id: number): Promise<AdminRow | null> {
      const r = await db.query("SELECT * FROM admins WHERE telegram_id = $1", [id]);
      const x = r.rows[0];
      return x ? { telegram_id: num(x.telegram_id), role: x.role as AdminRole, name: (x.name as string | null) ?? null } : null;
    },
    async upsertAdmin(id: number, role: AdminRole, name: string | null) {
      await db.query("INSERT INTO admins (telegram_id, role, name) VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO UPDATE SET role = $2, name = COALESCE($3, admins.name)", [id, role, name]);
    },
    async removeAdmin(id: number) {
      await db.query("DELETE FROM admins WHERE telegram_id = $1", [id]);
    },
    async createLoginCode(telegramId: number, codeHash: string, expiresAt: Date) {
      await db.query("DELETE FROM admin_login_codes WHERE telegram_id = $1", [telegramId]);
      await db.query("INSERT INTO admin_login_codes (telegram_id, code_hash, expires_at) VALUES ($1,$2,$3)", [telegramId, codeHash, iso(expiresAt)]);
    },
    async recentLoginCodes(telegramId: number, since: Date): Promise<number> {
      const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM admin_login_codes WHERE telegram_id = $1 AND created_at >= $2", [telegramId, iso(since)]);
      return num(r.rows[0]!.n);
    },
    /** Kiểm tra mã: đúng -> xoá và trả true; sai -> tăng số lần thử (tối đa 5). */
    async consumeLoginCode(telegramId: number, codeHash: string, now: Date): Promise<boolean> {
      const r = await db.query<{ code_hash: string; attempts: number; expires_at: Date }>("SELECT * FROM admin_login_codes WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 1", [telegramId]);
      const row = r.rows[0];
      if (!row || row.expires_at.getTime() < now.getTime() || num(row.attempts) >= 5) return false;
      if (row.code_hash !== codeHash) {
        await db.query("UPDATE admin_login_codes SET attempts = attempts + 1 WHERE telegram_id = $1", [telegramId]);
        return false;
      }
      await db.query("DELETE FROM admin_login_codes WHERE telegram_id = $1", [telegramId]);
      return true;
    },
    async createSession(tokenHash: string, telegramId: number, expiresAt: Date) {
      await db.query("INSERT INTO admin_sessions (token_hash, telegram_id, expires_at) VALUES ($1,$2,$3)", [tokenHash, telegramId, iso(expiresAt)]);
    },
    async getSession(tokenHash: string, now: Date): Promise<{ telegram_id: number } | null> {
      const r = await db.query("SELECT telegram_id FROM admin_sessions WHERE token_hash = $1 AND expires_at > $2", [tokenHash, iso(now)]);
      if (!r.rows[0]) return null;
      await db.query("UPDATE admin_sessions SET last_seen = $2 WHERE token_hash = $1", [tokenHash, iso(now)]);
      return { telegram_id: num(r.rows[0].telegram_id) };
    },
    async deleteSession(tokenHash: string) {
      await db.query("DELETE FROM admin_sessions WHERE token_hash = $1", [tokenHash]);
    },
    async purgeExpiredAuth(now: Date) {
      await db.query("DELETE FROM admin_sessions WHERE expires_at < $1", [iso(now)]);
      await db.query("DELETE FROM admin_login_codes WHERE expires_at < $1", [iso(now)]);
    },

    // ---- Audit và thay đổi chờ duyệt ----
    async audit(actor: string, action: string, entity: string | null, before: unknown, after: unknown) {
      await db.query("INSERT INTO audit_log (actor, action, entity, before, after) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)", [actor, action, entity, JSON.stringify(before ?? null), JSON.stringify(after ?? null)]);
    },
    async listAudit(limit: number, offset: number) {
      const r = await db.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT $1 OFFSET $2", [limit, offset]);
      return r.rows.map((x) => ({ ...x, id: num(x.id) }));
    },
    async proposeChange(kind: string, payload: unknown, proposedBy: number): Promise<number> {
      const r = await db.query<{ id: string }>("INSERT INTO pending_changes (kind, payload, proposed_by) VALUES ($1,$2::jsonb,$3) RETURNING id", [kind, JSON.stringify(payload), proposedBy]);
      return num(r.rows[0]!.id);
    },
    async getChange(id: number) {
      const r = await db.query("SELECT * FROM pending_changes WHERE id = $1", [id]);
      const x = r.rows[0];
      return x ? { id: num(x.id), kind: String(x.kind), payload: x.payload as Record<string, unknown>, proposed_by: num(x.proposed_by), status: String(x.status) } : null;
    },
    async listChanges(status = "pending") {
      const r = await db.query("SELECT * FROM pending_changes WHERE status = $1 ORDER BY id DESC LIMIT 100", [status]);
      return r.rows.map((x) => ({ id: num(x.id), kind: String(x.kind), payload: x.payload as Record<string, unknown>, proposed_by: num(x.proposed_by), proposed_at: x.proposed_at as Date, status: String(x.status) }));
    },
    async decideChange(id: number, status: "approved" | "rejected", by: number) {
      await db.query("UPDATE pending_changes SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'pending'", [id, status, by]);
    },

    // ---- Job nền ----
    async enqueueJob(type: string, payload: Record<string, unknown> = {}, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}): Promise<boolean> {
      const r = await db.query(
        "INSERT INTO jobs (type, payload, run_at, dedupe_key, max_attempts) VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, now()), $4, $5) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id",
        [type, JSON.stringify(payload), opts.runAt ? iso(opts.runAt) : null, opts.dedupeKey ?? null, opts.maxAttempts ?? 5],
      );
      return r.rowCount === 1;
    },
    async claimJob(): Promise<JobRow | null> {
      const r = await db.query(
        `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id, type, payload, attempts, max_attempts`,
      );
      const x = r.rows[0];
      return x ? { id: num(x.id), type: String(x.type), payload: x.payload as Record<string, unknown>, attempts: num(x.attempts), max_attempts: num(x.max_attempts) } : null;
    },
    /** Còn việc loại này đang chờ/đang chạy không (để giao diện báo "đang đánh chỉ mục lại"). */
    async hasPendingJob(type: string): Promise<boolean> {
      const r = await db.query("SELECT 1 FROM jobs WHERE type = $1 AND status IN ('queued', 'running') LIMIT 1", [type]);
      return r.rowCount > 0;
    },
    // Xong (done/dead) thì trả lại dedupe_key: khoá này nghĩa là "mỗi lúc chỉ một việc như vậy đang chờ", không phải "chỉ một lần trong đời".
    // (Trước đây key UNIQUE không được trả lại nên vd "reindex:model-change" chỉ xếp được đúng một lần; các lần đổi model sau bị bỏ qua im lặng.)
    async completeJob(id: number) {
      await db.query("UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL, dedupe_key = NULL WHERE id = $1", [id]);
    },
    /** Lỗi: thử lại với backoff luỹ thừa; quá số lần -> 'dead' (dead-letter). Trả về trạng thái mới. */
    async failJob(job: JobRow, error: string): Promise<"queued" | "dead"> {
      if (job.attempts >= job.max_attempts) {
        await db.query("UPDATE jobs SET status = 'dead', finished_at = now(), last_error = $2, dedupe_key = NULL WHERE id = $1", [job.id, error.slice(0, 2000)]);
        return "dead";
      }
      const delaySec = Math.min(3600, 30 * 2 ** (job.attempts - 1));
      await db.query("UPDATE jobs SET status = 'queued', run_at = now() + ($3 || ' seconds')::interval, last_error = $2 WHERE id = $1", [job.id, error.slice(0, 2000), String(delaySec)]);
      return "queued";
    },
    async requeueStuckJobs(olderThanMinutes = 15): Promise<number> {
      const r = await db.query("UPDATE jobs SET status = 'queued' WHERE status = 'running' AND locked_at < now() - ($1 || ' minutes')::interval", [String(olderThanMinutes)]);
      return r.rowCount;
    },
    async jobStats() {
      const r = await db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM jobs GROUP BY status");
      return Object.fromEntries(r.rows.map((x) => [x.status, num(x.n)]));
    },
    async deadJobs(limit = 50) {
      const r = await db.query("SELECT id, type, attempts, last_error, finished_at FROM jobs WHERE status = 'dead' ORDER BY id DESC LIMIT $1", [limit]);
      return r.rows.map((x) => ({ ...x, id: num(x.id) }));
    },
    async setCron(name: string, status: string, error: string | null, result: unknown) {
      await db.query(
        `INSERT INTO cron_state (name, last_run_at, last_status, last_error, last_result) VALUES ($1, now(), $2, $3, $4::jsonb)
         ON CONFLICT (name) DO UPDATE SET last_run_at = now(), last_status = $2, last_error = $3, last_result = $4::jsonb`,
        [name, status, error, JSON.stringify(result ?? null)],
      );
    },
    async listCron() {
      const r = await db.query("SELECT * FROM cron_state ORDER BY name");
      return r.rows;
    },

    // ---- Hộp thư đi ----
    async enqueueOutbox(chatId: number, text: string, dedupeKey: string | null, entities?: { type: "pre"; offset: number; length: number }[]): Promise<number | null> {
      const r = await db.query<{ id: string }>("INSERT INTO outbox (chat_id, text, dedupe_key, entities) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id", [chatId, text, dedupeKey, entities?.length ? JSON.stringify(entities) : null]);
      return r.rows[0] ? num(r.rows[0].id) : null;
    },
    async dueOutbox(limit = 50) {
      const r = await db.query("SELECT * FROM outbox WHERE status = 'queued' AND next_at <= now() ORDER BY id LIMIT $1", [limit]);
      return r.rows.map((x) => ({ id: num(x.id), chat_id: num(x.chat_id), text: String(x.text), attempts: num(x.attempts), entities: (x.entities as { type: "pre"; offset: number; length: number }[] | null) ?? undefined }));
    },
    async outboxSent(id: number) {
      await db.query("UPDATE outbox SET status = 'sent', sent_at = now() WHERE id = $1", [id]);
    },
    async outboxFailed(id: number, attempts: number, error: string, maxAttempts = 5) {
      if (attempts + 1 >= maxAttempts) await db.query("UPDATE outbox SET status = 'dead', attempts = attempts + 1, last_error = $2 WHERE id = $1", [id, error.slice(0, 500)]);
      else await db.query("UPDATE outbox SET attempts = attempts + 1, last_error = $2, next_at = now() + ($3 || ' seconds')::interval WHERE id = $1", [id, error.slice(0, 500), String(30 * 2 ** attempts)]);
    },
    async outboxStats() {
      const r = await db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM outbox GROUP BY status");
      return Object.fromEntries(r.rows.map((x) => [x.status, num(x.n)]));
    },

    // ---- Usage (giờ Asia/Bangkok như báo cáo cũ) ----
    async usageByDay(fromDay: string, toDay: string) {
      const r = await db.query(
        `SELECT (created_at AT TIME ZONE '${TZ}')::date::text AS day,
                count(*)::int AS requests, COALESCE(sum(input_tokens),0)::bigint AS input, COALESCE(sum(output_tokens),0)::bigint AS output,
                COALESCE(sum(cache_read),0)::bigint AS cache_read, COALESCE(sum(cache_write),0)::bigint AS cache_write,
                COALESCE(sum(cost),0)::float8 AS cost, count(DISTINCT user_id)::int AS unique_users
         FROM llm_calls WHERE (created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`,
        [fromDay, toDay],
      );
      return r.rows.map((x) => {
        const input = num(x.input);
        const output = num(x.output);
        const cr = num(x.cache_read);
        const cw = num(x.cache_write);
        return { day: String(x.day), requests: num(x.requests), input, output, cacheRead: cr, cacheWrite: cw, totalTokens: input + output + cr + cw, cost: num(x.cost), uniqueUsers: num(x.unique_users) };
      });
    },
    async usageHourly(day: string) {
      const r = await db.query(
        `SELECT to_char(created_at AT TIME ZONE '${TZ}', 'HH24') AS hour, count(*)::int AS requests,
                COALESCE(sum(input_tokens + output_tokens + cache_read + cache_write),0)::bigint AS tokens
         FROM llm_calls WHERE (created_at AT TIME ZONE '${TZ}')::date = $1::date GROUP BY 1 ORDER BY 1`,
        [day],
      );
      return r.rows.map((x) => ({ hour: String(x.hour), requests: num(x.requests), tokens: num(x.tokens) }));
    },
    async usageTopUsers(fromDay: string, toDay: string, limit = 20) {
      const r = await db.query(
        `SELECT c.user_id, u.name, u.username, count(*)::int AS requests,
                COALESCE(sum(c.input_tokens + c.output_tokens + c.cache_read + c.cache_write),0)::bigint AS tokens
         FROM llm_calls c LEFT JOIN users u ON u.telegram_id = c.user_id
         WHERE c.user_id IS NOT NULL AND (c.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date
         GROUP BY c.user_id, u.name, u.username ORDER BY tokens DESC LIMIT $3`,
        [fromDay, toDay, limit],
      );
      return r.rows.map((x) => ({ userId: num(x.user_id), name: (x.name as string | null) ?? null, username: (x.username as string | null) ?? null, requests: num(x.requests), totalTokens: num(x.tokens) }));
    },
    async tokensUsedByUserSince(userId: number, since: Date): Promise<number> {
      const r = await db.query<{ n: string }>("SELECT COALESCE(sum(input_tokens + output_tokens),0)::bigint AS n FROM llm_calls WHERE user_id = $1 AND created_at >= $2", [userId, iso(since)]);
      return num(r.rows[0]!.n);
    },
    /** Làm mới bảng usage_daily cho các ngày gần đây (thay usage-aggregator.mjs chạy hàng giờ). */
    async aggregateUsage(fromDay: string, toDay: string): Promise<number> {
      const rows = await this.usageByDay(fromDay, toDay);
      for (const d of rows) {
        await db.query(
          `INSERT INTO usage_daily (day, requests, input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost, unique_users, updated_at)
           VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9, now())
           ON CONFLICT (day) DO UPDATE SET requests=$2, input_tokens=$3, output_tokens=$4, cache_read=$5, cache_write=$6, total_tokens=$7, cost=$8, unique_users=$9, updated_at=now()`,
          [d.day, d.requests, d.input, d.output, d.cacheRead, d.cacheWrite, d.totalTokens, d.cost, d.uniqueUsers],
        );
      }
      return rows.length;
    },

    // ---- Dashboard / thống kê ----
    async dashboard(fromDay: string, toDay: string) {
      const range = `(created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`;
      const [byTier, byKind, topTemplates, unmatched, totals, escalationsByDay] = await Promise.all([
        db.query(`SELECT COALESCE(tier, -1)::int AS tier, count(*)::int AS n FROM decisions WHERE ${range} GROUP BY 1 ORDER BY 1`, [fromDay, toDay]),
        db.query(`SELECT kind, count(*)::int AS n FROM decisions WHERE ${range} GROUP BY 1 ORDER BY 2 DESC`, [fromDay, toDay]),
        db.query(`SELECT template_id, count(*)::int AS n FROM decisions WHERE ${range} AND template_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [fromDay, toDay]),
        db.query(
          `SELECT m.text, d.reason, d.created_at FROM decisions d JOIN messages m ON m.id = d.message_id
           WHERE (d.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date AND (d.notes->>'new_question') = 'true' ORDER BY d.id DESC LIMIT 30`,
          [fromDay, toDay],
        ),
        db.query(`SELECT count(*)::int AS messages, count(DISTINCT user_id)::int AS users FROM messages WHERE direction = 'in' AND ${range}`, [fromDay, toDay]),
        db.query(`SELECT (created_at AT TIME ZONE '${TZ}')::date::text AS day, count(*)::int AS n FROM decisions WHERE kind = 'ESCALATE' AND ${range} GROUP BY 1 ORDER BY 1`, [fromDay, toDay]),
      ]);
      return {
        totals: { messages: num(totals.rows[0]?.messages), users: num(totals.rows[0]?.users) },
        byTier: byTier.rows.map((x) => ({ tier: num(x.tier), n: num(x.n) })),
        byKind: byKind.rows.map((x) => ({ kind: String(x.kind), n: num(x.n) })),
        topTemplates: topTemplates.rows.map((x) => ({ templateId: String(x.template_id), n: num(x.n) })),
        unmatched: unmatched.rows.map((x) => ({ text: String(x.text ?? ""), reason: String(x.reason ?? ""), at: x.created_at as Date })),
        escalationsByDay: escalationsByDay.rows.map((x) => ({ day: String(x.day), n: num(x.n) })),
      };
    },
    /** Số lần bot chuyển support trong một ngày Bangkok (cảnh báo > ngưỡng, HEARTBEAT/cron cũ). */
    async escalationsOn(day: string): Promise<number> {
      const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM decisions WHERE kind = 'ESCALATE' AND (created_at AT TIME ZONE '${TZ}')::date = $1::date`, [day]);
      return num(r.rows[0]!.n);
    },
    /** Thống kê tuần (Chủ nhật/thứ Hai): tổng hội thoại, top 3 chủ đề, câu hỏi mới ngoài KB, case chưa xong. */
    async computeWeeklyStats(weekStart: string) {
      const win = `(e.opened_at AT TIME ZONE '${TZ}')::date >= ($1::date - 7) AND (e.opened_at AT TIME ZONE '${TZ}')::date < $1::date`;
      const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM episodes e WHERE ${win}`, [weekStart]);
      const top = await db.query(`SELECT COALESCE(e.topic_group, 'Other') AS issue, count(*)::int AS n FROM episodes e WHERE ${win} GROUP BY 1 ORDER BY 2 DESC LIMIT 3`, [weekStart]);
      const unresolved = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM episodes e WHERE ${win} AND e.status IN ('open','dormant','escalated')`, [weekStart]);
      const newQ = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM decisions d WHERE (d.created_at AT TIME ZONE '${TZ}')::date >= ($1::date - 7) AND (d.created_at AT TIME ZONE '${TZ}')::date < $1::date AND (d.notes->>'new_question') = 'true'`, [weekStart]);
      return { totalConversations: num(total.rows[0]!.n), topIssues: top.rows.map((x) => ({ issue: String(x.issue), count: num(x.n) })), newQuestions: num(newQ.rows[0]!.n), unresolved: num(unresolved.rows[0]!.n) };
    },
    async saveWeeklyStats(weekStart: string, s: { totalConversations: number; topIssues: unknown; newQuestions: number; unresolved: number }) {
      await db.query(
        `INSERT INTO weekly_stats (week_start, total_conversations, top_issues, new_questions, unresolved) VALUES ($1::date,$2,$3::jsonb,$4,$5)
         ON CONFLICT (week_start) DO UPDATE SET total_conversations=$2, top_issues=$3::jsonb, new_questions=$4, unresolved=$5, created_at=now()`,
        [weekStart, s.totalConversations, JSON.stringify(s.topIssues), s.newQuestions, s.unresolved],
      );
    },
    async listWeeklyStats(limit = 26) {
      const r = await db.query("SELECT week_start::text AS week_start, total_conversations, top_issues, new_questions, unresolved FROM weekly_stats ORDER BY week_start DESC LIMIT $1", [limit]);
      return r.rows;
    },

    // ---- Danh sách hội thoại cho Admin Web ----
    async listEpisodes(opts: { status?: string; q?: string; userId?: number; limit: number; offset: number }) {
      const q = opts.q ? `%${opts.q.replace(/[%_]/g, "")}%` : null;
      const r = await db.query(
        `SELECT e.*, u.name AS user_name, u.username AS user_username, u.language AS user_language,
                (SELECT text FROM messages m WHERE m.episode_id = e.id AND m.direction = 'out' ORDER BY m.id DESC LIMIT 1) AS last_bot_text,
                (SELECT count(*)::int FROM messages m WHERE m.episode_id = e.id) AS message_count
         FROM episodes e JOIN users u ON u.telegram_id = e.user_id
         WHERE ($1::text IS NULL OR e.status = $1)
           AND ($2::bigint IS NULL OR e.user_id = $2)
           AND ($3::text IS NULL OR e.issue ILIKE $3 OR e.ref_code ILIKE $3 OR u.username ILIKE $3 OR u.name ILIKE $3 OR e.user_id::text LIKE $3
                OR EXISTS (SELECT 1 FROM messages m WHERE m.episode_id = e.id AND m.text ILIKE $3))
         ORDER BY e.last_activity_at DESC LIMIT $4 OFFSET $5`,
        [opts.status ?? null, opts.userId ?? null, q, opts.limit, opts.offset],
      );
      return r.rows.map((x) => ({ ...x, id: num(x.id), user_id: num(x.user_id), message_count: num(x.message_count) }));
    },
    async episodeDetail(id: number) {
      const [msgs, events, decisions] = await Promise.all([
        db.query("SELECT * FROM messages WHERE episode_id = $1 ORDER BY id", [id]),
        db.query("SELECT * FROM events WHERE episode_id = $1 ORDER BY id", [id]),
        db.query("SELECT * FROM decisions WHERE episode_id = $1 ORDER BY id", [id]),
      ]);
      const norm = (rows: Record<string, unknown>[]) => rows.map((x) => ({ ...x, id: num(x.id), message_id: numOrNull(x.message_id) }));
      return { messages: norm(msgs.rows), events: norm(events.rows), decisions: norm(decisions.rows) };
    },
    async messagesForReplay(since: Date, limit: number) {
      const r = await db.query(
        `SELECT m.id, m.text, m.user_id, m.image_type, d.template_id, d.kind
         FROM messages m JOIN decisions d ON d.message_id = m.id
         WHERE m.direction = 'in' AND m.created_at >= $1 AND m.text IS NOT NULL ORDER BY m.id DESC LIMIT $2`,
        [iso(since), limit],
      );
      return r.rows.map((x) => ({ id: num(x.id), text: String(x.text), imageType: (x.image_type as string | null) ?? null, templateId: (x.template_id as string | null) ?? null, kind: String(x.kind) }));
    },

    // ---- Broadcast ----
    async createBroadcast(by: number, text: string, total: number): Promise<number> {
      const r = await db.query<{ id: string }>("INSERT INTO broadcasts (created_by, text, total) VALUES ($1,$2,$3) RETURNING id", [by, text, total]);
      return num(r.rows[0]!.id);
    },
    async getBroadcast(id: number) {
      const r = await db.query("SELECT * FROM broadcasts WHERE id = $1", [id]);
      return r.rows[0] as { id: string; status: string; text: string; total: number; sent: number; failed: number } | undefined;
    },
    async updateBroadcast(id: number, p: { status?: string; sentInc?: number; failedInc?: number }) {
      await db.query(
        "UPDATE broadcasts SET status = COALESCE($2, status), sent = sent + $3, failed = failed + $4, finished_at = CASE WHEN $2 IN ('done','cancelled') THEN now() ELSE finished_at END WHERE id = $1",
        [id, p.status ?? null, p.sentInc ?? 0, p.failedInc ?? 0],
      );
    },
    async listBroadcasts() {
      const r = await db.query("SELECT * FROM broadcasts ORDER BY id DESC LIMIT 30");
      return r.rows.map((x) => ({ ...x, id: num(x.id) }));
    },
  };
}

export type OpsRepo = ReturnType<typeof opsRepo>;
