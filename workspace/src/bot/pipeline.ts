/**
 * BotPipeline: một lượt xử lý tin nhắn.
 *   idempotency -> nhóm -> FP-0 -> (admin) -> chặn spam -> ảnh -> ngôn ngữ -> episode -> router+cổng -> trả lời -> ghi nhận
 * Mọi luật bắt buộc nằm ở đây và trong core/*, bằng code — không phụ thuộc LLM có "nhớ" prompt hay không.
 */
import { checkOutput, TELEGRAM_MAX_CHARS } from "../core/gate";
import { applyOfftopic, blockJustExpired, isBlocked, newAntispamState } from "../core/antispam";
import { extractFacts, mergeFacts, type CustomerFact } from "../core/facts";
import { isEscalationTemplate } from "../core/followup";
import { topicKeyOf, topicKeyOfGroup } from "../core/items";
import { buildHandoffText, handoffReasonOf, hasDiacritics, hasHandoffContent, timelineLine, type HandoffInput, type HandoffReason } from "../core/handoff";
import { detectLanguage, looksVietnamese, resolveLanguage } from "../core/language";
import type { KnowledgePort, LlmPort } from "../core/ports";
import { LlmUnavailableError, usableLlm } from "../core/ports";
import { routeHybrid, routeLlmFirst, type Outcome, type RouteResult, type RouterSettings } from "../core/router";
import { NETWORK_DISCONNECTED_EN, NETWORK_DISCONNECTED_ID } from "../core/fixed-messages";
import { detectKeyLeak, maskSensitive, REDACTED_LOG_TEXT, withoutSecrets } from "../core/sanitize";
import type { Settings } from "../core/settings";
import { prewarmLanguages, SettingsService } from "../core/settings";
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
import type { ResponseResolver, UrgentOptions, UrgentText } from "./resolver";
import type { Channel, InboundBatch, MessageEntity, PipelineResult } from "./types";

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
    this.episodes = new EpisodeManager(d.conv, (id) => d.live.index.get(id));
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
      // KHÔNG hiển thị lỗi kỹ thuật cho khách (AGENTS.md > Error Handling): câu báo mất kết nối bằng ngôn ngữ đã nhớ của khách
      // (bản dịch sẵn; không dịch tại chỗ). Lỗi ở đây có thể chính là lỗi DB: mọi bước đều có lối cuối là câu gốc trong mã nguồn.
      const lang = (await this.d.conv.getUser(batch.userId).catch(() => null))?.language ?? "en";
      const text = (await this.d.resolver.forUrgent(NETWORK_DISCONNECTED_ID, lang, { live: false, fallback: "english" }).catch(() => null))?.text ?? NETWORK_DISCONNECTED_EN;
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
    if (leak) return this.handleKeyLeak(batch, items, user, leak, isAdmin, started, settings);

    const masked = maskSensitive(rawText);

    // ================= Admin: lệnh console đã chuyển sang web =================
    if (isAdmin && ADMIN_COMMAND.test(rawText)) {
      const vi = await resolver.forTemplate("admin-console-moved", "vi", { URL: this.d.adminWebUrl });
      const r = vi.blocked ? await resolver.forTemplate("admin-console-moved", "en", { URL: this.d.adminWebUrl }) : vi; // tin cho admin: dịch không đạt thì dùng bản gốc
      const text = r.text;
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

      // Câu khẩn (đường dịch nhanh): chỉ bước AI dịch, bản dịch sẵn hoặc dịch tại chỗ với thời gian chờ ngắn
      const urgent = (id: string, l: string, o: Omit<UrgentOptions, "timeoutMs" | "live"> & { live?: boolean }) =>
        resolver.forUrgent(id, l, { live: o.live ?? !!llm, timeoutMs: settings["translation.urgent_timeout_ms"], ...o });
      if (vision?.has_secret) {
        // cảnh báo ảnh chứa key cùng loại với cảnh báo bảo mật: không có bản dịch hợp lệ thì gửi bản gốc tiếng Anh, không bỏ cảnh báo
        const warn = await urgent(IMAGE_COVER_SECRET_ID, lang, { fallback: "english" });
        extraReplies.push(warn.text!);
        if (warn.source === "fallback") await this.urgentFallback(batch.userId, IMAGE_COVER_SECRET_ID, lang, now);
      }

      // Ảnh đã lưu gắn vào tin đến: xoá / mở ảnh theo khách được
      if (messageId && (imgs.refs.length || vision)) await conv.setMessageImages(messageId, imgs.refs, vision?.screen_type ?? null);

      // ---- Episode + ngữ cảnh ----
      const loaded = isAdmin ? { active: null, gapMs: 0, recent: [] as never[] } : await this.episodes.load(batch.userId, now, settings);
      const lastTemplate = loaded.active?.last_template_id ? this.d.live.index.get(loaded.active.last_template_id) : undefined;
      const contextPack = isAdmin ? undefined : await this.episodes.contextPack(user, lang, loaded as never, now);
      // Câu trả lời gần nhất là đoạn tài liệu: đưa nội dung đoạn cho SKILL understand để nhận ra tin nối tiếp ("vẫn không được")
      const lastRef = loaded.active?.last_ref;
      const lastChunk = !lastTemplate && lastRef?.startsWith("K:") && this.d.knowledge?.byIds ? (await this.d.knowledge.byIds([lastRef.slice(2)]))[0] : undefined;

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
        maxClarify: settings["episode.max_clarify_per_episode"],
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
          { codeDetectedLang: detectLanguage(masked), text: masked, norm: normalize(masked), lang, vision, hasImage: photos.length > 0, isSticker, ctx: { lastTemplate, lastAnswer: lastChunk ? { id: lastRef!, text: lastChunk.text } : undefined, pendingIssue: loaded.pendingIssue, parentEscalatedGroup: loaded.parentEscalatedGroup, contextPack, pendingClarify: loaded.active?.pending_clarify ?? undefined, clarifyCount: loaded.active?.clarify_count ?? 0, answersSent: loaded.active ? await this.episodes.answersSent(loaded.active.id) : undefined } },
          { index: this.d.live.index, evaluator: this.d.live.evaluator, settings: rs, llm, knowledge: this.d.knowledge, conflicts: this.d.live.conflicts, answerTime: (k: string) => this.d.live.answerTimes.get(k) },
          );
        } finally {
          typing?.();
        }
      }
      let outcome: Outcome = result.outcome;
      if (result.lang) lang = result.lang;
      if (!isAdmin && lang !== user.language && (result.lang || langRes.update)) {
        await conv.setLanguage(batch.userId, lang);
        // Ngôn ngữ chưa có trong danh sách dịch sẵn: dịch sẵn nhóm câu khẩn cho ngôn ngữ này ngay (câu khẩn phải gửi được cả khi mất AI)
        if (lang !== "en" && !prewarmLanguages(settings).includes(lang) && usableLlm(this.d.llm)) {
          await ops.enqueueJob("prewarm-urgent-translations", { langs: [lang] }, { dedupeKey: `prewarm:${lang}:${now.toISOString().slice(0, 10)}` }).catch(() => undefined);
        }
      }

      // ---- Kết quả của bước bot gửi trước đó (khách phản hồi thế nào): code ghi từ kết quả SKILL understand ----
      const routedTmpl = this.d.live.index.get(outcomeTemplateId(outcome) ?? "");
      if (!isAdmin && loaded.active && (result.understand || result.trace.followUp)) await this.recordStepOutcome(loaded.active, result.understand, result.trace.followUp, routedTmpl, now);

      // ---- Vụ việc của lượt này: xác định TRƯỚC khi dựng câu trả lời (khối tóm tắt chuyển nhân viên, mã tham chiếu, ticket dùng đúng vụ việc) ----
      const resolveFor = (o: Outcome, t: Template | undefined) => {
        const esc = o.kind === "ESCALATE" || isEscalationTemplate(t);
        return this.episodes.resolveEpisode({
          userId: batch.userId,
          now,
          settings,
          active: loaded.active,
          kind: o.kind,
          template: o.kind === "OFFTOPIC" ? undefined : t ?? (o.kind === "ESCALATE" ? this.d.live.index.get(ESCALATE_TEMPLATE_ID) : undefined),
          followUp: !!result.trace.followUp || result.understand?.intent === "follow_up",
          relatedToActive: relatedToActive(loaded.active, esc, !!result.trace.followUp, t),
          issueHint: masked.slice(0, 120) || undefined,
          messageId,
          isQuestion: result.understand?.intent === "question",
          queryEn: result.queryEn,
        });
      };
      let resolved = isAdmin ? null : await resolveFor(outcome, routedTmpl);
      let ep = resolved?.episode ?? null;

      // ---- Xây câu trả lời ----
      // Khối "tóm tắt gửi hỗ trợ" (core/handoff.ts): chỉ dựng khi thật sự cần (nhánh chuyển nhân viên), tính một lần cho cả lượt
      // dù buildReply có thể được gọi lại (rơi vào chuyển nhân viên do vi phạm ngôn ngữ bên dưới) — không gọi LLM tóm tắt hai lần.
      let supportSummaryVar: string | undefined;
      const supportLang = lang; // chốt tại đây: không đổi theo các lần buildReply gọi lại bên dưới
      const supportSummary = isAdmin ? undefined : async (reason: HandoffReason) => (supportSummaryVar ??= await this.buildSupportSummaryVar(ep, supportLang, reason, settings["handoff.max_timeline_steps"]));
      let built;
      try {
        built = await this.buildReply(outcome, lang, loaded.pendingIssue, supportSummary, ep?.ref_code);
      } catch (e) {
        if (!(e instanceof LlmUnavailableError) || e.badOutput) throw e;
        result.trace.notes.push(`không dịch được câu trả lời (${e.message.slice(0, 80)}): gửi câu báo mất kết nối`);
        outcome = { kind: "UNAVAILABLE", tier: outcome.tier, reason: "mất kết nối LLM khi dịch câu trả lời" };
        extraReplies.length = 0;
        built = await this.buildReply(outcome, lang, loaded.pendingIssue, supportSummary, ep?.ref_code);
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
        // Lượt không mở vụ việc (vd lời chào) nay thành chuyển nhân viên: mở vụ việc cho lần chuyển này (ticket, mã tham chiếu)
        if (!isAdmin && !ep) {
          resolved = await resolveFor(outcome, undefined);
          ep = resolved.episode;
        }
        built = await this.buildReply(outcome, lang, loaded.pendingIssue, supportSummary, ep?.ref_code);
        // Câu chuyển người thật cũng dịch nhiều lần không đạt (hiếm): khách vẫn phải được báo là đã chuyển người thật. Câu khẩn: bản dịch
        // sẵn / dịch tại chỗ; không có bản dịch hợp lệ thì lối cuối là bản gốc tiếng Anh (không bao giờ tiếng Việt cho khách không dùng
        // tiếng Việt), có ghi vết. Khối tóm tắt (đã dịch, nếu có) vẫn đi kèm.
        if (built.blocked || !built.texts.length || (lang !== "vi" && built.texts.some(looksVietnamese))) {
          const esc = await urgent(ESCALATE_TEMPLATE_ID, lang, { fallback: "english", vars: { REF: ep?.ref_code ?? "" } });
          result.trace.notes.push(`câu chuyển người thật không dịch được sang ${lang} (${(built.blocked ?? "").slice(0, 120)}): dùng ${esc.source === "fallback" ? "bản gốc tiếng Anh" : "bản dịch của câu khẩn"}`);
          if (esc.source === "fallback") await this.urgentFallback(batch.userId, ESCALATE_TEMPLATE_ID, lang, now);
          const block = supportSummary ? await supportSummary(handoffReasonOf(outcome.reason)) : "";
          built = { texts: [esc.text!, ...(block ? [block] : [])], lang: esc.lang, mode: `urgent_${esc.source}`, handoffBlock: block || undefined };
        }
      }
      // Dấu vết các khối của workflow cho quản trị viên xem lại ở mục "Vì sao bot trả lời thế này"
      const stages = [
        "precheck: đạt (bảo mật, chống spam, che dữ liệu)",
        `ngôn ngữ: ${lang} (${result.lang ? "AI xác định, code kiểm lại" : langRes.update || detectLanguage(masked) ? "code nhận diện" : "ngôn ngữ đã ghi nhớ / mặc định"})`,
        `chế độ phản hồi: ${firstMode ?? "-"}`,
        `translation validator: ${firstMode === "blocked" ? "KHÔNG đạt sau nhiều lần dịch lại -> chuyển nhân viên" : firstMode === "machine_translation" || firstMode === "stored_translation" ? "đạt (số liệu, link, tên sản phẩm, ngôn ngữ đích)" : "không cần dịch"}`,
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
        // Câu khẩn: bản dịch sẵn / dịch tại chỗ sang ngôn ngữ của khách. Không có bản dịch hợp lệ: không gửi câu, bậc chặn vẫn áp dụng
        const warn = await urgent(o.templateId, lang, { fallback: "none" });
        replies.length = 0;
        replies.push(...extraReplies, ...(warn.text ? [warn.text] : []));
        await conv.addEvent({ userId: batch.userId, type: o.blockMs ? "antispam_block" : "antispam_warning", payload: { level: o.level, block_minutes: o.blockMs / 60_000, offtopic: masked.slice(0, 120), lang: warn.lang, source: warn.source } }, now);
        if (warn.source === "none") await this.urgentFallback(batch.userId, o.templateId, lang, now);
      } else if (anti && !isAdmin) {
        await conv.saveAntispam(batch.userId, { ...anti, last_seen: now });
      }

      // Lưới an toàn cuối cùng cho MỌI câu sắp gửi (kể cả cảnh báo ảnh chứa key, cảnh báo chống spam dựng sau lớp chặn ở trên):
      // khách không dùng tiếng Việt không nhận chữ tiếng Việt. Thay bằng câu chuyển người thật (câu khẩn, ngôn ngữ của khách).
      if (!isAdmin && lang !== "vi" && replies.some(looksVietnamese)) {
        const esc = await urgent(ESCALATE_TEMPLATE_ID, lang, { fallback: "english", vars: { REF: ep?.ref_code ?? "" } });
        const safe = esc.text!;
        const kept: string[] = [];
        for (const r of replies) {
          if (!looksVietnamese(r)) kept.push(r);
          else if (r === built.handoffBlock) result.trace.notes.push("ràng buộc ngôn ngữ: khối tóm tắt còn tiếng Việt, bỏ khối (khách vẫn có mã tham chiếu)");
          else {
            this.log("warn", "lưới an toàn ngôn ngữ: thay câu trả lời còn tiếng Việt", { userId: batch.userId, lang });
            result.trace.notes.push("ràng buộc ngôn ngữ: một câu trả lời còn tiếng Việt đã bị thay bằng câu chuyển người thật");
            if (!kept.includes(safe)) kept.push(safe);
          }
        }
        replies.splice(0, replies.length, ...kept);
      }

      // ---- Gửi ----
      const sentIds: (number | undefined)[] = [];
      // Khối tóm tắt gửi dạng khối code (entity "pre", không dùng parse_mode): khách chạm để sao chép nguyên khối
      for (let i = 0; i < replies.length; i++) {
        const text = replies[i]!;
        const entities = text === built.handoffBlock ? [{ type: "pre" as const, offset: 0, length: text.length }] : undefined;
        sentIds.push((await this.send(batch.chatId, text, `r:${items[0]!.updateId}:${i}`, entities))?.messageId);
      }

      if (isAdmin) return { status: "ok", replies, decisionKind: outcome.kind, templateId: outcomeTemplateId(outcome), tier: outcome.tier };

      // ---- Ghi nhận: episode, tin nhắn trả lời, sự kiện, quyết định, ticket ----
      const tmpl = this.d.live.index.get(outcomeTemplateId(outcome) ?? "");
      const isEsc = outcome.kind === "ESCALATE" || isEscalationTemplate(tmpl);
      const related = relatedToActive(loaded.active, isEsc, !!result.trace.followUp, tmpl);
      if (ep) {
        const sentRef = outcome.kind === "TEMPLATE" && topicKeyOf(tmpl) ? `T:${outcome.templateId}` : outcome.kind === "GROUNDED" && outcome.sources[0] ? `K:${outcome.sources[0].chunkId}` : undefined;
        ep = await this.episodes.commitEpisode(ep, {
          now,
          kind: outcome.kind,
          template: outcome.kind === "OFFTOPIC" ? undefined : tmpl ?? (outcome.kind === "ESCALATE" ? this.d.live.index.get(ESCALATE_TEMPLATE_ID) : undefined),
          escalateReason: outcome.kind === "ESCALATE" ? outcome.reason : undefined,
          sentRef,
        });
      } else if (outcome.kind === "UNAVAILABLE" && messageId && masked.trim()) {
        // Câu hỏi gửi lúc mất kết nối AI, chưa thuộc vụ việc nào: vụ việc mở ở lượt kế tiếp nhận tin này làm điểm bắt đầu
        await conv.addEvent({ userId: batch.userId, type: "unanswered_question", payload: { message_id: messageId } }, now);
      }
      // Hỏi lại khách: ghi các mục đang chờ phân biệt; lượt kế tiếp (dù kết quả gì) xoá đi — chỉ hỏi lại 1 lần
      // Vết hỏi lại trong events (pending_clarify bị xoá sau một lượt): dòng thời gian của khối tóm tắt và thống kê tỉ lệ hỏi lại thành công
      if (loaded.active?.pending_clarify) {
        const asked = loaded.active.pending_clarify.items.map((x) => (/^[TK]:/.test(x) ? x : `T:${x}`));
        const got = outcome.kind === "TEMPLATE" ? `T:${outcome.templateId}` : outcome.kind === "GROUNDED" && outcome.sources[0] ? `K:${outcome.sources[0].chunkId}` : null;
        await conv.addEvent({ userId: batch.userId, episodeId: loaded.active.id, type: "clarify_answered", payload: { chosen: got && asked.includes(got) ? got : null } }, now);
      }
      if (outcome.kind === "CLARIFY" && ep) {
        await conv.updateEpisode(ep.id, { pending_clarify: { items: outcome.items } });
        await conv.addEvent({ userId: batch.userId, episodeId: ep.id, type: "clarify_asked", payload: { refs: outcome.items, message_id: messageId } }, now);
      } else if (loaded.active?.pending_clarify) await conv.updateEpisode(loaded.active.id, { pending_clarify: null });

      // Nội dung ảnh (đã che) đi cùng sự kiện: các lượt sau vẫn biết ảnh nói gì dù ảnh không được đọc lại
      const imageText = vision && !vision.has_secret ? maskSensitive(vision.error_text).replace(/["\s]+/g, " ").trim().slice(0, 160) : "";
      if (vision) await conv.addEvent({ userId: batch.userId, episodeId: ep?.id ?? null, type: "image_received", payload: { image_type: vision.screen_type, count: photos.length, ...(imageText ? { error_text: imageText } : {}) } }, now);
      // Giá trị khách nêu (mã lỗi, phiên bản, số lượng...): code trích, không nhờ LLM nhớ
      // Trích trên cả bản tiếng Anh do AI viết lại: mẫu trích viết cho Anh/Việt, không đọc được "ошибку 504, версия 2.3.1" trong tiếng Nga/Hàn
      const facts = ep ? extractFacts([masked, imageText, result.queryEn].filter(Boolean).join("\n")) : [];
      if (ep && facts.length) await conv.addEvent({ userId: batch.userId, episodeId: ep.id, type: "customer_fact", payload: { facts } }, now);
      // Thiết bị / phiên bản app: giá trị ổn định của khách, giữ qua các vụ việc (users.profile, hết hạn 30 ngày ở contextPack)
      const stable = Object.fromEntries(facts.filter((f) => f.kind === "device" || f.kind === "app_version").map((f) => [f.kind, { value: f.value, seen_at: now.toISOString() }]));
      if (Object.keys(stable).length) await conv.updateProfile(batch.userId, stable);
      const outIds: number[] = [];
      for (let i = 0; i < replies.length; i++) {
        outIds.push(await conv.addMessage({ at: now, episodeId: ep?.id ?? null, userId: batch.userId, direction: "out", text: replies[i]!, language: built.lang ?? lang, tier: outcome.tier, templateId: outcomeTemplateId(outcome), telegramMessageId: sentIds[i] ?? null, latencyMs: Date.now() - started }));
      }
      const tid = outcomeTemplateId(outcome);
      if (tid) await conv.addEvent({ userId: batch.userId, episodeId: ep?.id ?? null, type: "template_sent", payload: { template_id: tid, tier: outcome.tier } }, now);
      if (outcome.kind === "GROUNDED") await conv.addEvent({ userId: batch.userId, episodeId: ep?.id ?? null, type: "knowledge_sent", payload: { chunk_ids: outcome.sources.map((s) => s.chunkId), headings: outcome.sources.map((s) => s.heading) } }, now);

      let ticketId: number | null = null;
      if (isEsc) ticketId = await this.escalate(batch, ep, outcome, tmpl, related ? lastTemplate : undefined, related ? loaded.active?.topic_group ?? null : null, masked);

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
        notes: { new_question: newQuestion, follow_up: trace.followUp ?? null, llm: trace.llm ?? null, notes: [...trace.notes, ...(built.note ? [built.note] : []), ...(imgs.note ? [imgs.note] : [])], ticket_id: ticketId, anti: antiEvent, switched: resolved?.switchedFrom?.id ?? null, reopened: resolved?.reopened ?? false, ref_code: ep?.ref_code ?? null, handoff_reason: isEsc ? (outcome.kind === "ESCALATE" ? handoffReasonOf(outcome.reason, trace.followUp) : "other") : null },
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

  /**
   * Khách phản hồi thế nào sau nội dung bot vừa gửi trong vụ việc (`last_ref`): ghi event `step_outcome` một lần cho mỗi lần
   * gửi, từ kết quả của lượt này — loại tin nối tiếp do SKILL understand hoặc luật nối tiếp bằng code nhận ra (không thêm lời
   * gọi AI). Khách hỏi sang chủ đề khác thì không ghi.
   */
  private async recordStepOutcome(active: EpisodeRow, u: RouteResult["understand"], codeFollowUp: string | undefined, routed: Template | undefined, now: Date) {
    const ref = active.last_ref;
    if (!ref) return;
    const byFollowUp: Partial<Record<string, string>> = { thanks: "solved", negative: "not_solved", not_receive: "not_received", no_old_email: "no_old_email", info_provided: "info_provided" };
    let outcome: string | undefined;
    if (u?.intent === "follow_up") outcome = byFollowUp[u.follow_up];
    else if (codeFollowUp) outcome = byFollowUp[codeFollowUp];
    else if (u?.intent === "question") {
      const key = topicKeyOf(routed);
      const activeKey = active.topic_key ?? topicKeyOfGroup(active.topic_group);
      if (!key || !activeKey || key === activeKey) outcome = "asked_again";
    }
    if (!outcome) return;
    const events = await this.d.conv.episodeEvents(active.id);
    const sentAt = events.map((e, i) => ({ e, i })).filter(({ e }) => sentRefsOf(e).includes(ref)).pop()?.i;
    if (sentAt === undefined) return;
    if (events.slice(sentAt + 1).some((e) => e.type === "step_outcome" && (e.payload as { ref?: unknown }).ref === ref)) return; // mỗi lần gửi chỉ một kết quả
    await this.d.conv.addEvent({ userId: active.user_id, episodeId: active.id, type: "step_outcome", payload: { ref, outcome, via: "understand" } }, now);
  }

  /**
   * Câu khẩn không có bản dịch hợp lệ (chưa dịch sẵn và AI không dịch được lúc đó): ghi vết để theo dõi, và xếp việc dịch sẵn
   * cho ngôn ngữ này để lần sau gửi được bằng ngôn ngữ của khách.
   */
  private async urgentFallback(userId: number, templateId: string, lang: string, now: Date) {
    await this.d.conv.addEvent({ userId, type: "urgent_fallback", payload: { template_id: templateId, lang } }, now).catch(() => undefined);
    if (usableLlm(this.d.llm)) await this.d.ops.enqueueJob("prewarm-urgent-translations", { langs: [lang] }, { dedupeKey: `prewarm:${lang}:${now.toISOString().slice(0, 13)}` }).catch(() => undefined);
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
  private async handleKeyLeak(batch: InboundBatch, items: InboundBatch["items"], user: UserRow, pattern: "A" | "B" | "C", isAdmin: boolean, started: number, settings: Settings): Promise<PipelineResult> {
    const { conv, resolver } = this.d;
    const now = this.now();
    // Ngôn ngữ nhận diện trên phần chữ còn lại SAU KHI BỎ bí mật (từ seed BIP39 là tiếng Anh, sẽ kéo ngôn ngữ về "en"); không còn
    // chữ nào thì dùng ngôn ngữ đã nhớ. Không cập nhật ngôn ngữ đã nhớ từ tin có bí mật.
    const lang = resolveLanguage(maskSensitive(withoutSecrets(items.map((i) => i.text ?? "").join("\n"))), user.language).lang;
    // Câu khẩn: bản dịch sẵn / dịch tại chỗ. Lời gọi dịch chỉ nhận câu mẫu, KHÔNG BAO GIỜ nhận tin có bí mật của khách (N8).
    // Không có bản dịch hợp lệ: gửi bản gốc tiếng Anh (khách phải biết ngay mình vừa lộ ví).
    const alert: UrgentText = await resolver.forUrgent(SECURITY_TEMPLATE_ID, lang, { live: true, fallback: "english", timeoutMs: settings["translation.urgent_timeout_ms"] });
    const alertText = alert.text!;
    await this.send(batch.chatId, alertText, `fp0:${items[0]!.updateId}`);

    if (!isAdmin) {
      const mid = await conv.addMessage({ at: now, episodeId: null, userId: batch.userId, direction: "in", text: REDACTED_LOG_TEXT, language: user.language });
      // Episode bảo mật RIÊNG: không ghi đè vấn đề khách đang được hỗ trợ (vd KYC đang mở vẫn giữ nguyên issue/trạng thái).
      const ep = await conv.openEpisode({ userId: batch.userId, issue: "security-alert-key-leak", topicGroup: "Security" }, now);
      await conv.updateEpisode(ep.id, { issue: "security-alert-key-leak", status: "security_alerted", last_bot_action: "fast/FP-0", last_activity_at: now, closed_at: now });
      await this.linkMessage(mid, ep.id);
      await conv.addMessage({ at: now, episodeId: ep.id, userId: batch.userId, direction: "out", text: alertText, language: alert.lang, tier: 0, templateId: SECURITY_TEMPLATE_ID, latencyMs: Date.now() - started });
      await conv.addEvent({ userId: batch.userId, episodeId: ep.id, type: "security_alert", payload: { pattern, lang: alert.lang, source: alert.source } }, now); // chỉ ghi tên pattern, KHÔNG ghi dữ liệu
      if (alert.source === "fallback") await this.urgentFallback(batch.userId, SECURITY_TEMPLATE_ID, lang, now);
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
    return { status: "ok", replies: [alertText], decisionKind: "SECURITY", templateId: SECURITY_TEMPLATE_ID, tier: 0 };
  }

  // ------------------------------------------------------------------------------------------------------------
  /**
   * `refCode`: mã tham chiếu của vụ việc, điền vào biến {REF} của câu chuyển nhân viên (khách luôn có mã, kể cả khi không có
   * khối tóm tắt). `supportSummary`: khối tóm tắt đã dịch (tin RIÊNG, gửi dạng khối code) — "" khi không có.
   */
  private async buildReply(outcome: Outcome, lang: string, pendingIssue: string | undefined, supportSummary?: (reason: HandoffReason) => Promise<string>, refCode?: string | null): Promise<{ texts: string[]; lang?: string; note?: string; blocked?: string; mode?: string; handoffBlock?: string }> {
    const { resolver } = this.d;
    const escalation = async (templateId: string, reason: HandoffReason, vars: Record<string, string>) => {
      // {SUPPORT_SUMMARY}: chỗ chèn khối trong câu chuyển nhân viên cũ — nay khối là tin riêng nên luôn để trống
      const r = await resolver.forTemplate(templateId, lang, { ...vars, REF: refCode ?? "", SUPPORT_SUMMARY: "" });
      if (r.blocked) return { texts: [], lang, note: r.note, blocked: r.note ?? "không dịch được", mode: r.mode };
      const block = supportSummary ? await supportSummary(reason) : "";
      return { texts: [r.text, ...(block ? [block] : [])], lang: r.lang, note: r.note, mode: r.mode, handoffBlock: block || undefined };
    };
    switch (outcome.kind) {
      case "TEMPLATE": {
        const vars: Record<string, string> = { ISSUE: pendingIssue ?? "" };
        // Template chuyển nhân viên cụ thể (esc-wallet-create...) trỏ answer_from về fp-12-escalate: cùng mã tham chiếu và khối tóm tắt
        if (isEscalationTemplate(this.d.live.index.get(outcome.templateId))) return escalation(outcome.templateId, "other", vars);
        const r = await resolver.forTemplate(outcome.templateId, lang, { ...vars, REF: refCode ?? "" });
        if (r.blocked) return { texts: [], lang, note: r.note, blocked: r.note ?? "không dịch được", mode: r.mode };
        return { texts: [r.text], lang: r.lang, note: r.note, mode: r.mode };
      }
      case "ESCALATE":
        return escalation(ESCALATE_TEMPLATE_ID, handoffReasonOf(outcome.reason), {});
      case "GROUNDED": {
        const r = await resolver.dynamic(outcome.answer, lang, outcome.sourceLang);
        if (r.blocked) return { texts: [], lang, note: r.note, blocked: r.note ?? "không dịch được", mode: r.mode };
        // Câu AI viết (chế độ sinh) được lưu để admin xem/sửa/duyệt ở mục Bản dịch (khoá answer:<hash đoạn nguồn>); bản dịch đoạn thì resolver đã lưu (chunk:<hash>)
        if (outcome.mode === "generative" && outcome.sourceHash) await this.d.kb.saveTranslation(`answer:${outcome.sourceHash}`, r.lang, r.text, outcome.sourceHash, "llm", "pending").catch(() => undefined);
        return { texts: [r.text], lang: r.lang, note: r.note, mode: outcome.mode === "generative" ? "generated" : r.mode };
      }
      case "OFFTOPIC":
        return { texts: [], lang }; // câu cảnh báo do nhánh anti-spam dựng
      case "UNAVAILABLE": {
        // Câu khẩn: chỉ bản dịch sẵn (AI đang mất kết nối hoặc khách hết ngân sách token: không dịch tại chỗ); không có thì câu gốc tiếng Anh
        const r = await resolver.forUrgent(NETWORK_DISCONNECTED_ID, lang, { live: false, fallback: "english" });
        return { texts: [r.text!], lang: r.lang, mode: `urgent_${r.source}`, note: outcome.reason };
      }
      case "CLARIFY": {
        // câu hỏi lại đã được người duyệt viết (tiếng Anh) trong mục hỏi đáp: dịch trung thành như mọi câu đã duyệt
        const r = await this.d.resolver.dynamic(outcome.question, lang, "en");
        if (r.blocked) return { texts: [], lang, note: r.note, blocked: r.note ?? "không dịch được", mode: r.mode };
        return { texts: [r.text], lang: r.lang, note: r.note, mode: r.mode };
      }
    }
  }

  /**
   * Khối "tóm tắt gửi hỗ trợ" (core/handoff.ts): tin RIÊNG gửi sau câu chuyển nhân viên, khách chạm để sao chép và gửi cho
   * @interlink_technicalsupport. Phạm vi = vụ việc của lượt này (EpisodeManager.resolveEpisode, kể cả khi chuyển nhân viên
   * ngay câu đầu). Dựng bằng tiếng Anh, qua `checkOutput` (cấm dự đoán giá / công thức HCS) và SKILL verify-handoff, rồi dịch
   * có kiểm sang ngôn ngữ của khách. Hai bậc:
   *  A. đầy đủ: tóm tắt cuộn (AI viết, cleanSummary đã kiểm) + dòng thời gian (code, nhãn đã duyệt) + giá trị khách nêu;
   *  B. rút gọn khi A không đạt: bỏ các dòng của tóm tắt cuộn, chỉ còn tên vụ việc, dòng thời gian, giá trị do code trích.
   * Không đạt cả hai, dịch 3 lần vẫn không đạt, hoặc không có AI -> không có khối ("", event handoff_block tier "none"):
   * khách vẫn có mã tham chiếu trong câu chuyển nhân viên. Không có bản tiếng Anh dự phòng cho khối này.
   */
  private async buildSupportSummaryVar(ep: EpisodeRow | null, lang: string, reason: HandoffReason, maxSteps: number): Promise<string> {
    if (!ep) return "";
    const llm = usableLlm(this.d.llm);
    const reasons: string[] = [];
    const record = (tier: "A" | "B" | "none") => this.d.conv.addEvent({ userId: ep.user_id, episodeId: ep.id, type: "handoff_block", payload: { tier, lang, reason, reasons } }, this.now()).catch(() => undefined);
    if (!llm) {
      reasons.push("không có AI để kiểm tra và dịch khối");
      await record("none");
      return "";
    }
    const summary = await this.episodes.summarizeNow(llm, ep.id).catch(() => readSummary(ep.summary));
    const { steps, dropped } = await this.episodes.stepsSent(ep.id, maxSteps);
    const events = await this.d.conv.episodeEvents(ep.id);
    const codeFacts = mergeFacts(events.filter((e) => e.type === "customer_fact").map((e) => ((e.payload as { facts?: CustomerFact[] }).facts ?? []))).map((f) => f.replace(/^[a-z_]+=/, ""));
    // Khối viết tiếng Anh rồi dịch: giá trị khách nêu bằng tiếng Việt (vd chữ đọc từ ảnh app tiếng Việt) không được lọt tới khách không dùng tiếng Việt
    const keep = (xs: string[]) => (lang === "vi" ? xs : xs.filter((x) => !looksVietnamese(x) && !/[Ạ-ỹ]/.test(x)));
    const cleanIssue = (s: string | null | undefined) => (s && !looksVietnamese(s) && !hasDiacritics(s) ? s : undefined);

    const tiers: { tier: "A" | "B"; inp: HandoffInput }[] = [
      { tier: "A", inp: { refCode: ep.ref_code, issue: cleanIssue(summary?.issue) ?? cleanIssue(ep.issue) ?? ep.anchor_query_en, summary: summary ? { user_reported: summary.user_reported, unresolved_points: summary.unresolved_points } : undefined, steps, droppedSteps: dropped, facts: keep([...new Set([...(summary?.exact_facts ?? []), ...codeFacts])]).slice(0, 6), reason } },
      { tier: "B", inp: { refCode: ep.ref_code, issue: cleanIssue(ep.issue) ?? ep.anchor_query_en, steps, droppedSteps: dropped, facts: keep(codeFacts).slice(0, 6), reason } },
    ];
    for (const { tier, inp } of tiers) {
      if (!hasHandoffContent(inp)) {
        reasons.push(`${tier}: không có nội dung đáng tóm tắt`);
        continue;
      }
      const body = buildHandoffText(inp);
      const policyChk = checkOutput(body, { urlHostWhitelist: this.d.live.urlHosts, forbidFinancialClaims: true, maxChars: TELEGRAM_MAX_CHARS });
      if (!policyChk.ok) {
        reasons.push(`${tier}: ${policyChk.problems.join("; ")}`);
        continue;
      }
      try {
        const v = await llm.verifyHandoff({ text: body, source: { issue: inp.issue ?? "", userReported: inp.summary?.user_reported ?? "", unresolvedPoints: inp.summary?.unresolved_points ?? "", facts: inp.facts, steps: inp.steps.map(timelineLine) } });
        if (!v.ok) {
          reasons.push(`${tier}: verify-handoff từ chối (${(v.reason ?? "").slice(0, 80)})`);
          continue;
        }
      } catch (e) {
        reasons.push(`${tier}: verify-handoff lỗi (${(e as Error).message.slice(0, 80)})`);
        if (e instanceof LlmUnavailableError && !e.badOutput) break; // mất kết nối: bậc sau cũng không kiểm được
        continue;
      }
      const tr = await this.d.resolver.translateFreeform(body, lang).catch((e: Error) => ({ ok: false as const, note: e.message }));
      if (!tr.ok) {
        reasons.push(`${tier}: dịch không đạt (${tr.note.slice(0, 120)})`);
        break; // bậc B dùng cùng khung câu: dịch lại cũng khó đạt, không tốn thêm lời gọi
      }
      if (tr.text.length > TELEGRAM_MAX_CHARS) {
        reasons.push(`${tier}: bản dịch vượt ${TELEGRAM_MAX_CHARS} ký tự`);
        continue;
      }
      await record(tier);
      return tr.text;
    }
    this.log("warn", "khối tóm tắt chuyển hỗ trợ: không gửi được khối nào", { episodeId: ep.id, reasons });
    await record("none");
    return "";
  }

  /** Tạo hoặc nối tiếp ticket khi chuyển cho người thật. */
  private async escalate(batch: InboundBatch, ep: EpisodeRow | null, outcome: Outcome, tmpl: Template | undefined, last: Template | undefined, topicGroup: string | null, masked: string): Promise<number> {
    const episodeId = ep?.id ?? null;
    const { conv } = this.d;
    const src = outcome.kind === "ESCALATE" && outcome.sourceTemplateId ? this.d.live.index.get(outcome.sourceTemplateId) : undefined;
    const info = tmpl?.ticket ?? src?.ticket ?? last?.ticket ?? {};
    const category = info.category ?? topicGroup ?? src?.group ?? null;
    const requiredInfo = tmpl?.required_info ?? src?.required_info ?? null;
    const reason = outcome.kind === "ESCALATE" ? outcome.reason : `trigger ${tmpl?.id ?? ""}`;
    const open = await conv.openTicketFor(batch.userId, category);
    if (open) {
      await conv.appendTicketNote(open.id, `[${this.now().toISOString()}] khách hỏi lại: ${masked.slice(0, 200)}`, ep?.ref_code);
      await conv.addEvent({ userId: batch.userId, episodeId, type: "ticket_updated", payload: { ticket_id: open.id } }, this.now());
      return open.id;
    }
    const t = await conv.createTicket({ episodeId, userId: batch.userId, category, errorCode: info.error_code ?? null, pic: info.pic ?? null, reason, requiredInfo, sourceTemplateId: src?.id ?? tmpl?.id ?? last?.id ?? null, episodeRefCode: ep?.ref_code ?? null });
    await conv.addEvent({ userId: batch.userId, episodeId, type: "ticket_created", payload: { ticket_id: t.id, error_code: info.error_code ?? null } }, this.now());
    return t.id;
  }

  // ------------------------------------------------------------------------------------------------------------
  /** `refs`: ảnh đã lưu vào MEDIA_DIR (ảnh có seed/key không bao giờ được lưu). */
  private async readImages(batch: InboundBatch, photos: InboundBatch["items"], caption: string, llm: LlmPort | undefined, isAdmin: boolean): Promise<{ vision?: VisionResult; failed?: "unavailable" | "no_vision" | "error"; note?: string; refs: string[] }> {
    const refs: string[] = [];
    if (!photos.length) return { refs };
    if (!llm) return { failed: "no_vision", refs };
    const results: VisionResult[] = [];
    let note: string | undefined;
    for (const p of photos.slice(0, 3)) {
      try {
        const img = await this.d.channel.downloadImage(p.photoFileId!);
        const v = await llm.vision({ mime: img.mime, base64: img.base64, caption: caption || undefined });
        results.push(v);
        if (!v.has_secret && this.d.media && !isAdmin) refs.push(this.d.media.save(img.mime, img.base64));
        else if (v.has_secret) note = "ảnh có seed/key: không lưu";
      } catch (e) {
        if (e instanceof LlmUnavailableError && !e.badOutput) return { failed: "unavailable", refs };
        // từ chối đọc ảnh, đầu ra sai, tải ảnh lỗi...: không đoán nội dung ảnh, chuyển người thật
        return { failed: "error", note: `không đọc được ảnh: ${(e as Error).message.slice(0, 160)}`, refs };
      }
    }
    return { vision: combineVision(results), note, refs };
  }

  /** Gửi "đang soạn" ngay và lặp lại mỗi 4 giây; trả về hàm dừng. */
  private keepTyping(chatId: number): () => void {
    const ping = () => this.d.channel.typing?.(chatId).catch(() => undefined);
    void ping();
    const timer = setInterval(() => void ping(), 4000);
    return () => clearInterval(timer);
  }

  private async send(chatId: number, text: string, dedupeKey: string, entities?: MessageEntity[]): Promise<{ messageId?: number } | undefined> {
    try {
      return await this.d.channel.send(chatId, text, entities ? { entities } : undefined);
    } catch (e) {
      // Telegram lỗi: đưa vào hộp thư đi để worker gửi lại (giữ cả định dạng khối), không mất tin
      this.log("warn", "gửi Telegram lỗi, đưa vào outbox", { err: (e as Error).message });
      await this.d.ops.enqueueOutbox(chatId, text, dedupeKey, entities);
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

/** Nội dung một event gửi cho khách: "T:<template id>" / "K:<chunk id>". */
function sentRefsOf(e: { type: string; payload: Record<string, unknown> }): string[] {
  if (e.type === "template_sent" && e.payload.template_id) return [`T:${String(e.payload.template_id)}`];
  if (e.type === "knowledge_sent" && Array.isArray(e.payload.chunk_ids)) return e.payload.chunk_ids.map((id) => `K:${String(id)}`);
  return [];
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
