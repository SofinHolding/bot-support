/**
 * EpisodeManager: mỗi vấn đề của khách là một episode. Quyết định nối tiếp / tách / mở lại, và dựng gói ngữ cảnh
 * gửi LLM (kích thước gần cố định). Trạng thái nghiệp vụ lấy từ `events` do CODE ghi, không từ tóm tắt của LLM.
 */
import type { ContextPack, LlmPort } from "../core/ports";
import type { Settings } from "../core/settings";
import type { Template } from "../domain/types";
import { mergeFacts, type CustomerFact } from "../core/facts";
import { isEscalationTemplate } from "../core/followup";
import { cleanSummary, degradedSummary, readSummary, summaryForContext, type EpisodeSummary } from "../core/summary";
import type { ConvRepo, EpisodeRow, EventRow, UserRow } from "../db/repo-conv";

const NON_TOPIC_GROUPS = new Set(["Greeting", "FollowUp", "System", "Image", "Security", "AntiSpam", "Escalate"]);
const DAY = 86_400_000;

export interface LoadedEpisode {
  active: EpisodeRow | null;
  /** Bản ghi `active` sau khi áp dụng open -> dormant (im lặng quá T_gap) */
  gapMs: number;
  pendingIssue?: string;
  parentEscalatedGroup?: string;
  recent: EpisodeRow[];
}

export type TurnKind = "TEMPLATE" | "ESCALATE" | "GROUNDED" | "OFFTOPIC" | "SECURITY" | "BLOCKED" | "CLARIFY";

export interface FinalizeInput {
  userId: number;
  now: Date;
  active: EpisodeRow | null;
  kind: TurnKind;
  template?: Template;
  /** tier của quyết định: chỉ tin chuyển chủ đề khi khớp chắc chắn (tầng 0-1) */
  tier: number;
  escalateReason?: string;
  /** false: lượt này KHÔNG thuộc vấn đề của episode đang mở (vd câu lạ sau thời gian im lặng) => mở episode riêng, giữ nguyên episode cũ. */
  relatedToActive?: boolean;
  /** Mô tả ngắn (đã che dữ liệu) dùng làm issue khi template không mang chủ đề (vd FP-12). */
  issueHint?: string;
}

export interface FinalizeResult {
  episode: EpisodeRow | null;
  switchedFrom?: EpisodeRow;
  reopened: boolean;
}

export class EpisodeManager {
  constructor(private readonly conv: ConvRepo) {}

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
      const esc = recent.find((e) => e.status === "escalated" && e.topic_group && e.last_activity_at.getTime() >= since);
      parentEscalatedGroup = esc?.topic_group ?? undefined;
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
    const events = all.filter((e) => e.type !== "customer_fact").slice(-8).map((e) => fmtEvent(e, now));
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
  async stepsSent(episodeId: number): Promise<string[]> {
    const events = await this.conv.episodeEvents(episodeId);
    return events.filter((e) => e.type === "template_sent").map((e) => String((e.payload as { template_id?: unknown }).template_id ?? "")).filter(Boolean);
  }

  /** Sau khi định tuyến: chọn / tạo / cập nhật episode cho lượt này. */
  async finalize(inp: FinalizeInput): Promise<FinalizeResult> {
    const t = inp.template;
    const group = t && !NON_TOPIC_GROUPS.has(t.group) ? t.group : undefined;
    const escalating = inp.kind === "ESCALATE" || isEscalationTemplate(t);
    const directive = escalating ? "escalated" : t?.sets_context.status ?? (inp.kind === "GROUNDED" || inp.kind === "CLARIFY" ? "pending" : "none");
    const issue = group ? t?.sets_context.issue : undefined; // chỉ template có chủ đề mới đặt/đổi issue: FP-12, chào, cảm ơn không xoá vấn đề gốc
    const opensCase = escalating || directive === "pending" || directive === "resolved";

    let active = inp.active;
    let switchedFrom: EpisodeRow | undefined;
    let reopened = false;

    // Khách chuyển chủ đề (khớp chắc chắn ở nhóm khác) -> đóng ngữ cảnh cũ, KHÔNG nạp sang episode mới
    if (active && group && active.topic_group && group !== active.topic_group && inp.tier <= 1 && inp.kind === "TEMPLATE" && !escalating) {
      await this.conv.updateEpisode(active.id, { status: "dormant" });
      switchedFrom = active;
      active = null;
    }

    // Chuyển người thật cho một câu KHÔNG thuộc vấn đề đang mở: không đóng/ghi đè episode đó
    // (nếu không, chủ đề cũ bị coi là "đã escalate" và mọi câu hỏi sau về chủ đề đó đều bị ép chuyển support).
    if (active && escalating && inp.relatedToActive === false) active = null;

    if (!active) {
      if (!opensCase) return { episode: null, switchedFrom, reopened };
      const since = new Date(inp.now.getTime() - 30 * DAY);
      const parent = group ? await this.conv.getRecentClosedEpisode(inp.userId, group, since) : null;
      const ep = await this.conv.openEpisode({ userId: inp.userId, parentId: parent?.id ?? null, issue: issue ?? inp.issueHint ?? t?.sets_context.issue ?? null, topicGroup: group ?? null }, inp.now);
      active = ep;
    } else if (active.status === "dormant") {
      reopened = true;
    }

    const patch: Parameters<ConvRepo["updateEpisode"]>[1] = { last_activity_at: inp.now };
    if (issue) patch.issue = issue;
    if (group && !active.topic_group) patch.topic_group = group;
    if (t) {
      patch.last_template_id = t.id;
      patch.last_bot_action = `${inp.kind}:${t.id}`;
    } else patch.last_bot_action = inp.kind + (inp.escalateReason ? `:${inp.escalateReason.slice(0, 80)}` : "");
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
    await this.conv.updateEpisode(active.id, patch);
    const fresh = (await this.conv.getEpisode(active.id))!;
    return { episode: fresh, switchedFrom, reopened };
  }
}

function fmtEvent(e: EventRow, now: Date): string {
  const ago = Math.max(0, Math.round((now.getTime() - e.at.getTime()) / 60_000));
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "template_sent":
      return `bot sent template ${String(p.template_id)} (${ago} min ago)`;
    case "image_received":
      return `customer sent an image of type ${String(p.image_type)}${p.error_text ? ` showing the text "${String(p.error_text)}"` : ""} (${ago} min ago)`;
    case "ticket_created":
      return `a support ticket was created (${ago} min ago)`;
    default:
      return `${e.type} (${ago} min ago)`;
  }
}
