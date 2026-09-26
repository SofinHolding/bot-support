/**
 * Khối "tóm tắt gửi hỗ trợ": khi bot chuyển nhân viên, khách nhận thêm MỘT tin riêng (định dạng khối code, chạm để sao chép)
 * để gửi cho @interlink_technicalsupport. Khối chỉ nói về vụ việc hiện tại (episode do EpisodeManager.resolveEpisode xác định,
 * tính từ điểm neo), gồm: mã tham chiếu, vấn đề, điều khách báo, các bước bot đã hướng dẫn KÈM KẾT QUẢ, giá trị khách nêu,
 * điểm còn chưa giải quyết, lý do chuyển.
 *
 * Nguồn từng dòng (huong-dan-memory v3 mục 7.2):
 *  - dòng "Bot guidance" dựng hoàn toàn bằng CODE từ `events` (template_sent / knowledge_sent / step_outcome) và NHÃN ĐÃ DUYỆT
 *    (`stepLabel`: staff_label -> tên mục -> ...), không phải chữ AI viết;
 *  - Issue / Customer reported / Still unresolved lấy từ tóm tắt cuộn (AI viết, `cleanSummary` đã kiểm) — nên khối luôn phải qua
 *    `checkOutput` và SKILL verify-handoff trước khi dịch sang ngôn ngữ của khách (pipeline.ts › buildSupportSummaryVar).
 * Viết bằng tiếng Anh (nội dung gốc), rồi dịch có kiểm như mọi nội dung; không có bản tiếng Anh dự phòng cho khối này.
 */
import type { Template } from "../domain/types";
import { checkOutput } from "./gate";
import { topicKeyOf } from "./items";
import { looksVietnamese } from "./language";
import type { EpisodeSummary } from "./summary";
import { numbersNotIn } from "./translate";

// ---- Lý do chuyển nhân viên -----------------------------------------------------------------------------------------
export type HandoffReason = "no_content" | "steps_exhausted" | "clarify_failed" | "returning_topic" | "media" | "content_conflict" | "other";

/** Câu tiếng Anh của từng lý do: phần của khối tóm tắt, được dịch và kiểm cùng khối. */
export const HANDOFF_REASON_TEXT: Record<HandoffReason, string> = {
  no_content: "the bot has no approved answer for this case",
  steps_exhausted: "the approved steps for this case did not solve it",
  clarify_failed: "the case could not be identified after a clarifying question",
  returning_topic: "this topic was already transferred to support before",
  media: "the bot cannot read this type of attachment",
  content_conflict: "the approved information for this case needs staff review",
  other: "the bot could not resolve this case",
};

/**
 * Mã lý do từ `reason` của outcome ESCALATE (router.ts / pipeline.ts viết lý do cho admin bằng tiếng Việt). Ghi vào
 * decisions.notes.handoff_reason để thống kê. Lý do mới không khớp mẫu nào -> "other" (tests/handoff.test.ts giữ danh sách mẫu).
 */
export function handoffReasonOf(reason: string, followUp?: string | null): HandoffReason {
  const r = reason.toLowerCase();
  if (/quay lại chủ đề/.test(r)) return "returning_topic";
  if (/hỏi lại khách|lượt hỏi lại/.test(r)) return "clarify_failed";
  if (/mâu thuẫn/.test(r)) return "content_conflict";
  if (/ảnh|video|voice|tài liệu\)|tệp/.test(r)) return "media";
  if (followUp || /chưa giải quyết được|follow-up|khách gửi thông tin theo yêu cầu/.test(r)) return "steps_exhausted";
  if (/không tìm được|không có nguồn|không khớp|không có ứng viên|không tìm thấy|mơ hồ|không hiểu|ngoài danh sách|không trả lời đúng/.test(r)) return "no_content";
  return "other";
}

// ---- Nhãn của một bước ----------------------------------------------------------------------------------------------
/**
 * Nhãn đã duyệt mô tả một nội dung bot đã gửi (tiếng Anh, không bao giờ rỗng). Thứ tự: staff_label -> tên mục hỏi đáp ->
 * tên vụ việc -> câu hỏi mẫu đầu -> (đoạn tài liệu) tiêu đề đoạn -> "Approved answer <id>". Nhãn có chữ tiếng Việt bị bỏ qua:
 * nhiều template cũ đặt tên vụ việc / câu mẫu bằng tiếng Việt, còn khối tóm tắt viết tiếng Anh rồi mới dịch.
 */
/** Chữ Latin có dấu (tiếng Việt, Pháp...): nhãn / tên vụ việc trong khối tóm tắt phải là tiếng Anh trơn, vì khối viết tiếng Anh rồi mới dịch. */
export const hasDiacritics = (s: string): boolean => /[À-ɏḀ-ỿ]/.test(s);

export function stepLabel(ref: string, t: Template | undefined, chunkHeading?: string): string {
  const ok = (s: string | undefined): s is string => !!s && !!s.trim() && !hasDiacritics(s) && !looksVietnamese(s);
  if (ref.startsWith("K:")) {
    const leaf = chunkHeading?.split(" › ").pop()?.trim();
    return ok(leaf) ? leaf : `Document section ${ref.slice(2)}`;
  }
  const candidates = [t?.staff_label, t?.item?.title, t?.sets_context.issue, t?.match.examples[0]];
  return (candidates.find(ok) ?? `Approved answer ${ref.slice(2)}`).replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Lỗi của một staff_label (rỗng = đạt). `answerEn`: câu trả lời tiếng Anh của đúng bước đó. */
export function staffLabelProblems(label: string, answerEn: string): string[] {
  const p: string[] = [];
  if (label.length > 90) p.push(`nhãn cho nhân viên dài ${label.length} ký tự: rút gọn còn tối đa 90 ký tự`);
  if (/\n/.test(label)) p.push("nhãn cho nhân viên phải nằm trên một dòng");
  if (looksVietnamese(label) || hasDiacritics(label)) p.push("nhãn cho nhân viên phải viết tiếng Anh (khối tóm tắt viết tiếng Anh rồi mới dịch)");
  if (/https?:\/\/|(?<![\w])@[A-Za-z0-9_]{4,}/.test(label)) p.push("nhãn cho nhân viên không được chứa link hay @handle");
  const extra = numbersNotIn(label, [answerEn]);
  if (extra.length) p.push(`nhãn cho nhân viên có con số không có trong câu trả lời (${extra.join(", ")}): chỉ dùng số có trong câu trả lời`);
  p.push(...checkOutput(label, { urlHostWhitelist: new Set(), forbidFinancialClaims: true }).problems.filter((x) => !/rỗng/.test(x)).map((x) => `nhãn cho nhân viên: ${x}`));
  return p;
}

// ---- Dòng thời gian của vụ việc -------------------------------------------------------------------------------------
export type StepOutcome = "solved" | "not_solved" | "not_received" | "no_old_email" | "info_provided" | "asked_again";

export type TimelineStep =
  | { kind: "answer"; ref: string; label: string; outcome?: StepOutcome }
  | { kind: "clarify"; refs: string[]; chosen?: string | null }
  | { kind: "image"; imageType: string };

const OUTCOME_TEXT: Record<StepOutcome, string> = {
  solved: "solved",
  not_solved: "not solved",
  not_received: "still not received",
  no_old_email: "no access to the old email",
  info_provided: "customer sent the requested information",
  asked_again: "customer asked again",
};
export const outcomeText = (o: StepOutcome | undefined) => (o ? OUTCOME_TEXT[o] : "no feedback");

/**
 * Dòng thời gian từ `events` của MỘT vụ việc (thứ tự thời gian), không gọi LLM. Bỏ nội dung không thuộc vấn đề (lời chào, cảm
 * ơn, tin hệ thống, câu chuyển nhân viên chuẩn); gộp các bước liên tiếp cùng nội dung; giữ `max` bước gần nhất.
 */
export function buildTimeline(
  events: { type: string; payload: Record<string, unknown> }[],
  templateOf: (id: string) => Template | undefined,
  max = 6,
): { steps: TimelineStep[]; dropped: number } {
  const steps: TimelineStep[] = [];
  const lastAnswer = (ref: string) => [...steps].reverse().find((s): s is Extract<TimelineStep, { kind: "answer" }> => s.kind === "answer" && s.ref === ref);
  for (const e of events) {
    const p = e.payload;
    if (e.type === "template_sent" && p.template_id) {
      const id = String(p.template_id);
      const t = templateOf(id);
      if (!topicKeyOf(t)) continue;
      const prev = steps.at(-1);
      if (prev?.kind === "answer" && prev.ref === `T:${id}`) continue;
      steps.push({ kind: "answer", ref: `T:${id}`, label: stepLabel(`T:${id}`, t) });
    } else if (e.type === "knowledge_sent" && Array.isArray(p.chunk_ids) && p.chunk_ids[0] !== undefined) {
      const ref = `K:${String(p.chunk_ids[0])}`;
      const prev = steps.at(-1);
      if (prev?.kind === "answer" && prev.ref === ref) continue;
      const headings = Array.isArray(p.headings) ? p.headings.map(String) : [];
      steps.push({ kind: "answer", ref, label: stepLabel(ref, undefined, headings[0]) });
    } else if (e.type === "step_outcome" && typeof p.ref === "string") {
      const s = lastAnswer(p.ref);
      if (s && !s.outcome) s.outcome = p.outcome as StepOutcome;
    } else if (e.type === "clarify_asked" && Array.isArray(p.refs)) {
      steps.push({ kind: "clarify", refs: p.refs.map(String) });
    } else if (e.type === "clarify_answered") {
      const c = [...steps].reverse().find((s): s is Extract<TimelineStep, { kind: "clarify" }> => s.kind === "clarify");
      if (c && c.chosen === undefined) c.chosen = p.chosen === null || p.chosen === undefined ? null : String(p.chosen);
    } else if (e.type === "image_received" && p.image_type) {
      steps.push({ kind: "image", imageType: String(p.image_type) });
    }
  }
  const dropped = Math.max(0, steps.length - max);
  return { steps: steps.slice(-max), dropped };
}

/** Một dòng của mục "Bot guidance" (tiếng Anh). */
export function timelineLine(s: TimelineStep): string {
  if (s.kind === "answer") return `${s.label} - ${outcomeText(s.outcome)}`;
  if (s.kind === "clarify") return `Asked the customer which case applies (${s.refs.length} options)${s.chosen === null ? " - still unclear" : s.chosen ? " - customer chose one" : ""}`;
  return `Customer sent a screenshot (${s.imageType.replace(/_/g, " ")})`;
}

// ---- Khối tóm tắt ---------------------------------------------------------------------------------------------------
export interface HandoffInput {
  refCode?: string | null;
  /** Vấn đề: tóm tắt cuộn -> tên vụ việc (nhãn đã duyệt) -> câu truy vấn của tin neo */
  issue?: string | null;
  summary?: Pick<EpisodeSummary, "user_reported" | "unresolved_points"> & { exact_facts?: string[] };
  steps: TimelineStep[];
  droppedSteps?: number;
  /** Giá trị khách nêu (tóm tắt cuộn + code trích), đã gộp */
  facts: string[];
  reason: HandoffReason;
}

const HEADER = "Support request (please copy this and send it to @interlink_technicalsupport)";

/** true = có đủ nội dung đáng gửi (không sinh khối chỉ có mã và lý do). */
export function hasHandoffContent(inp: HandoffInput): boolean {
  return !!(inp.issue?.trim() || inp.summary?.user_reported || inp.facts.length || inp.steps.length || inp.summary?.unresolved_points);
}

export function buildHandoffText(inp: HandoffInput): string {
  const lines: string[] = [HEADER];
  if (inp.refCode) lines.push(`Ref: ${inp.refCode}`);
  lines.push(...claimLines(inp));
  lines.push(`Reason for transfer: ${HANDOFF_REASON_TEXT[inp.reason]}`);
  return lines.join("\n");
}

/**
 * Phần NỘI DUNG của khối (vấn đề, điều khách báo, bước đã hướng dẫn, giá trị khách nêu, điểm chưa giải quyết) — đúng phần SKILL
 * verify-handoff đối chiếu với nguồn. Tiêu đề, mã tham chiếu và lý do chuyển là chữ cố định / mã do code thêm, không có trong
 * nguồn nên không đưa cho AI kiểm (kiểm thực tế: AI từ chối cả khối vì "reference / contact không có trong nguồn").
 */
export function buildHandoffClaims(inp: HandoffInput): string {
  return claimLines(inp).join("\n");
}

function claimLines(inp: HandoffInput): string[] {
  const lines: string[] = [];
  if (inp.issue?.trim()) lines.push(`Issue: ${inp.issue.trim()}`);
  if (inp.summary?.user_reported) lines.push(`Customer reported: ${inp.summary.user_reported}`);
  if (inp.steps.length) {
    const head = inp.droppedSteps ? [`  (+${inp.droppedSteps} earlier steps)`] : [];
    lines.push(`Bot guidance already given:\n${[...head, ...inp.steps.map((s, i) => `  ${i + 1}. ${timelineLine(s)}`)].join("\n")}`);
  } // không có bước nào: bỏ hẳn dòng này (một câu khẳng định "chưa gửi gì" không có trong nguồn, verify-handoff từ chối cả khối)
  if (inp.facts.length) lines.push(`Details provided by the customer: ${inp.facts.join(" · ")}`);
  if (inp.summary?.unresolved_points) lines.push(`Still unresolved: ${inp.summary.unresolved_points}`);
  return lines;
}
