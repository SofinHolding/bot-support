/**
 * EpisodeManager: mỗi vấn đề của khách là một episode. Quyết định nối tiếp / tách / mở lại, và dựng gói ngữ cảnh
 * gửi LLM (kích thước gần cố định). Trạng thái nghiệp vụ lấy từ `events` do CODE ghi, không từ tóm tắt của LLM.
 *
 * Một lượt đi qua hai bước:
 *  - `resolveEpisode` ngay sau định tuyến, TRƯỚC khi dựng câu trả lời: chọn / mở / mở lại / chuyển episode, sinh mã tham
 *    chiếu, gắn tin đến và ghi điểm neo. Khối tóm tắt chuyển nhân viên và ticket dùng đúng episode này (kể cả khi chuyển
 *    nhân viên ngay câu đầu).
 *  - `commitEpisode` sau khi gửi: trạng thái, nội dung vừa gửi (`last_ref`, `last_template_id`), mốc hoạt động.
 * Chủ đề so theo khoá chuẩn hoá `topicKeyOf` (core/items.ts), ở mọi tầng; đoạn tài liệu không có khoá (kế thừa vụ việc đang mở).
 */
import type { ContextPack, LlmPort } from "../core/ports";
import type { Settings } from "../core/settings";
import type { Template } from "../domain/types";
import { mergeFacts, type CustomerFact } from "../core/facts";
import { isEscalationTemplate } from "../core/followup";
import { topicKeyOf, topicKeyOfGroup } from "../core/items";
import { buildTimeline, outcomeText, stepLabel, type StepOutcome } from "../core/handoff";
import { cleanSummary, degradedSummary, readSummary, summaryForContext, type EpisodeSummary } from "../core/summary";
import type { ConvRepo, EpisodeRow, EventRow, UserRow } from "../db/repo-conv";

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Không chiếm chỗ trong 8 sự kiện gần nhất của gói ngữ cảnh: customer_fact đi riêng (facts), còn lại là vết nội bộ */
const CONTEXT_HIDDEN_EVENTS = new Set(["customer_fact", "step_outcome", "unanswered_question"]);

export interface LoadedEpisode {
  active: EpisodeRow | null;
  /** Bản ghi `active` sau khi áp dụng open -> dormant (im lặng quá T_gap) */
  gapMs: number;
  pendingIssue?: string;
  /** Khoá chủ đề của vụ việc đã chuyển nhân viên gần đây (khi không có vụ việc đang mở) */
  parentEscalatedGroup?: string;
  recent: EpisodeRow[];
}

export type TurnKind = "TEMPLATE" | "ESCALATE" | "GROUNDED" | "OFFTOPIC" | "SECURITY" | "BLOCKED" | "CLARIFY" | "UNAVAILABLE";

export interface ResolveInput {
  userId: number;
  now: Date;
  settings: Settings;
  active: EpisodeRow | null;
  /** Kết quả định tuyến của lượt (trước khi dựng câu trả lời) */
  kind: TurnKind;
  template?: Template;
  /** Lượt là tin nối tiếp ("vẫn chưa được", "cảm ơn"...): không đổi vụ việc dù nội dung được chọn thuộc chủ đề khác */
  followUp: boolean;
  /** false: lượt này KHÔNG thuộc vấn đề của episode đang mở (vd câu lạ sau thời gian im lặng) => mở episode riêng, giữ nguyên episode cũ. */
  relatedToActive?: boolean;
  /** Mô tả ngắn (đã che dữ liệu) dùng làm issue khi template không mang chủ đề (vd FP-12). */
  issueHint?: string;
  /** Tin đến của lượt (null với admin / tin không lưu): gắn vào episode; là tin neo khi là câu hỏi hoặc mở vụ việc */
  messageId: number | null;
  isQuestion: boolean;
  /** Câu truy vấn tiếng Anh AI viết cho tin này (đã qua kiểm tra): ghi cùng điểm neo */
  queryEn?: string;
}

export interface ResolveResult {
  episode: EpisodeRow | null;
  switchedFrom?: EpisodeRow;
  reopened: boolean;
  opened: boolean;
}

export interface CommitInput {
  now: Date;
  /** Kết quả cuối cùng của lượt (có thể khác lúc định tuyến: vd dịch không đạt -> chuyển nhân viên) */
  kind: TurnKind;
  template?: Template;
  escalateReason?: string;
  /** Nội dung vừa gửi: "T:<id>" (template có chủ đề) | "K:<chunk id>"; không có = giữ nội dung gửi trước đó */
  sentRef?: string;
}

export class EpisodeManager {
  /** `templateOf`: tra template đang chạy theo id (nhãn đã duyệt của bước bot đã gửi trong ngữ cảnh AI và khối tóm tắt) */
  constructor(private readonly conv: ConvRepo, private readonly templateOf: (id: string) => Template | undefined = () => undefined) {}

  async load(userId: number, now: Date, s: Settings): Promise<LoadedEpisode> {
    let active = await this.conv.getActiveEpisode(userId);
    const gapMs = active ? now.getTime() - active.last_activity_at.getTime() : 0;
    if (active && active.status === "open" && gapMs > s["episode.t_gap_minutes"] * 60_000) {
      await this.conv.updateEpisode(active.id, { status: "dormant" });
      active = { ...active, status: "dormant" };
    }
    const recent = await this.conv.recentEpisodes(userId, 5);
    let parentEscalatedGroup: string | undefined;
    if (!active) {
      const since = now.getTime() - s["episode.closed_lookback_days"] * DAY;
      const esc = recent.find((e) => e.status === "escalated" && (e.topic_key || e.topic_group) && e.last_activity_at.getTime() >= since);
      parentEscalatedGroup = esc ? (esc.topic_key ?? topicKeyOfGroup(esc.topic_group)) : undefined;
    }
    const pendingIssue = active?.issue && (active.status === "open" || active.status === "dormant") ? active.issue : undefined;
    return { active, gapMs, pendingIssue, parentEscalatedGroup, recent };
  }

  /** Gói ngữ cảnh cho tầng 2-3: hồ sơ + sự kiện (code ghi) + tóm tắt (LLM viết) + vài lượt gần nhất. */
  async contextPack(user: UserRow, lang: string, loaded: LoadedEpisode, now: Date): Promise<ContextPack> {
    const past = loaded.recent
      .filter((e) => e.id !== loaded.active?.id)
      .slice(0, 3)
      .map((e) => `"${e.issue ?? e.topic_group ?? "?"}" (${e.status}, ${Math.max(0, Math.round((now.getTime() - e.last_activity_at.getTime()) / DAY))}d ago)`);
    const flags = Object.keys(user.flags ?? {}).filter((k) => user.flags[k]);
    const profile = [`language=${lang}`, past.length ? `previous episodes: ${past.join(", ")}` : "", flags.length ? `flags: ${flags.join(",")}` : ""].filter(Boolean).join("; ");

    const a = loaded.active;
    if (!a) return { profile, events: [], recent: [] };
    const all = await this.conv.episodeEvents(a.id);
    // customer_fact đi riêng: không chiếm chỗ của 8 sự kiện gần nhất và không mất khi tin gốc đã được tóm tắt
    // Kết quả của mỗi lần gửi (step_outcome) gộp vào đúng dòng "bot đã gửi", không chiếm một dòng riêng trong 8 sự kiện gần nhất
    const outcomes = new Map<number, StepOutcome>();
    for (const [i, e] of all.entries()) {
      if (e.type !== "step_outcome") continue;
      const ref = String((e.payload as { ref?: unknown }).ref ?? "");
      const sent = all.slice(0, i).map((x, j) => ({ x, j })).filter(({ x }) => sentRefs(x).includes(ref)).pop();
      if (sent && !outcomes.has(sent.j)) outcomes.set(sent.j, (e.payload as { outcome: StepOutcome }).outcome);
    }
    const events = all
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => !CONTEXT_HIDDEN_EVENTS.has(e.type))
      .slice(-8)
      .map(({ e, i }) => fmtEvent(e, now, this.templateOf, outcomes.get(i)));
    const facts = mergeFacts(all.filter((e) => e.type === "customer_fact").map((e) => ((e.payload as { facts?: CustomerFact[] }).facts ?? [])));
    const s = readSummary(a.summary);
    const msgs = await this.conv.messagesAfter(a.id, a.summary_upto_message_id, 6);
    if (loaded.gapMs > 60 * 60_000) events.push(`(the customer was silent for ${Math.round(loaded.gapMs / 3_600_000)} hours before this message)`);
    return { profile, events, facts, summary: s ? summaryForContext(s) : undefined, recent: msgs.map((m) => ({ role: m.direction === "in" ? "user" : "bot", text: (m.text ?? "").slice(0, 400) })) };
  }

  /**
   * Tóm tắt cuộn NGAY (không chờ tới ngưỡng `episode.summary_every_k` của job nền): dùng khi cần bản tóm tắt đáng
   * tin cậy trước khi job nền chạy tới, ví dụ dựng nội dung chuyển người thật cho khách sao chép (core/handoff.ts).
   * Không có tin mới nào chưa tóm tắt -> trả về bản đã lưu (không gọi LLM). LLM lỗi -> bản dự phòng cắt từ tin khách,
   * KHÔNG ném lỗi (khác job `summarize-episode`: nơi đó cố tình ném lại để hạ tầng job retry, còn đường chuyển người
   * thật không được phép làm hỏng lượt trả lời khách vì lý do này).
   */
  async summarizeNow(llm: LlmPort, episodeId: number, maxMessages = 40): Promise<EpisodeSummary | undefined> {
    const ep = await this.conv.getEpisode(episodeId);
    if (!ep) return undefined;
    const prev = readSummary(ep.summary);
    const msgs = await this.conv.messagesAfter(episodeId, ep.summary_upto_message_id, maxMessages);
    if (!msgs.length) return prev;
    const messages = msgs.map((m) => ({ role: m.direction === "in" ? ("user" as const) : ("bot" as const), text: m.text ?? "" }));
    let out;
    try {
      out = await llm.summarize({ previous: prev ? { issue: prev.issue, user_reported: prev.user_reported, unresolved_points: prev.unresolved_points, exact_facts: prev.exact_facts, degraded: prev.degraded } : undefined, messages });
    } catch {
      if (prev?.degraded) return prev; // đã là bản dự phòng: không ghi đè, giữ mốc cũ để job nền tóm tắt lại đúng các tin này
      const d = degradedSummary(prev, messages);
      await this.conv.saveSummary(episodeId, { ...d }, ep.summary_upto_message_id); // không dời mốc: job nền sẽ tóm tắt lại các tin này khi LLM lại dùng được
      return d;
    }
    const { summary } = cleanSummary(out, messages.filter((m) => m.role === "user").map((m) => m.text), prev);
    await this.conv.saveSummary(episodeId, { ...summary }, msgs[msgs.length - 1]!.id);
    return summary;
  }

  /** Các bước bot đã hướng dẫn trong episode này, theo thời gian (code ghi, không LLM) — dùng cho handoff.ts. */
  async stepsSent(episodeId: number, max = 6): Promise<ReturnType<typeof buildTimeline>> {
    return buildTimeline(await this.conv.episodeEvents(episodeId), this.templateOf, max);
  }

  /** Các nội dung đã gửi khách trong vụ việc: "T:<template id>" và "K:<chunk id>" (để khi khách báo chưa giải quyết được thì không gửi lại). */
  async answersSent(episodeId: number): Promise<string[]> {
    const events = await this.conv.episodeEvents(episodeId);
    const out: string[] = [];
    for (const e of events) {
      const p = e.payload as { template_id?: unknown; chunk_ids?: unknown };
      if (e.type === "template_sent" && p.template_id) out.push(`T:${String(p.template_id)}`);
      if (e.type === "knowledge_sent" && Array.isArray(p.chunk_ids)) out.push(...p.chunk_ids.map((id) => `K:${String(id)}`));
    }
    return [...new Set(out)];
  }

  /**
   * Ngay sau định tuyến, trước khi dựng câu trả lời: episode của lượt này.
   *  - Nội dung được chọn thuộc chủ đề KHÁC vụ việc đang mở (và không phải tin nối tiếp, không phải chuyển nhân viên)
   *    -> vụ việc cũ tạm lắng; mở lại vụ việc tạm lắng cùng chủ đề (trong `episode.reopen_window_hours`) hoặc mở vụ việc mới.
   *  - Chuyển nhân viên cho câu KHÔNG thuộc vụ việc đang mở -> vụ việc riêng, giữ nguyên vụ việc cũ.
   *  - Chưa có vụ việc: chỉ mở khi lượt "mở vụ việc" (chuyển nhân viên, câu trả lời có trạng thái pending/resolved, trả lời
   *    từ tài liệu, hỏi lại). Vụ việc mới nhận luôn các tin khách gửi lúc mất kết nối AI ngay trước đó.
   * Giới hạn: chủ đề chỉ biết SAU định tuyến, nên ở lượt đổi / quay lại vụ việc, AI đã dùng ngữ cảnh của vụ việc trước.
   */
  async resolveEpisode(inp: ResolveInput): Promise<ResolveResult> {
    const t = inp.template;
    const key = topicKeyOf(t);
    const s = inp.settings;
    const escalating = inp.kind === "ESCALATE" || isEscalationTemplate(t);
    const directive = escalating ? "escalated" : t?.sets_context.status ?? (inp.kind === "GROUNDED" || inp.kind === "CLARIFY" ? "pending" : "none");
    const issue = key ? t?.sets_context.issue : undefined; // chỉ template có chủ đề mới đặt/đổi issue: FP-12, chào, cảm ơn không xoá vấn đề gốc
    const opensCase = escalating || directive === "pending" || directive === "resolved";

    let active = inp.active;
    let switchedFrom: EpisodeRow | undefined;
    let reopened = false;
    let opened = false;

    // Khách chuyển chủ đề: đóng tạm vụ việc cũ, KHÔNG nạp ngữ cảnh cũ sang vụ việc mới
    const activeKey = active ? (active.topic_key ?? topicKeyOfGroup(active.topic_group)) : undefined;
    if (active && key && activeKey && key !== activeKey && !inp.followUp && !escalating) {
      await this.conv.updateEpisode(active.id, { status: "dormant" });
      switchedFrom = active;
      active = null;
    }

    // Chuyển người thật cho một câu KHÔNG thuộc vấn đề đang mở: không đóng/ghi đè episode đó
    // (nếu không, chủ đề cũ bị coi là "đã escalate" và mọi câu hỏi sau về chủ đề đó đều bị ép chuyển support).
    if (active && escalating && inp.relatedToActive === false) active = null;

    // Khách quay lại vấn đề cũ cùng chủ đề: mở lại vụ việc tạm lắng thay vì tạo mới
    if (!active && key) {
      const since = new Date(inp.now.getTime() - s["episode.reopen_window_hours"] * HOUR);
      const dormant = await this.conv.getDormantEpisodeByTopic(inp.userId, key, since, switchedFrom?.id ?? null);
      if (dormant) active = dormant;
    }

    if (!active) {
      if (!opensCase) return { episode: null, switchedFrom, reopened, opened };
      const since = new Date(inp.now.getTime() - s["episode.closed_lookback_days"] * DAY);
      const parent = key ? await this.conv.getRecentClosedEpisode(inp.userId, key, since) : null;
      active = await this.conv.openEpisode({ userId: inp.userId, parentId: parent?.id ?? null, issue: issue ?? inp.issueHint ?? t?.sets_context.issue ?? null, topicGroup: key ? t!.group : null, topicKey: key ?? null }, inp.now);
      opened = true;
      // Câu hỏi khách gửi lúc mất kết nối AI ngay trước đó: thuộc vụ việc này, và là điểm bắt đầu của vấn đề
      for (const mid of await this.conv.unansweredMessages(inp.userId, new Date(inp.now.getTime() - s["episode.t_gap_minutes"] * 60_000))) {
        await this.conv.linkMessage(mid, active.id);
        await this.conv.setAnchor(active.id, mid, null);
      }
    } else if (active.status === "dormant") {
      reopened = true;
    }

    const patch: Parameters<ConvRepo["updateEpisode"]>[1] = {};
    if (issue && !opened) patch.issue = issue;
    if (key && !active.topic_key) patch.topic_key = key;
    if (key && !active.topic_group) patch.topic_group = t!.group;
    if (Object.keys(patch).length) await this.conv.updateEpisode(active.id, patch);

    if (inp.messageId) {
      await this.conv.linkMessage(inp.messageId, active.id);
      if (inp.isQuestion || opened) await this.conv.setAnchor(active.id, inp.messageId, inp.queryEn?.slice(0, 200) ?? null);
    }
    return { episode: (await this.conv.getEpisode(active.id))!, switchedFrom, reopened, opened };
  }

  /** Sau khi gửi: trạng thái vụ việc theo kết quả CUỐI của lượt, và nội dung vừa gửi. */
  async commitEpisode(episode: EpisodeRow, inp: CommitInput): Promise<EpisodeRow> {
    const t = inp.template;
    const escalating = inp.kind === "ESCALATE" || isEscalationTemplate(t);
    const directive = escalating ? "escalated" : t?.sets_context.status ?? (inp.kind === "GROUNDED" || inp.kind === "CLARIFY" ? "pending" : "none");
    const patch: Parameters<ConvRepo["updateEpisode"]>[1] = { last_activity_at: inp.now };
    if (t) {
      patch.last_template_id = t.id;
      patch.last_bot_action = `${inp.kind}:${t.id}`;
    } else patch.last_bot_action = inp.kind + (inp.escalateReason ? `:${inp.escalateReason.slice(0, 80)}` : "");
    // Câu trả lời từ tài liệu: tin nối tiếp sau đó KHÔNG được xử lý theo luật nối tiếp của một template gửi trước đó
    if (inp.kind === "GROUNDED") patch.last_template_id = null;
    if (inp.sentRef) patch.last_ref = inp.sentRef;
    if (directive === "escalated") {
      patch.status = "escalated";
      patch.closed_at = inp.now;
    } else if (directive === "resolved") {
      patch.status = "resolved";
      patch.closed_at = inp.now;
    } else {
      patch.status = "open";
      patch.closed_at = null;
    }
    await this.conv.updateEpisode(episode.id, patch);
    return (await this.conv.getEpisode(episode.id))!;
  }
}

/** Nội dung một event gửi cho khách: "T:<template id>" / "K:<chunk id>". */
function sentRefs(e: EventRow): string[] {
  const p = e.payload as Record<string, unknown>;
  if (e.type === "template_sent" && p.template_id) return [`T:${String(p.template_id)}`];
  if (e.type === "knowledge_sent" && Array.isArray(p.chunk_ids)) return p.chunk_ids.map((id) => `K:${String(id)}`);
  return [];
}

function fmtEvent(e: EventRow, now: Date, templateOf: (id: string) => Template | undefined, outcome?: StepOutcome): string {
  const ago = Math.max(0, Math.round((now.getTime() - e.at.getTime()) / 60_000));
  const p = e.payload as Record<string, unknown>;
  const result = outcome ? ` -> customer: ${outcomeText(outcome)}` : "";
  switch (e.type) {
    case "template_sent": {
      const id = String(p.template_id);
      return `bot sent "${stepLabel(`T:${id}`, templateOf(id))}" (${id})${result} (${ago} min ago)`;
    }
    case "knowledge_sent": {
      const ref = `K:${String((p.chunk_ids as unknown[] | undefined)?.[0] ?? "")}`;
      return `bot sent the document section "${stepLabel(ref, undefined, (p.headings as string[] | undefined)?.[0])}"${result} (${ago} min ago)`;
    }
    case "image_received":
      return `customer sent an image of type ${String(p.image_type)}${p.error_text ? ` showing the text "${String(p.error_text)}"` : ""} (${ago} min ago)`;
    case "ticket_created":
      return `a support ticket was created (${ago} min ago)`;
    default:
      return `${e.type} (${ago} min ago)`;
  }
}
