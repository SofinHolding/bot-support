/**
 * BotPipeline: một lượt xử lý tin nhắn.
 *   idempotency -> nhóm -> FP-0 -> (admin) -> chặn spam -> ảnh -> ngôn ngữ -> episode -> router+cổng -> trả lời -> ghi nhận
 * Mọi luật bắt buộc nằm ở đây và trong core/*, bằng code — không phụ thuộc LLM có "nhớ" prompt hay không.
 */
import { checkOutput, TELEGRAM_MAX_CHARS } from "../core/gate";
import { applyOfftopic, blockJustExpired, isBlocked, newAntispamState } from "../core/antispam";
import { extractFacts } from "../core/facts";
import { isEscalationTemplate } from "../core/followup";
import { buildHandoffText, hasHandoffContent } from "../core/handoff";
import { detectLanguage, looksVietnamese, resolveLanguage } from "../core/language";
import type { KnowledgePort, LlmPort } from "../core/ports";
import { LlmUnavailableError, usableLlm } from "../core/ports";
import { routeHybrid, routeLlmFirst, type Outcome, type RouteResult, type RouterSettings } from "../core/router";
import { fixedEnglish, NETWORK_DISCONNECTED_EN } from "../core/fixed-messages";
import { detectKeyLeak, maskSensitive, REDACTED_LOG_TEXT } from "../core/sanitize";
import type { Settings } from "../core/settings";
import { SettingsService } from "../core/settings";
import { readSummary } from "../core/summary";
import { normalize } from "../core/text";
import type { Template, VisionResult, VisionScreenType } from "../domain/types";
import {
  ESCALATE_TEMPLATE_ID, IMAGE_COVER_SECRET_ID, IMAGE_UNREADABLE_ID, SECURITY_TEMPLATE_ID,
} from "../domain/types";
import type { Db } from "../db/db";
import type { ConvRepo, EpisodeRow, UserRow } from "../db/repo-conv";
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
    if (!fresh.length) {
      // Trùng với một update CHƯA xử lý xong: chưa được báo "đã nhận" với Telegram, nếu không tin sẽ mất khi lượt kia chết giữa chừng.
      for (const it of batch.items) if (it.updateId > 0 && (await conv.updateUnfinished(it.updateId))) return { status: "in_progress", replies: [] };
      return { status: "duplicate", replies: [] };
    }
    const items = fresh;

    try {
      const res = await this.process(batch, items, started);
      for (const it of items) if (it.updateId > 0) await conv.finishUpdate(it.updateId, res.status);
      return res;
    } catch (e) {
      this.log("error", "pipeline error", { err: (e as Error).stack ?? String(e) });
      for (const it of items) if (it.updateId > 0) await conv.finishUpdate(it.updateId, "error").catch(() => undefined);
      // KHÔNG hiển thị lỗi kỹ thuật cho khách (AGENTS.md > Error Handling): gửi thông báo cố định.
      const text = NETWORK_DISCONNECTED_EN;
      await this.send(batch.chatId, text, `err:${items[0]!.updateId}`).catch(() => undefined);
      await this.recordFailure(batch, e).catch((e2) => this.log("error", "không ghi được ca lỗi", { err: (e2 as Error).message }));
      return { status: "error", replies: [text] };
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
      let llm = usableLlm(this.d.llm);
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
      let lang = langRes.lang; // do code nhận diện; ở luồng "AI hiểu trước" AI xác định lại bên dưới (code vẫn kiểm)

      let llmDown = false;
      if (vision?.has_secret) {
        try {
          extraReplies.push((await resolver.forTemplate(IMAGE_COVER_SECRET_ID, lang)).text);
        } catch (e) {
          if (!(e instanceof LlmUnavailableError) || e.badOutput) throw e;
          llmDown = true;
        }
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
        tier3Verify: settings["router.tier3_verify"],
        knowledgeLang: settings["router.knowledge_lang"],
        tooShortMaxChars: settings["router.too_short_max_chars"],
        urlHostWhitelist: this.d.live.urlHosts,
        askWhenUnclear: settings["episode.ask_when_unclear"],
      };
      const isSticker = items.every((i) => i.sticker) ;
      const otherMediaOnly = !rawText && !photos.length && items.some((i) => i.otherMedia) && !isSticker;
      let result: RouteResult;
      if (otherMediaOnly) {
        // Video/voice/tài liệu không kèm chữ: bot không đọc được, cần người thật (vd quay màn hình lỗi)
        result = { outcome: { kind: "ESCALATE", tier: 0, reason: "khách gửi tệp bot không đọc được (video/voice/tài liệu)", sourceTemplateId: lastTemplate?.id }, trace: { gates: [], ranked: [], candidates: [], notes: [] } };
      } else if (photos.length && !vision) {
        result = imgs.failed === "unavailable"
          ? { outcome: { kind: "UNAVAILABLE", tier: 2, reason: "không gọi được SKILL đọc ảnh" }, trace: { gates: [], ranked: [], candidates: [], notes: ["vision không khả dụng"] } }
          : { outcome: { kind: "ESCALATE", tier: 0, reason: imgs.failed === "error" ? "bot không đọc được ảnh khách gửi" : "khách gửi ảnh nhưng vision chưa được cấu hình", sourceTemplateId: lastTemplate?.id }, trace: { gates: [], ranked: [], candidates: [], notes: [] } };
      } else {
        // Mọi tin đi qua AI (hiểu -> tìm -> AI chọn / AI xác nhận). AI không dùng được -> UNAVAILABLE: câu báo mất kết nối cố định, không trả lời thẳng từ kho.
        // Tin sẽ qua AI: báo "đang soạn" mỗi 4 giây cho tới khi có kết quả. Lỗi báo trạng thái không được làm hỏng lượt xử lý.
        const typing = llm && this.d.channel.typing ? this.keepTyping(batch.chatId) : undefined;
        const mode = settings["router.mode"];
        // Không có luồng trả lời thẳng không qua AI (code_first đã bỏ; giá trị cũ trong DB coi như hybrid)
        const router = mode === "llm_first" ? routeLlmFirst : routeHybrid;
        try {
          result = await router(
          { codeDetectedLang: detectLanguage(masked), text: masked, norm: normalize(masked), lang, vision, hasImage: photos.length > 0, isSticker, ctx: { lastTemplate, pendingIssue: loaded.pendingIssue, parentEscalatedGroup: loaded.parentEscalatedGroup, contextPack, pendingClarify: loaded.active?.pending_clarify ?? undefined } },
          { index: this.d.live.index, evaluator: this.d.live.evaluator, settings: rs, llm, knowledge: this.d.knowledge },
          );
        } finally {
          typing?.();
        }
      }
      let outcome: Outcome = llmDown ? { kind: "UNAVAILABLE", tier: result.outcome.tier, reason: "không dịch được cảnh báo ảnh: mất kết nối LLM" } : result.outcome;
      if (result.lang) lang = result.lang;
      if (!isAdmin && lang !== user.language && (result.lang || langRes.update)) await conv.setLanguage(batch.userId, lang);

      // ---- Xây câu trả lời ----
      // Conversation Escalation & Support Summary (core/handoff.ts): khối "sao chép gửi hỗ trợ" chỉ dựng khi thật sự
      // cần (nhánh escalate), tính một lần cho cả lượt dù buildReply có thể được gọi lại (rơi vào escalate do vi
      // phạm ngôn ngữ bên dưới) — tránh gọi lại LLM tóm tắt hai lần cho cùng một lượt.
      let supportSummaryVar: string | undefined;
      const supportLang = lang; // chốt tại đây: không đổi theo các lần buildReply gọi lại bên dưới (vd rơi về "en" cho lưới an toàn)
      const supportSummary = isAdmin ? undefined : async () => (supportSummaryVar ??= await this.buildSupportSummaryVar(loaded.active, supportLang));
      let built;
      try {
        built = await this.buildReply(outcome, lang, loaded.pendingIssue, supportSummary);
      } catch (e) {
        if (!(e instanceof LlmUnavailableError) || e.badOutput) throw e;
        result.trace.notes.push(`không dịch được câu trả lời (${e.message.slice(0, 80)}): gửi câu báo mất kết nối`);
        outcome = { kind: "UNAVAILABLE", tier: outcome.tier, reason: "mất kết nối LLM khi dịch câu trả lời" };
        extraReplies.length = 0;
        built = await this.buildReply(outcome, lang, loaded.pendingIssue, supportSummary);
      }
      // Ràng buộc chung về ngôn ngữ (bằng code, không nhờ LLM): khách nhắn ngôn ngữ nào thì nhận ngôn ngữ đó, và khách không dùng
      // tiếng Việt TUYỆT ĐỐI không nhận chữ tiếng Việt — dù kho tri thức, bản dịch hay LLM trả về gì. Vi phạm -> chuyển người thật.
      const firstMode = built.mode;
      // POLICY VALIDATOR (khối cuối của workflow) — áp dụng cho MỌI câu trả lời, nhánh nào cũng vậy: URL trong danh sách cho phép, không vượt giới hạn Telegram,
      // đúng ngôn ngữ của khách. Không đạt -> Fallback / Escalate.
      const policy = isAdmin ? [] : built.texts.flatMap((t) => checkOutput(t, { urlHostWhitelist: this.d.live.urlHosts, maxChars: TELEGRAM_MAX_CHARS }).problems);
      const langProblem = built.blocked ?? (policy.length ? `không qua kiểm tra chính sách: ${policy.join("; ")}` : !isAdmin && lang !== "vi" && built.texts.some(looksVietnamese) ? `câu trả lời còn tiếng Việt trong khi khách dùng "${lang}"` : undefined);
      if (langProblem) {
        this.log("warn", "chặn câu trả lời vi phạm ràng buộc ngôn ngữ", { userId: batch.userId, lang, problem: langProblem });
        result.trace.notes.push(`ràng buộc ngôn ngữ: ${langProblem}`);
        outcome = { kind: "ESCALATE", tier: outcome.tier, reason: `không gửi được câu trả lời đúng ngôn ngữ của khách: ${langProblem}`.slice(0, 200) }; // không gắn sourceTemplateId: câu tri thức bị chặn không được vào ticket của chủ đề trước đó
        built = await this.buildReply(outcome, lang, loaded.pendingIssue, supportSummary);
        if (lang !== "vi" && built.texts.some(looksVietnamese)) built = await this.buildReply(outcome, "en", loaded.pendingIssue, supportSummary); // template chuyển người thật cũng không được có tiếng Việt
      }
      // Dấu vết các khối của workflow cho quản trị viên xem lại ở mục "Vì sao bot trả lời thế này"
      const stages = [
        "precheck: đạt (bảo mật, chống spam, che dữ liệu)",
        `ngôn ngữ: ${lang} (${result.lang ? "AI xác định, code kiểm lại" : langRes.update || detectLanguage(masked) ? "code nhận diện" : "ngôn ngữ đã ghi nhớ / mặc định"})`,
        `chế độ phản hồi: ${firstMode ?? "-"}`,
        `translation validator: ${firstMode === "blocked" ? "KHÔNG đạt" : firstMode === "fallback_en" ? "không có bản dịch đạt -> dùng bản tiếng Anh đã duyệt" : firstMode === "machine_translation" ? "đạt (số liệu, link, tên sản phẩm, ngôn ngữ đích)" : "không cần dịch máy"}`,
        `policy validator: ${langProblem ? `KHÔNG đạt -> chuyển nhân viên (${langProblem.slice(0, 120)})` : "đạt"}`,
      ];
      result.trace.notes.push(...stages.map((x) => `workflow · ${x}`));
      const replies = [...extraReplies, ...built.texts];

      // ---- Off-topic: bậc thang chặn ----
      let antiEvent: { level: number; blockMs: number } | null = null;
      if (outcome.kind === "OFFTOPIC" && anti && !isAdmin) {
        const o = applyOfftopic(anti, now);
        await conv.saveAntispam(batch.userId, o.state);
        antiEvent = { level: o.level, blockMs: o.blockMs };
        // ngoại lệ do code xử lý: luôn tiếng Anh, không qua AI (core/fixed-messages.ts)
        replies.length = 0;
        replies.push(...extraReplies, fixedEnglish(this.d.live.index, o.templateId));
        await conv.addEvent({ userId: batch.userId, type: o.blockMs ? "antispam_block" : "antispam_warning", payload: { level: o.level, block_minutes: o.blockMs / 60_000, offtopic: masked.slice(0, 120) } }, now);
      } else if (anti && !isAdmin) {
        await conv.saveAntispam(batch.userId, { ...anti, last_seen: now });
      }

      // Lưới an toàn cuối cùng cho MỌI câu sắp gửi (kể cả cảnh báo ảnh chứa key, cảnh báo chống spam dựng sau lớp chặn ở trên):
      // khách không dùng tiếng Việt không nhận chữ tiếng Việt. Thay bằng câu chuyển người thật cố định bằng tiếng Anh.
      if (!isAdmin && lang !== "vi" && replies.some(looksVietnamese)) {
        const safe = (await resolver.forTemplate(ESCALATE_TEMPLATE_ID, "en")).text;
        for (let i = 0; i < replies.length; i++) {
          if (!looksVietnamese(replies[i]!)) continue;
          this.log("warn", "lưới an toàn ngôn ngữ: thay câu trả lời còn tiếng Việt", { userId: batch.userId, lang });
          result.trace.notes.push("ràng buộc ngôn ngữ: một câu trả lời còn tiếng Việt đã bị thay bằng câu chuyển người thật");
          replies[i] = safe;
        }
      }

      // ---- Gửi ----
      const sentIds: (number | undefined)[] = [];
      for (let i = 0; i < replies.length; i++) sentIds.push((await this.send(batch.chatId, replies[i]!, `r:${items[0]!.updateId}:${i}`))?.messageId);

      if (isAdmin) return { status: "ok", replies, decisionKind: outcome.kind, templateId: outcomeTemplateId(outcome), tier: outcome.tier };

      // ---- Ghi nhận: episode, tin nhắn trả lời, sự kiện, quyết định, ticket ----
      const tmpl = this.d.live.index.get(outcomeTemplateId(outcome) ?? "");
      const isEsc = outcome.kind === "ESCALATE" || isEscalationTemplate(tmpl);
      const related = relatedToActive(loaded.active, isEsc, !!result.trace.followUp, tmpl);
      const fin = await this.episodes.finalize({
        relatedToActive: related,
        issueHint: masked.slice(0, 120) || undefined,
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
      // Hỏi lại khách: ghi các mục đang chờ phân biệt; lượt kế tiếp (dù kết quả gì) xoá đi — chỉ hỏi lại 1 lần
      if (outcome.kind === "CLARIFY" && ep) await conv.updateEpisode(ep.id, { pending_clarify: { items: outcome.items } });
      else if (loaded.active?.pending_clarify) await conv.updateEpisode(loaded.active.id, { pending_clarify: null });

      // Nội dung ảnh (đã che) đi cùng sự kiện: các lượt sau vẫn biết ảnh nói gì dù ảnh không được đọc lại
      const imageText = vision && !vision.has_secret ? maskSensitive(vision.error_text).replace(/["\s]+/g, " ").trim().slice(0, 160) : "";
      if (vision) await conv.addEvent({ userId: batch.userId, episodeId: ep?.id ?? null, type: "image_received", payload: { image_type: vision.screen_type, count: photos.length, ...(imageText ? { error_text: imageText } : {}) } }, now);
      // Giá trị khách nêu (mã lỗi, phiên bản, số lượng...): code trích, không nhờ LLM nhớ
      // Trích trên cả bản tiếng Anh do AI viết lại: mẫu trích viết cho Anh/Việt, không đọc được "ошибку 504, версия 2.3.1" trong tiếng Nga/Hàn
      const facts = ep ? extractFacts([masked, imageText, result.queryEn].filter(Boolean).join("\n")) : [];
      if (ep && facts.length) await conv.addEvent({ userId: batch.userId, episodeId: ep.id, type: "customer_fact", payload: { facts } }, now);
      const outIds: number[] = [];
      for (let i = 0; i < replies.length; i++) {
        outIds.push(await conv.addMessage({ at: now, episodeId: ep?.id ?? null, userId: batch.userId, direction: "out", text: replies[i]!, language: built.lang ?? lang, tier: outcome.tier, templateId: outcomeTemplateId(outcome), telegramMessageId: sentIds[i] ?? null, latencyMs: Date.now() - started }));
      }
      const tid = outcomeTemplateId(outcome);
      if (tid) await conv.addEvent({ userId: batch.userId, episodeId: ep?.id ?? null, type: "template_sent", payload: { template_id: tid, tier: outcome.tier } }, now);

      let ticketId: number | null = null;
      if (isEsc) ticketId = await this.escalate(batch, ep?.id ?? null, outcome, tmpl, related ? lastTemplate : undefined, related ? loaded.active?.topic_group ?? null : null, masked);

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
      if (ep && usableLlm(this.d.llm)) {
        const unsummarized = await conv.countUnsummarized(ep.id, ep.summary_upto_message_id);
        if (unsummarized >= settings["episode.summary_every_k"]) {
          const last = await conv.lastMessageId(ep.id);
          await ops.enqueueJob("summarize-episode", { episodeId: ep.id }, { dedupeKey: `sum:${ep.id}:${last}` });
        }
      }
      return { status: "ok", replies, decisionKind: outcome.kind, templateId: tid, tier: outcome.tier };
    });
  }

  /** Lượt xử lý hỏng giữa chừng: khách chỉ nhận câu báo mất kết nối cố định (NETWORK_DISCONNECTED_EN), nên phải để lại ticket + quyết định cho người thật theo dõi. */
  private async recordFailure(batch: InboundBatch, e: unknown) {
    const { conv, ops } = this.d;
    if (await ops.getAdmin(batch.userId)) return;
    const now = this.now();
    const reason = `lỗi hệ thống khi xử lý tin của khách: ${((e as Error)?.message ?? String(e)).slice(0, 160)}`;
    const open = await conv.openTicketFor(batch.userId, "system-error");
    const ticketId = open ? open.id : (await conv.createTicket({ episodeId: null, userId: batch.userId, category: "system-error", reason })).id;
    if (open) await conv.appendTicketNote(open.id, `[${now.toISOString()}] ${reason}`);
    await conv.addDecision({ at: now, messageId: null, episodeId: null, userId: batch.userId, kind: "UNAVAILABLE", tier: 0, templateId: null, via: "pipeline_error", reason, notes: { ticket_id: ticketId }, kbVersion: this.d.live.version });
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
    const alert = { text: fixedEnglish(this.d.live.index, SECURITY_TEMPLATE_ID) }; // ngoại lệ do code xử lý: chạy cả khi mất LLM
    await this.send(batch.chatId, alert.text, `fp0:${items[0]!.updateId}`);

    if (!isAdmin) {
      const mid = await conv.addMessage({ at: now, episodeId: null, userId: batch.userId, direction: "in", text: REDACTED_LOG_TEXT, language: user.language });
      // Episode bảo mật RIÊNG: không ghi đè vấn đề khách đang được hỗ trợ (vd KYC đang mở vẫn giữ nguyên issue/trạng thái).
      const ep = await conv.openEpisode({ userId: batch.userId, issue: "security-alert-key-leak", topicGroup: "Security" }, now);
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
  private async buildReply(outcome: Outcome, lang: string, pendingIssue: string | undefined, supportSummary?: () => Promise<string>): Promise<{ texts: string[]; lang?: string; note?: string; blocked?: string; mode?: string }> {
    const { resolver } = this.d;
    switch (outcome.kind) {
      case "TEMPLATE": {
        const vars: Record<string, string> = { ISSUE: pendingIssue ?? "" };
        // Một số template escalate cụ thể (esc-wallet-create...) trỏ answer_from về fp-12-escalate: cùng khối {SUPPORT_SUMMARY}.
        if (supportSummary && isEscalationTemplate(this.d.live.index.get(outcome.templateId))) vars.SUPPORT_SUMMARY = await supportSummary();
        const r = await resolver.forTemplate(outcome.templateId, lang, vars);
        return { texts: [r.text], lang: r.lang, note: r.note, mode: r.mode };
      }
      case "ESCALATE": {
        const vars: Record<string, string> = {};
        if (supportSummary) vars.SUPPORT_SUMMARY = await supportSummary();
        const r = await resolver.forTemplate(ESCALATE_TEMPLATE_ID, lang, vars);
        return { texts: [r.text], lang: r.lang, note: r.note, mode: r.mode };
      }
      case "GROUNDED": {
        const r = await resolver.dynamic(outcome.answer, lang, outcome.sourceLang);
        if (r.blocked) return { texts: [], lang, note: r.note, blocked: r.note ?? "không dịch được", mode: r.mode };
        // Câu AI viết (chế độ sinh) được lưu để admin xem/sửa/duyệt ở mục Bản dịch (khoá answer:<hash đoạn nguồn>); bản dịch đoạn thì resolver đã lưu (chunk:<hash>)
        if (outcome.mode === "generative" && outcome.sourceHash) await this.d.kb.saveTranslation(`answer:${outcome.sourceHash}`, r.lang, r.text, outcome.sourceHash, "llm", "pending").catch(() => undefined);
        return { texts: [r.text], lang: r.lang, note: r.note, mode: outcome.mode === "generative" ? "generated" : r.mode };
      }
      case "OFFTOPIC":
        return { texts: [], lang }; // câu cảnh báo do nhánh anti-spam dựng
      case "UNAVAILABLE":
        return { texts: [NETWORK_DISCONNECTED_EN], lang: "en", mode: "fixed_en", note: outcome.reason };
      case "CLARIFY": {
        // câu hỏi lại đã được người duyệt viết (tiếng Anh) trong mục hỏi đáp: dịch trung thành như mọi câu đã duyệt
        const r = await this.d.resolver.dynamic(outcome.question, lang, "en");
        if (r.blocked) return { texts: [], lang, note: r.note, blocked: r.note ?? "không dịch được", mode: r.mode };
        return { texts: [r.text], lang: r.lang, note: r.note, mode: r.mode };
      }
    }
  }

  /**
   * Conversation Escalation & Support Summary: khối văn bản khách sao chép gửi @interlink_technicalsupport khi bot
   * chuyển người thật. Phạm vi = episode đang mở (`active`), tức đúng vấn đề hiện tại — EpisodeManager đã tách theo
   * topic_group/khoảng lặng nên KHÔNG lẫn các vấn đề cũ. Không có episode đang mở (escalate ngay từ câu đầu, chưa có
   * gì để tóm tắt) -> trả về "" (không thêm khối trống vào câu trả lời).
   * Nội dung DỰNG bằng tiếng Anh trước (issue/tóm tắt vốn đã viết tiếng Anh — SKILL summarize-episode), qua HAI lớp
   * kiểm trước khi gửi khách — đúng yêu cầu: không chỉ tóm tắt-dịch-gửi thẳng:
   *  1. code: `checkOutput` (forbidFinancialClaims: dự đoán giá/ROI, công thức HCS — cùng chuẩn với câu AI viết ở
   *     nhánh GROUNDED sinh, vì đây cũng là văn bản gửi khách lần đầu, chưa qua tay admin duyệt trước);
   *  2. SKILL verify-handoff (LLM): xác nhận nội dung đúng nguồn, không vi phạm giới hạn nghiệp vụ (R1-R3).
   * Không đạt ở bước nào -> bỏ khối này (KHÔNG gửi câu trả lời rỗng: vẫn còn câu FP-12 + ticket, chỉ thiếu phần tóm tắt).
   * Đạt cả hai -> dịch sang đúng NGÔN NGỮ KHÁCH ĐANG DÙNG qua `resolver.translateFreeform` (cùng SKILL dịch, cùng
   * kiểm chứng `translationProblems` như mọi nội dung khác); dịch lỗi/không đạt -> gửi nguyên văn tiếng Anh.
   */
  private async buildSupportSummaryVar(active: EpisodeRow | null, lang: string): Promise<string> {
    if (!active) return "";
    const llm = usableLlm(this.d.llm);
    const summary = llm ? await this.episodes.summarizeNow(llm, active.id).catch(() => readSummary(active.summary)) : readSummary(active.summary);
    const stepsSent = await this.episodes.stepsSent(active.id);
    const inp = { issue: active.issue, summary, stepsSent };
    if (!hasHandoffContent(inp)) return "";
    const body = buildHandoffText(inp);
    const policyChk = checkOutput(body, { urlHostWhitelist: this.d.live.urlHosts, forbidFinancialClaims: true });
    if (!policyChk.ok) {
      this.log("warn", "khối tóm tắt chuyển hỗ trợ: không qua kiểm tra chính sách, bỏ khối này", { episodeId: active.id, problems: policyChk.problems });
      return "";
    }
    if (llm) {
      try {
        const v = await llm.verifyHandoff({ text: body, source: { issue: active.issue ?? "", userReported: summary?.user_reported ?? "", unresolvedPoints: summary?.unresolved_points ?? "", facts: summary?.exact_facts ?? [], steps: stepsSent } });
        if (!v.ok) {
          this.log("warn", "khối tóm tắt chuyển hỗ trợ: SKILL verify-handoff từ chối, bỏ khối này", { episodeId: active.id, reason: v.reason });
          return "";
        }
      } catch (e) {
        this.log("warn", "khối tóm tắt chuyển hỗ trợ: verify-handoff lỗi, bỏ khối này", { episodeId: active.id, err: (e as Error).message });
        return "";
      }
    }
    const en = `📋 Summary to send to support (tap to copy):\n\`\`\`\n${body}\n\`\`\``;
    const { text: block } = await this.d.resolver.translateFreeform(en, lang);
    return `\n\n${block}`;
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
  private async readImages(batch: InboundBatch, photos: InboundBatch["items"], caption: string, llm: LlmPort | undefined, isAdmin: boolean): Promise<{ vision?: VisionResult; failed?: "unavailable" | "no_vision" | "error"; note?: string }> {
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
        if (e instanceof LlmUnavailableError && !e.badOutput) return { failed: "unavailable" };
        // từ chối đọc ảnh, đầu ra sai, tải ảnh lỗi...: không đoán nội dung ảnh, chuyển người thật
        return { failed: "error", note: `không đọc được ảnh: ${(e as Error).message.slice(0, 160)}` };
      }
    }
    return { vision: combineVision(results), note };
  }

  /** Gửi "đang soạn" ngay và lặp lại mỗi 4 giây; trả về hàm dừng. */
  private keepTyping(chatId: number): () => void {
    const ping = () => this.d.channel.typing?.(chatId).catch(() => undefined);
    void ping();
    const timer = setInterval(() => void ping(), 4000);
    return () => clearInterval(timer);
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

/**
 * Lượt chuyển người thật có thuộc vấn đề của episode đang mở không?
 *  - follow-up (no / not receive / thêm ảnh...)   -> có
 *  - template escalate có danh mục ticket          -> có khi danh mục trùng nhóm chủ đề của episode
 *  - câu không khớp gì                             -> có khi episode còn "open" (trong T_gap: "phân vân -> follow-up"); đã tạm lắng thì là việc mới
 */
function relatedToActive(active: { status: string; topic_group: string | null } | null, escalating: boolean, followUp: boolean, tmpl: Template | undefined): boolean {
  if (!active || !escalating || followUp) return true;
  const category = tmpl?.ticket?.category;
  if (category) return !active.topic_group || category.toLowerCase() === active.topic_group.toLowerCase();
  return active.status === "open";
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
