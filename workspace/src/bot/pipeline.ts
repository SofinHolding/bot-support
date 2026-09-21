/**
 * BotPipeline: một lượt xử lý tin nhắn.
 *   idempotency -> nhóm -> FP-0 -> (admin) -> chặn spam -> ảnh -> ngôn ngữ -> episode -> router+cổng -> trả lời -> ghi nhận
 * Mọi luật bắt buộc nằm ở đây và trong core/*, bằng code — không phụ thuộc LLM có "nhớ" prompt hay không.
 */
import { applyOfftopic, blockJustExpired, isBlocked, newAntispamState } from "../core/antispam";
import { isEscalationTemplate } from "../core/followup";
import { resolveLanguage } from "../core/language";
import type { KnowledgePort, LlmPort } from "../core/ports";
import { LlmUnavailableError } from "../core/ports";
import { route, type Outcome, type RouteResult, type RouterSettings } from "../core/router";
import { detectKeyLeak, maskSensitive, REDACTED_LOG_TEXT } from "../core/sanitize";
import type { Settings } from "../core/settings";
import { SettingsService } from "../core/settings";
import { normalize } from "../core/text";
import type { Template, VisionResult, VisionScreenType } from "../domain/types";
import {
  ESCALATE_TEMPLATE_ID, HIGH_TRAFFIC_TEMPLATE_ID, IMAGE_COVER_SECRET_ID, IMAGE_UNREADABLE_ID, SECURITY_TEMPLATE_ID,
} from "../domain/types";
import type { Db } from "../db/db";
import type { ConvRepo, UserRow } from "../db/repo-conv";
import type { KbRepo } from "../db/repo-kb";
import type { OpsRepo } from "../db/repo-ops";
import { llmContext } from "../llm/chain";
import type { LiveContent } from "../kb/live-content";
import { EpisodeManager } from "./episodes";
import type { MediaStore } from "./media";
import type { ResponseResolver } from "./resolver";
import type { Channel, InboundBatch, PipelineResult } from "./types";

export interface PipelineDeps {
  db: Db;
  conv: ConvRepo;
  kb: KbRepo;
  ops: OpsRepo;
  live: LiveContent;
  settings: SettingsService;
  resolver: ResponseResolver;
  channel: Channel;
  llm?: LlmPort;
  knowledge?: KnowledgePort;
  media?: MediaStore;
  ownerId: number | null;
  adminWebUrl: string;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

const ADMIN_COMMAND = /^\s*\/(contexts|usage)\b|cho xem contexts|show contexts|ai đang pending|token tuần qua|usage last week|export usage|chạy lại aggregator/i;
const IMAGE_PRIORITY: VisionScreenType[] = ["kyc_email", "kyc_queue_screen", "error_dialog", "app_screen", "unreadable", "unrelated"];
const NEW_QUESTION_REASONS = /không khớp|mơ hồ|LLM phân loại cần escalate|LLM chọn template ngoài|không có nguồn|không tìm được/;

export class BotPipeline {
  private readonly episodes: EpisodeManager;
  private readonly now: () => Date;

  constructor(private readonly d: PipelineDeps) {
    this.episodes = new EpisodeManager(d.conv);
    this.now = d.now ?? (() => new Date());
  }

  private log(level: "info" | "warn" | "error", msg: string, extra?: unknown) {
    this.d.log?.(level, msg, extra);
  }

  async handle(batch: InboundBatch): Promise<PipelineResult> {
    const started = Date.now();
    const { conv } = this.d;

    // ---- Nhóm chat: chỉ trả lời khi được nhắc trực tiếp ----
    if (batch.chatType !== "private" && !batch.isMention) return { status: "ignored", replies: [] };

    // ---- Idempotency: Telegram có thể gửi lại cùng một update ----
    const fresh = [];
    for (const it of batch.items) if (it.updateId <= 0 || (await conv.claimUpdate(it.updateId))) fresh.push(it);
    if (!fresh.length) return { status: "duplicate", replies: [] };
    const items = fresh;

    try {
      const res = await this.process(batch, items, started);
      for (const it of items) if (it.updateId > 0) await conv.finishUpdate(it.updateId, res.status);
      return res;
    } catch (e) {
      this.log("error", "pipeline error", { err: (e as Error).stack ?? String(e) });
      for (const it of items) if (it.updateId > 0) await conv.finishUpdate(it.updateId, "error").catch(() => undefined);
      // KHÔNG hiển thị lỗi kỹ thuật cho khách (AGENTS.md > Error Handling): gửi thông báo cố định.
      const text = await this.d.resolver.forTemplate(HIGH_TRAFFIC_TEMPLATE_ID, "en").then((r) => r.text).catch(() => "");
      if (text) await this.send(batch.chatId, text, `err:${items[0]!.updateId}`);
      return { status: "error", replies: text ? [text] : [] };
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  private async process(batch: InboundBatch, items: InboundBatch["items"], started: number): Promise<PipelineResult> {
    const { conv, ops, resolver } = this.d;
    const now = this.now();
    await this.d.live.ensureFresh();
    const settings = await this.d.settings.get();
    const admin = await ops.getAdmin(batch.userId);
    const isAdmin = !!admin;

    const rawText = items.map((i) => i.text ?? "").filter(Boolean).join("\n");
    const photos = items.filter((i) => i.photoFileId);
    const user = await conv.touchUser({ id: batch.userId, name: batch.name, username: batch.username }, now);

    // ================= FP-0: lộ private key / seed phrase (ưu tiên cao nhất) =================
    const leak = detectKeyLeak(rawText);
    if (leak) return this.handleKeyLeak(batch, items, user, leak, isAdmin, started);

    const masked = maskSensitive(rawText);

    // ================= Admin: lệnh console đã chuyển sang web =================
    if (isAdmin && ADMIN_COMMAND.test(rawText)) {
      const r = await resolver.forTemplate("admin-console-moved", "vi", { });
      const text = r.text.replace("{URL}", this.d.adminWebUrl);
      await this.send(batch.chatId, text, `admin:${items[0]!.updateId}`);
      return { status: "ok", replies: [text], decisionKind: "ADMIN_POINTER" };
    }

    // ================= Chống spam / cooldown (không áp dụng cho admin) =================
    let anti = isAdmin ? null : (await conv.getAntispam(batch.userId)) ?? newAntispamState(now);
    if (anti && blockJustExpired(anti, now)) {
      anti = { ...anti, blocked_until: null };
      await conv.saveAntispam(batch.userId, anti);
      await conv.addEvent({ userId: batch.userId, type: "antispam_unblock", payload: { note: "Tự động mở chặn" } }, now);
    }
    if (anti && isBlocked(anti, now)) {
      const mid = await conv.addMessage({ at: now, episodeId: null, userId: batch.userId, direction: "in", text: masked, language: user.language });
      await conv.addDecision({ at: now, messageId: mid, episodeId: null, userId: batch.userId, kind: "BLOCKED", reason: `bị chặn tới ${anti.blocked_until?.toISOString()}` });
      return { status: "ok", replies: [], decisionKind: "BLOCKED" }; // im lặng: khách đã được báo thời gian chặn
    }

    // ================= Lưu tin nhắn đến (chưa gắn episode) =================
    const messageId = isAdmin ? null : await conv.addMessage({ at: now, episodeId: null, userId: batch.userId, direction: "in", text: masked || null, language: user.language });
    const llmScope = { messageId, userId: batch.userId };

    return llmContext.run(llmScope, async () => {
      // ---- Ngân sách token theo khách/ngày (chống đốt chi phí) ----
      let llm = this.d.llm;
      if (llm && !isAdmin) {
        const dayStart = new Date(now.getTime() - 24 * 3600_000);
        const used = await ops.tokensUsedByUserSince(batch.userId, dayStart);
        if (used >= settings["limits.tokens_per_user_day"]) {
          llm = undefined;
          this.log("warn", "vượt ngân sách token/ngày", { userId: batch.userId, used });
        }
      }

      // ---- Ảnh: vision (không lưu ảnh có seed/key) ----
      const imgs = await this.readImages(batch, photos, masked, llm, isAdmin);
      const vision = imgs.vision;
      const extraReplies: string[] = [];

      // ---- Ngôn ngữ ----
      const langRes = resolveLanguage(masked, user.language);
      const lang = langRes.lang;
      if (langRes.update && !isAdmin) await conv.setLanguage(batch.userId, lang);

      if (vision?.has_secret) {
        const warn = await resolver.forTemplate(IMAGE_COVER_SECRET_ID, lang);
        extraReplies.push(warn.text);
      }

      // ---- Episode + ngữ cảnh ----
      const loaded = isAdmin ? { active: null, gapMs: 0, recent: [] as never[] } : await this.episodes.load(batch.userId, now, settings);
      const lastTemplate = loaded.active?.last_template_id ? this.d.live.index.get(loaded.active.last_template_id) : undefined;
      const contextPack = isAdmin ? undefined : await this.episodes.contextPack(user, lang, loaded as never, now);

      // ---- Router + Cổng quyết định ----
      const rs: RouterSettings = {
        semanticConfident: settings["router.semantic_confident"],
        semanticMargin: settings["router.semantic_margin"],
        semanticSuggest: settings["router.semantic_suggest"],
        tier3Mode: settings["router.tier3_mode"],
        tier3MinScore: settings["router.tier3_min_score"],
        tooShortMaxChars: settings["router.too_short_max_chars"],
        urlHostWhitelist: this.d.live.urlHosts,
      };
      const isSticker = items.every((i) => i.sticker) ;
      const otherMediaOnly = !rawText && !photos.length && items.some((i) => i.otherMedia) && !isSticker;
      let result: RouteResult;
      if (otherMediaOnly) {
        // Video/voice/tài liệu không kèm chữ: bot không đọc được, cần người thật (vd quay màn hình lỗi)
        result = { outcome: { kind: "ESCALATE", tier: 0, reason: "khách gửi tệp bot không đọc được (video/voice/tài liệu)", sourceTemplateId: lastTemplate?.id }, trace: { gates: [], ranked: [], candidates: [], notes: [] } };
      } else if (photos.length && !vision) {
        const reason = imgs.failed === "unavailable" ? "unavailable" : "no_vision";
        result = reason === "unavailable"
          ? { outcome: { kind: "TEMPLATE", templateId: HIGH_TRAFFIC_TEMPLATE_ID, tier: 2, via: "llm_unavailable" }, trace: { gates: [], ranked: [], candidates: [], notes: ["vision không khả dụng"] } }
          : { outcome: { kind: "ESCALATE", tier: 0, reason: "khách gửi ảnh nhưng vision chưa được cấu hình", sourceTemplateId: lastTemplate?.id }, trace: { gates: [], ranked: [], candidates: [], notes: [] } };
      } else {
        result = await route(
          { text: masked, norm: normalize(masked), lang, vision, hasImage: photos.length > 0, isSticker, ctx: { lastTemplate, pendingIssue: loaded.pendingIssue, parentEscalatedGroup: loaded.parentEscalatedGroup, contextPack } },
          { index: this.d.live.index, evaluator: this.d.live.evaluator, settings: rs, llm, knowledge: this.d.knowledge },
        );
      }
      const outcome = result.outcome;

      // ---- Xây câu trả lời ----
      const built = await this.buildReply(outcome, lang, loaded.pendingIssue);
      const replies = [...extraReplies, ...built.texts];

      // ---- Off-topic: bậc thang chặn ----
      let antiEvent: { level: number; blockMs: number } | null = null;
      if (outcome.kind === "OFFTOPIC" && anti && !isAdmin) {
        const o = applyOfftopic(anti, now);
        await conv.saveAntispam(batch.userId, o.state);
        antiEvent = { level: o.level, blockMs: o.blockMs };
        const w = await resolver.forTemplate(o.templateId, lang);
        replies.length = 0;
        replies.push(...extraReplies, w.text);
        await conv.addEvent({ userId: batch.userId, type: o.blockMs ? "antispam_block" : "antispam_warning", payload: { level: o.level, block_minutes: o.blockMs / 60_000, offtopic: masked.slice(0, 120) } }, now);
      } else if (anti && !isAdmin) {
        await conv.saveAntispam(batch.userId, { ...anti, last_seen: now });
      }

      // ---- Gửi ----
      const sentIds: (number | undefined)[] = [];
      for (let i = 0; i < replies.length; i++) sentIds.push((await this.send(batch.chatId, replies[i]!, `r:${items[0]!.updateId}:${i}`))?.messageId);

      if (isAdmin) return { status: "ok", replies, decisionKind: outcome.kind, templateId: outcomeTemplateId(outcome), tier: outcome.tier };

      // ---- Ghi nhận: episode, tin nhắn trả lời, sự kiện, quyết định, ticket ----
      const tmpl = this.d.live.index.get(outcomeTemplateId(outcome) ?? "");
      const isEsc = outcome.kind === "ESCALATE" || isEscalationTemplate(tmpl);
      const fin = await this.episodes.finalize({
        userId: batch.userId,
        now,
        active: loaded.active,
        kind: outcome.kind === "TEMPLATE" ? "TEMPLATE" : outcome.kind,
        template: outcome.kind === "OFFTOPIC" ? undefined : tmpl ?? (outcome.kind === "ESCALATE" ? this.d.live.index.get(ESCALATE_TEMPLATE_ID) : undefined),
        tier: outcome.tier,
        escalateReason: outcome.kind === "ESCALATE" ? outcome.reason : undefined,
      });
      const ep = fin.episode;
      if (ep && messageId) await this.linkMessage(messageId, ep.id);

      if (vision) await conv.addEvent({ userId: batch.userId, episodeId: ep?.id ?? null, type: "image_received", payload: { image_type: vision.screen_type, count: photos.length } }, now);
      const outIds: number[] = [];
      for (let i = 0; i < replies.length; i++) {
        outIds.push(await conv.addMessage({ at: now, episodeId: ep?.id ?? null, userId: batch.userId, direction: "out", text: replies[i]!, language: built.lang ?? lang, tier: outcome.tier, templateId: outcomeTemplateId(outcome), telegramMessageId: sentIds[i] ?? null, latencyMs: Date.now() - started }));
      }
      const tid = outcomeTemplateId(outcome);
      if (tid) await conv.addEvent({ userId: batch.userId, episodeId: ep?.id ?? null, type: "template_sent", payload: { template_id: tid, tier: outcome.tier } }, now);

      let ticketId: number | null = null;
      if (isEsc) ticketId = await this.escalate(batch, ep?.id ?? null, outcome, tmpl, lastTemplate, loaded.active?.topic_group ?? null, masked);

      const trace = result.trace;
      // "⚠️ CÂU HỎI MỚI": khách hỏi điều chưa có trong kho => admin cần bổ sung template/tri thức
      const newQuestion = outcome.kind === "ESCALATE" && !trace.followUp && NEW_QUESTION_REASONS.test(outcome.reason);
      await conv.addDecision({
        at: now,
        messageId,
        episodeId: ep?.id ?? null,
        userId: batch.userId,
        kind: isEsc ? "ESCALATE" : outcome.kind,
        tier: outcome.tier,
        templateId: tid,
        via: outcome.kind === "TEMPLATE" ? outcome.via : outcome.kind === "GROUNDED" ? `grounded:${outcome.mode}` : null,
        reason: outcome.kind === "ESCALATE" || outcome.kind === "OFFTOPIC" ? outcome.reason : null,
        candidates: trace.candidates,
        gates: { steps: trace.gates, ranked: trace.ranked },
        notes: { new_question: newQuestion, follow_up: trace.followUp ?? null, llm: trace.llm ?? null, notes: [...trace.notes, ...(built.note ? [built.note] : []), ...(imgs.note ? [imgs.note] : [])], ticket_id: ticketId, anti: antiEvent, switched: fin.switchedFrom?.id ?? null, reopened: fin.reopened },
        kbVersion: this.d.live.version,
      });

      // Tóm tắt cuộn: chạy nền sau khi đã trả lời (không làm chậm khách)
      if (ep && this.d.llm) {
        const unsummarized = await conv.countUnsummarized(ep.id, ep.summary_upto_message_id);
        if (unsummarized >= settings["episode.summary_every_k"]) {
          const last = await conv.lastMessageId(ep.id);
          await ops.enqueueJob("summarize-episode", { episodeId: ep.id }, { dedupeKey: `sum:${ep.id}:${last}` });
        }
      }
      return { status: "ok", replies, decisionKind: outcome.kind, templateId: tid, tier: outcome.tier };
    });
  }

  private async linkMessage(messageId: number, episodeId: number | null) {
    await this.d.db.query("UPDATE messages SET episode_id = $2 WHERE id = $1", [messageId, episodeId]);
  }

  // ------------------------------------------------------------------------------------------------------------
  /** FP-0. Không sao chép/lưu khoá; chỉ ghi `security-alert-key-leak`; báo owner; log "[REDACTED - ...]". */
  private async handleKeyLeak(batch: InboundBatch, items: InboundBatch["items"], user: UserRow, pattern: "A" | "B" | "C", isAdmin: boolean, started: number): Promise<PipelineResult> {
    const { conv, resolver } = this.d;
    const now = this.now();
    const lang = "en"; // câu cảnh báo cố định bằng tiếng Anh (nguyên văn theo AGENTS.md)
    const alert = await resolver.forTemplate(SECURITY_TEMPLATE_ID, lang);
    await this.send(batch.chatId, alert.text, `fp0:${items[0]!.updateId}`);

    if (!isAdmin) {
      const mid = await conv.addMessage({ at: now, episodeId: null, userId: batch.userId, direction: "in", text: REDACTED_LOG_TEXT, language: user.language });
      let ep = await conv.getActiveEpisode(batch.userId);
      if (!ep) ep = await conv.openEpisode({ userId: batch.userId, issue: "security-alert-key-leak", topicGroup: "Security" }, now);
      await conv.updateEpisode(ep.id, { issue: "security-alert-key-leak", status: "security_alerted", last_bot_action: "fast/FP-0", last_activity_at: now, closed_at: now });
      await this.linkMessage(mid, ep.id);
      await conv.addMessage({ at: now, episodeId: ep.id, userId: batch.userId, direction: "out", text: alert.text, tier: 0, templateId: SECURITY_TEMPLATE_ID, latencyMs: Date.now() - started });
      await conv.addEvent({ userId: batch.userId, episodeId: ep.id, type: "security_alert", payload: { pattern } }, now); // chỉ ghi tên pattern, KHÔNG ghi dữ liệu
      await conv.setFlag(batch.userId, "security_alerted", true);
      await conv.addDecision({ at: now, messageId: mid, episodeId: ep.id, userId: batch.userId, kind: "SECURITY", tier: 0, templateId: SECURITY_TEMPLATE_ID, via: `FP-0:${pattern}`, reason: "phát hiện key/seed trong tin nhắn", kbVersion: this.d.live.version });
    }

    // Báo owner ngay, song song với việc trả lời khách. Lỗi -> tiếp tục, KHÔNG retry vòng lặp.
    if (this.d.ownerId) {
      try {
        const tpl = await resolver.forTemplate("fp-0-owner-notice", "en");
        const text = tpl.text
          .replace("{sender_name}", user.name ?? user.username ?? "unknown")
          .replace("{sender_id}", String(batch.userId))
          .replace("{timestamp}", now.toISOString())
          .replace(/\{A \| B \| C[^}]*\}/, pattern);
        await this.d.channel.send(this.d.ownerId, text);
      } catch (e) {
        this.log("warn", "không gửi được thông báo FP-0 cho owner", { err: (e as Error).message });
      }
    }
    return { status: "ok", replies: [alert.text], decisionKind: "SECURITY", templateId: SECURITY_TEMPLATE_ID, tier: 0 };
  }

  // ------------------------------------------------------------------------------------------------------------
  private async buildReply(outcome: Outcome, lang: string, pendingIssue: string | undefined): Promise<{ texts: string[]; lang?: string; note?: string }> {
    const { resolver } = this.d;
    switch (outcome.kind) {
      case "TEMPLATE": {
        const r = await resolver.forTemplate(outcome.templateId, lang, { ISSUE: pendingIssue ?? "" });
        return { texts: [r.text], lang: r.lang, note: r.note };
      }
      case "ESCALATE": {
        const r = await resolver.forTemplate(ESCALATE_TEMPLATE_ID, lang);
        return { texts: [r.text], lang: r.lang, note: r.note };
      }
      case "GROUNDED": {
        const r = await resolver.dynamic(outcome.answer, lang);
        return { texts: [r.text], lang: r.lang, note: r.note };
      }
      case "OFFTOPIC":
        return { texts: [], lang }; // câu cảnh báo do nhánh anti-spam dựng
    }
  }

  /** Tạo hoặc nối tiếp ticket khi chuyển cho người thật. */
  private async escalate(batch: InboundBatch, episodeId: number | null, outcome: Outcome, tmpl: Template | undefined, last: Template | undefined, topicGroup: string | null, masked: string): Promise<number> {
    const { conv } = this.d;
    const src = outcome.kind === "ESCALATE" && outcome.sourceTemplateId ? this.d.live.index.get(outcome.sourceTemplateId) : undefined;
    const info = tmpl?.ticket ?? src?.ticket ?? last?.ticket ?? {};
    const category = info.category ?? topicGroup ?? src?.group ?? null;
    const requiredInfo = tmpl?.required_info ?? src?.required_info ?? null;
    const reason = outcome.kind === "ESCALATE" ? outcome.reason : `trigger ${tmpl?.id ?? ""}`;
    const open = await conv.openTicketFor(batch.userId, category);
    if (open) {
      await conv.appendTicketNote(open.id, `[${this.now().toISOString()}] khách hỏi lại: ${masked.slice(0, 200)}`);
      await conv.addEvent({ userId: batch.userId, episodeId, type: "ticket_updated", payload: { ticket_id: open.id } }, this.now());
      return open.id;
    }
    const t = await conv.createTicket({ episodeId, userId: batch.userId, category, errorCode: info.error_code ?? null, pic: info.pic ?? null, reason, requiredInfo, sourceTemplateId: src?.id ?? tmpl?.id ?? last?.id ?? null });
    await conv.addEvent({ userId: batch.userId, episodeId, type: "ticket_created", payload: { ticket_id: t.id, error_code: info.error_code ?? null } }, this.now());
    return t.id;
  }

  // ------------------------------------------------------------------------------------------------------------
  private async readImages(batch: InboundBatch, photos: InboundBatch["items"], caption: string, llm: LlmPort | undefined, isAdmin: boolean): Promise<{ vision?: VisionResult; failed?: "unavailable" | "no_vision"; note?: string }> {
    if (!photos.length) return {};
    if (!llm) return { failed: "no_vision" };
    const results: VisionResult[] = [];
    let note: string | undefined;
    for (const p of photos.slice(0, 3)) {
      try {
        const img = await this.d.channel.downloadImage(p.photoFileId!);
        const v = await llm.vision({ mime: img.mime, base64: img.base64, caption: caption || undefined });
        results.push(v);
        if (!v.has_secret && this.d.media && !isAdmin) this.d.media.save(img.mime, img.base64);
        else if (v.has_secret) note = "ảnh có seed/key: không lưu";
      } catch (e) {
        if (e instanceof LlmUnavailableError) return { failed: "unavailable" };
        throw e;
      }
    }
    return { vision: combineVision(results), note };
  }

  private async send(chatId: number, text: string, dedupeKey: string): Promise<{ messageId?: number } | undefined> {
    try {
      return await this.d.channel.send(chatId, text);
    } catch (e) {
      // Telegram lỗi: đưa vào hộp thư đi để worker gửi lại, không mất tin
      this.log("warn", "gửi Telegram lỗi, đưa vào outbox", { err: (e as Error).message });
      await this.d.ops.enqueueOutbox(chatId, text, dedupeKey);
      return undefined;
    }
  }
}

function outcomeTemplateId(o: Outcome): string | null {
  if (o.kind === "TEMPLATE") return o.templateId;
  if (o.kind === "ESCALATE") return ESCALATE_TEMPLATE_ID;
  return null;
}

/** Nhiều ảnh cùng lượt -> MỘT kết quả (nhiều ảnh KYC vẫn chỉ trả một reply). */
export function combineVision(list: VisionResult[]): VisionResult {
  const readable = list.filter((v) => v.readable);
  const pick = (pool: VisionResult[]) => [...pool].sort((a, b) => IMAGE_PRIORITY.indexOf(a.screen_type) - IMAGE_PRIORITY.indexOf(b.screen_type))[0]!;
  const top = readable.length ? pick(readable) : pick(list);
  return {
    screen_type: readable.length ? top.screen_type : "unreadable",
    error_text: list.map((v) => v.error_text).filter(Boolean).join(" ").slice(0, 300),
    has_secret: list.some((v) => v.has_secret),
    readable: readable.length > 0,
  };
}

export { IMAGE_UNREADABLE_ID };
