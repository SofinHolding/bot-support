/** Việc nền. Chạy trực tiếp bằng code (không gọi LLM chỉ để "chạy script" như cron cũ). */
import { usableLlm, type LlmPort } from "../core/ports";
import { maskSensitive } from "../core/sanitize";
import { cleanSummary, degradedSummary, readSummary } from "../core/summary";
import { normalize } from "../core/text";
import { sha1 } from "../core/knowledge";
import type { Channel } from "../bot/types";
import type { MediaStore } from "../bot/media";
import type { SettingsService } from "../core/settings";
import type { Db } from "../db/db";
import type { ConvRepo } from "../db/repo-conv";
import type { KbRepo } from "../db/repo-kb";
import type { OpsRepo } from "../db/repo-ops";
import type { KbService } from "../kb/service";
import type { LiveContent } from "../kb/live-content";
import type { ResponseResolver } from "../bot/resolver";
import { URGENT_TEMPLATE_IDS } from "../core/fixed-messages";
import { prewarmLanguages } from "../core/settings";
import { htmlToText, pageTitle, paragraphs } from "./html";
import type { VaultRepo } from "../db/repo-vault";
import { runIngest, type VaultJobDeps } from "../vault/ingest";
import { runIndex } from "../vault/indexer";
import { applyDecision } from "../vault/decide";
import type { Embedder } from "../core/embedding";
import { VaultStore } from "../vault/store";
import { localDate, mondayOf } from "./schedule";

export const BANGKOK = "Asia/Bangkok";

/** 7 trang whitepaper cần đồng bộ (skills/whitepaper-sync). */
export const WHITEPAPER_PAGES = [
  "https://whitepaper.interlinklabs.ai/interlink-token-usditl",
  "https://whitepaper.interlinklabs.ai/interlink-genesis-token-usditlg",
  "https://whitepaper.interlinklabs.ai/interlink-token-and-interlink-genesis",
  "https://whitepaper.interlinklabs.ai/itl-the-human-currency-of-global-payments",
  "https://whitepaper.interlinklabs.ai/token-mining-mechanism-and-sustainability",
  "https://whitepaper.interlinklabs.ai/faq",
  "https://whitepaper.interlinklabs.ai/interlink-tokenomics/introducing",
];

export interface JobContext {
  db: Db;
  conv: ConvRepo;
  kb: KbRepo;
  ops: OpsRepo;
  settings: SettingsService;
  kbService: KbService;
  channel: Channel;
  llm?: LlmPort;
  media?: MediaStore;
  ownerId: number | null;
  adminWebUrl: string;
  now: () => Date;
  fetchImpl: typeof fetch;
  log: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
  /** Dịch sẵn câu khẩn (job prewarm-urgent-translations). Không có = job bỏ qua. */
  resolver?: ResponseResolver;
  live?: LiveContent;
  /** Vault Obsidian (docs/adr/0005). Không có = các job vault-* báo lỗi cấu hình. */
  vault?: { root: string; rawDir: string; repo: VaultRepo; embedder: Embedder };
}

/** Dựng phụ thuộc cho một job vault: mỗi job một VaultStore mới (đọc lại index.json từ đĩa). */
export function vaultDeps(ctx: JobContext): VaultJobDeps {
  if (!ctx.vault) throw new Error("chưa cấu hình vault (VAULT_DIR/RAW_DATA_DIR)");
  return {
    store: VaultStore.open(ctx.vault.root, ctx.vault.repo), repo: ctx.vault.repo, llm: ctx.llm, rawDir: ctx.vault.rawDir, now: ctx.now, log: ctx.log,
    enqueue: (type, payload, opts) => ctx.ops.enqueueJob(type, payload, opts),
  };
}

export type JobHandler = (ctx: JobContext, payload: Record<string, unknown>) => Promise<unknown>;

/** Nhắn owner (Anh Phi). Lỗi chỉ ghi log, không làm hỏng job. */
export async function notifyOwner(ctx: JobContext, text: string): Promise<boolean> {
  if (!ctx.ownerId) return false;
  try {
    await ctx.channel.send(ctx.ownerId, text);
    return true;
  } catch (e) {
    ctx.log("warn", "không nhắn được owner", { err: (e as Error).message });
    return false;
  }
}

const dayOf = (d: Date) => localDate(d, BANGKOK);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

export const HANDLERS: Record<string, JobHandler> = {
  /** Episode im lặng -> dormant; dormant quá hạn -> tự đóng (KHÔNG xoá); hàng đợi kẹt; phiên đăng nhập hết hạn. */
  async maintenance(ctx) {
    const s = await ctx.settings.get();
    const now = ctx.now();
    const dormant = await ctx.conv.markDormant(new Date(now.getTime() - s["episode.t_gap_minutes"] * 60_000));
    const closed = await ctx.conv.closeAbandoned(addDays(now, -s["episode.t_abandon_days"]), now);
    const requeued = await ctx.ops.requeueStuckJobs(15);
    await ctx.ops.purgeExpiredAuth(now);
    return { dormant, closed, requeued };
  },

  /** File admin tải lên (raw-data/) -> note trong vault, phát hiện xung đột (src/vault/ingest.ts). */
  async "vault-ingest"(ctx, payload) {
    return runIngest(vaultDeps(ctx), Number(payload.batchId));
  },

  /** Áp dụng quyết định của admin cho một xung đột khi nạp (src/vault/decide.ts), bằng code. */
  async "vault-decide"(ctx, payload) {
    return applyDecision(vaultDeps(ctx), Number(payload.conflictId));
  },

  /** Hàng đợi index của vault -> chunk + tsvector + vector (src/vault/indexer.ts). Còn việc thì tự xếp lượt tiếp. */
  async "vault-index"(ctx) {
    if (!ctx.vault) throw new Error("chưa cấu hình vault (VAULT_DIR)");
    const d = vaultDeps(ctx);
    const r = await runIndex({ store: d.store, repo: ctx.vault.repo, embedder: ctx.vault.embedder, log: ctx.log });
    if (r.remaining > 0) await ctx.ops.enqueueJob("vault-index", {}, { dedupeKey: "vault-index:more" });
    return r;
  },

  // đổi model embed: note trong vault được embed bù theo model mới ở lượt vault-index kế tiếp (cron 5 phút)
  async "reindex-embeddings"(ctx) {
    return ctx.kbService.reindexChunks();
  },

  /** Gửi lại tin Telegram lỗi (thay delivery-queue/failed của OpenClaw). */
  async "outbox-flush"(ctx) {
    let sent = 0;
    let failed = 0;
    for (const o of await ctx.ops.dueOutbox(50)) {
      try {
        await ctx.channel.send(o.chat_id, o.text, o.entities ? { entities: o.entities } : undefined);
        await ctx.ops.outboxSent(o.id);
        sent++;
      } catch (e) {
        await ctx.ops.outboxFailed(o.id, o.attempts, (e as Error).message);
        failed++;
      }
    }
    return { sent, failed };
  },

  /** Thay usage-aggregator.mjs: làm mới usage_daily cho vài ngày gần nhất (giờ Asia/Bangkok). */
  async "usage-aggregate"(ctx) {
    const now = ctx.now();
    const rows = await ctx.ops.aggregateUsage(dayOf(addDays(now, -3)), dayOf(now));
    return { days: rows };
  },

  /** Thay cron daily-escalate-threshold-alert: > ngưỡng (100) template escalate trong ngày thì nhắn owner. */
  async "escalation-alert"(ctx) {
    const s = await ctx.settings.get();
    const day = dayOf(ctx.now());
    const count = await ctx.ops.escalationsOn(day);
    const threshold = s["alerts.escalation_daily_threshold"];
    let alerted = false;
    if (count > threshold) {
      alerted = await notifyOwner(ctx, `⚠️ Hôm nay (${day}) bot đã chuyển ${count} tin sang @interlink_technicalsupport (ngưỡng ${threshold}). Anh Phi nên xem lại tải của đội support.\n${ctx.adminWebUrl}`);
    }
    return { day, count, threshold, alerted };
  },

  /** Thống kê tuần + dọn dẹp (HEARTBEAT.md, mỗi thứ Hai). */
  async "weekly-stats"(ctx) {
    const s = await ctx.settings.get();
    const now = ctx.now();
    const weekStart = mondayOf(now, BANGKOK);
    const stats = await ctx.ops.computeWeeklyStats(weekStart);
    await ctx.ops.saveWeeklyStats(weekStart, stats);
    const antispamDeleted = await ctx.conv.deleteStaleAntispam(addDays(now, -s["antispam.stale_days"]));
    let alerted = false;
    if (stats.newQuestions >= s["alerts.new_questions_threshold"]) {
      alerted = await notifyOwner(ctx, `📋 Tuần vừa qua có ${stats.newQuestions} câu hỏi mới chưa có trong kho (${stats.totalConversations} hội thoại, ${stats.unresolved} chưa xong). Anh Phi nên xem mục "Câu chưa khớp" và bổ sung template.\n${ctx.adminWebUrl}`);
    }
    return { weekStart, ...stats, antispamDeleted, alerted };
  },

  /** Đồng bộ whitepaper: chỉ lấy đoạn MỚI hoặc ĐÃ THAY ĐỔI, tạo bản Draft cho admin duyệt (không ghi đè trực tiếp). */
  async "whitepaper-sync"(ctx) {
    const doc = await ctx.kb.getPublished("whitepaper-data");
    if (!doc) return { skipped: "chưa có tài liệu whitepaper-data đã publish" };
    const known = normalize(doc.source_md);
    const settings = await ctx.ops.getSettings();
    const snaps = { ...((settings["whitepaper.snapshots"] as Record<string, { hash: string; at: string }> | undefined) ?? {}) };
    const now = ctx.now();
    const fresh: { url: string; title: string; paras: string[] }[] = [];
    const errors: string[] = [];
    let unchanged = 0;

    for (const url of WHITEPAPER_PAGES) {
      try {
        const res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "interlink-support-bot/2 (+whitepaper-sync)" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const text = htmlToText(html);
        const hash = sha1(text);
        if (snaps[url]?.hash === hash) {
          unchanged++;
          continue;
        }
        const newParas = paragraphs(text).filter((p) => !known.includes(normalize(p)));
        if (newParas.length) fresh.push({ url, title: pageTitle(html) ?? url, paras: newParas.slice(0, 20) });
        snaps[url] = { hash, at: now.toISOString() };
      } catch (e) {
        errors.push(`${url}: ${(e as Error).message}`);
      }
    }
    if (errors.length === WHITEPAPER_PAGES.length) throw new Error(`không đồng bộ được trang nào: ${errors[0]}`); // -> retry với backoff
    await ctx.ops.setSetting("whitepaper.snapshots", snaps, "worker");

    let draftVersion: number | null = null;
    if (fresh.length) {
      const section = [`### ${dayOf(now)} Sync (new/changed only)`, "", ...fresh.flatMap((f) => [`- **${f.title}** (${f.url}):`, ...f.paras.map((p) => `  - ${p.replace(/\n+/g, " ")}`)])].join("\n");
      const at = doc.source_md.indexOf("\n## Links");
      const md = at >= 0 ? `${doc.source_md.slice(0, at)}\n\n${section}\n${doc.source_md.slice(at)}` : `${doc.source_md}\n\n${section}\n`;
      const { version } = await ctx.kbService.createDraft({ slug: "whitepaper-data", kind: "knowledge", md, author: "whitepaper-sync" });
      draftVersion = version.version;
      await notifyOwner(ctx, `📄 Whitepaper có nội dung mới/thay đổi (${fresh.reduce((n, f) => n + f.paras.length, 0)} đoạn ở ${fresh.length} trang). Đã tạo bản Draft v${version.version} cho tài liệu whitepaper-data, cần duyệt trước khi bot dùng.\n${ctx.adminWebUrl}`);
    }
    return { pages: WHITEPAPER_PAGES.length, unchanged, changedPages: fresh.length, newParagraphs: fresh.reduce((n, f) => n + f.paras.length, 0), draftVersion, errors };
  },

  /** HEARTBEAT.md: nếu "Last synced" cũ hơn 2 ngày thì báo admin (cron cũ lỗi 7 lần liên tiếp mà không ai biết). */
  async "whitepaper-health"(ctx) {
    const s = await ctx.settings.get();
    const st = (await ctx.ops.listCron()).find((c) => c.name === "whitepaper-sync");
    const last = st?.last_status === "ok" ? (st.last_run_at as Date | null) : null;
    const ageDays = last ? (ctx.now().getTime() - last.getTime()) / 86_400_000 : Infinity;
    const stale = ageDays > s["alerts.whitepaper_stale_days"];
    let alerted = false;
    if (stale) alerted = await notifyOwner(ctx, `⚠️ Đồng bộ whitepaper chưa thành công ${last ? `từ ${last.toISOString().slice(0, 10)}` : "lần nào"}. Cần kiểm tra job whitepaper-sync.\n${ctx.adminWebUrl}`);
    return { lastOk: last?.toISOString() ?? null, stale, alerted };
  },

  /** Tóm tắt cuộn cho episode dài. Chạy nền sau khi đã trả lời khách. */
  async "summarize-episode"(ctx, p) {
    const llm = usableLlm(ctx.llm);
    if (!llm) return { skipped: "chưa cấu hình LLM" };
    const id = Number(p.episodeId);
    const ep = await ctx.conv.getEpisode(id);
    if (!ep) return { skipped: "không có episode" };
    const msgs = await ctx.conv.messagesAfter(id, ep.summary_upto_message_id, 40);
    if (!msgs.length) return { skipped: "không có tin mới" };
    const prev = readSummary(ep.summary);
    const messages = msgs.map((m) => ({ role: m.direction === "in" ? ("user" as const) : ("bot" as const), text: m.text ?? "" }));
    let out;
    try {
      out = await llm.summarize({ previous: prev ? { issue: prev.issue, user_reported: prev.user_reported, unresolved_points: prev.unresolved_points, exact_facts: prev.exact_facts, degraded: prev.degraded } : undefined, messages });
    } catch (e) {
      // Không để ngữ cảnh trống: lưu bản cắt thô từ lời khách, KHÔNG dời mốc -> lần chạy lại (retry/lượt sau) tóm tắt đúng các tin này.
      if (!prev?.degraded) await ctx.conv.saveSummary(id, { ...degradedSummary(prev, messages) }, ep.summary_upto_message_id);
      throw e;
    }
    // Lớp chặn cuối: che ID/email/khoá, cắt theo giới hạn, và bỏ mọi "giá trị nguyên văn" không có trong tin nhắn nguồn
    const { summary, droppedFacts } = cleanSummary(out, messages.filter((m) => m.role === "user").map((m) => m.text), prev) // nguồn của "giá trị khách nêu" chỉ là lời khách, không phải câu bot;
    await ctx.conv.saveSummary(id, { ...summary }, msgs[msgs.length - 1]!.id);
    return { episodeId: id, upTo: msgs[msgs.length - 1]!.id, facts: summary.exact_facts.length, droppedFacts };
  },

  /**
   * Dịch sẵn nhóm câu khẩn (cảnh báo bảo mật, chống spam, báo mất kết nối, câu chuyển nhân viên) sang các ngôn ngữ khách dùng,
   * để các câu này gửi được NGAY bằng ngôn ngữ của khách, kể cả khi AI mất kết nối. Bản dịch hợp lệ đã có thì bỏ qua (chỉ đọc DB),
   * nên chạy định kỳ rẻ; mẫu đổi nội dung (hash khác) thì tự dịch lại. Payload `langs`: chỉ dịch các ngôn ngữ này (ngôn ngữ mới gặp).
   */
  async "prewarm-urgent-translations"(ctx, p) {
    if (!ctx.resolver || !usableLlm(ctx.llm)) return { skipped: "chưa cấu hình LLM" };
    await ctx.live?.ensureFresh();
    const s = await ctx.settings.get();
    const wanted = Array.isArray(p.langs) ? p.langs.map(String) : [...prewarmLanguages(s), ...(await ctx.conv.knownLanguages())];
    const langs = [...new Set(wanted.filter((l) => /^[a-z]{2}$/.test(l) && l !== "en"))];
    return { langs: langs.length, ...(await ctx.resolver.prewarmUrgent(URGENT_TEMPLATE_IDS, langs)) };
  },

  /** Xoá ảnh quá thời hạn lưu (báo cáo cũ: 8.884/11.004 ảnh > 30 ngày vẫn còn). */
  async retention(ctx) {
    const s = await ctx.settings.get();
    const mediaDeleted = ctx.media ? ctx.media.purgeOlderThan(s["retention.media_days"]) : 0;
    const purged = await ctx.ops.purgeConversationData(ctx.now(), {
      messages: s["retention.messages_days"],
      events: s["retention.events_days"],
      decisions: s["retention.decisions_days"],
      llmCalls: s["retention.llm_calls_days"],
      inboundUpdates: s["retention.inbound_updates_days"],
      outbox: s["retention.outbox_days"],
      episodes: s["retention.episodes_days"],
    });
    return { mediaDeleted, days: s["retention.media_days"], purged };
  },

  /** Gửi thông báo hàng loạt (đã được owner xác nhận). Xử lý theo lô để không chiếm worker, tuân giới hạn Telegram. */
  async "broadcast-send"(ctx, p) {
    const id = Number(p.broadcastId);
    const offset = Number(p.offset ?? 0);
    const b = await ctx.ops.getBroadcast(id);
    if (!b || b.status === "cancelled" || b.status === "done") return { skipped: b?.status ?? "not found" };
    const ids = await ctx.conv.allUserIds();
    const batch = ids.slice(offset, offset + 200);
    let sent = 0;
    let failed = 0;
    for (const uid of batch) {
      const anti = await ctx.conv.getAntispam(uid);
      if (anti?.blocked_until && anti.blocked_until > ctx.now()) continue;
      try {
        await ctx.channel.send(uid, b.text);
        sent++;
      } catch {
        failed++;
      }
      await new Promise((r) => setTimeout(r, 40)); // ~25 tin/giây
    }
    const done = offset + 200 >= ids.length;
    await ctx.ops.updateBroadcast(id, { status: done ? "done" : "sending", sentInc: sent, failedInc: failed });
    if (!done) await ctx.ops.enqueueJob("broadcast-send", { broadcastId: id, offset: offset + 200 }, { dedupeKey: `bc:${id}:${offset + 200}` });
    return { sent, failed, done };
  },
};
