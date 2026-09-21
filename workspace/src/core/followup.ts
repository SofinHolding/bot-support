/**
 * Nhận diện tin nhắn follow-up (AGENTS.md > Follow-up detection). Bằng code, không tốn token.
 * Chỉ áp dụng cho tin NGẮN; tin dài luôn đi qua router như một câu hỏi mới.
 */
import type { Template, VisionScreenType } from "../domain/types";
import { ESCALATE_TEMPLATE_ID, THANKS_TEMPLATE_ID } from "../domain/types";
import { makeInput, type Evaluator } from "./predicates";
import { wordCount } from "./text";

export type FollowUpKind = "thanks" | "negative" | "more_images" | "not_receive" | "no_old_email" | "info_provided";

export const FOLLOW_UP_MAX_WORDS = 8;

const THANKS_FILLER = new Set(["you", "a", "lot", "so", "much", "very", "bot", "bro", "anh", "chi", "ban", "nhe", "nha", "a", "again", "all", "the", "help"]);

/** Các loại follow-up MẠNH: đủ tin cậy để xử lý trước cả khi khớp từ khoá. */
export function detectStrongFollowUp(
  inp: { text: string; norm: string; hasImage: boolean; imageType?: VisionScreenType },
  evaluator: Evaluator,
  last: Template | undefined,
): FollowUpKind | null {
  const ev = makeInput(inp.text, { imageType: inp.imageType, lastTemplateId: last?.id });
  ev.norm = inp.norm;
  if (evaluator.test("topic_change", ev)) return null;

  // Khách gửi thêm ảnh cùng loại với case đang xử lý, không kèm câu hỏi mới.
  if (last && inp.hasImage && inp.imageType && last.match.image_types.includes(inp.imageType) && wordCount(inp.norm) <= FOLLOW_UP_MAX_WORDS) {
    return "more_images";
  }
  if (inp.hasImage || wordCount(inp.norm) > FOLLOW_UP_MAX_WORDS || !inp.norm) return null;

  if (last && evaluator.test("no_old_email", ev)) return "no_old_email";
  if (last && evaluator.test("is_not_receive", ev)) return "not_receive";
  if (evaluator.test("is_thanks", ev) && isOnlyThanks(inp.norm)) return "thanks";
  if (last && evaluator.test("is_negative", ev)) return "negative";
  return null;
}

/** "thanks", "okay thank you", "ok cảm ơn": toàn bộ tin nhắn chỉ là lời cảm ơn (không kèm câu hỏi). */
function isOnlyThanks(norm: string): boolean {
  const stripped = norm
    .replace(/\b(thanks|thank|thx|ty|got it|okay|oke|ok|cam on|cảm ơn|cám ơn)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return true;
  return stripped.split(" ").every((w) => THANKS_FILLER.has(w));
}

/** Mục tiêu của follow-up: id template, "ESCALATE", hoặc null nếu không có luật (rơi về router). */
export function resolveFollowUp(kind: FollowUpKind, last: Template | undefined): string | null {
  const own = last?.follow_up[kind];
  if (own) return own;
  switch (kind) {
    case "thanks":
      return THANKS_TEMPLATE_ID;
    case "negative": // AGENTS.md: "Không có rule → ESCALATE"
    case "not_receive":
      return "ESCALATE";
    default:
      return null;
  }
}

export const isEscalationTemplate = (t: Template | undefined): boolean =>
  !!t && (t.id === ESCALATE_TEMPLATE_ID || t.answer_from === ESCALATE_TEMPLATE_ID);
