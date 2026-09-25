/**
 * Quyết định của người duyệt về một cặp nội dung bị phát hiện chồng lấn (bảng kb_pair_decisions, migration 006).
 * Quyết định gắn với NỘI DUNG lúc quyết (hash của cả hai bên): một bên đổi nội dung là quyết định hết hiệu lực và hệ thống
 * hỏi lại — không bao giờ coi một xung đột là "đã xử lý" chỉ vì từng có người bấm đồng ý với một phiên bản khác.
 */
import { sha1 } from "../core/knowledge";
import type { Template } from "../domain/types";

/** supersedes: người duyệt xác nhận nội dung `winnerKey` thay thế bên còn lại (không bao giờ suy ra từ thời điểm nhập). */
export type PairDecisionKind = "distinct" | "keep_both" | "merged" | "fixed" | "supersedes";

export interface PairDecision {
  aKey: string;
  bKey: string;
  aHash: string;
  bHash: string;
  decision: PairDecisionKind;
  note: string | null;
  decidedBy: string;
  decidedAt: Date;
  winnerKey?: string | null;
}

export const itemKey = (itemId: string) => `item:${itemId}`;
export const chunkKey = (docSlug: string, heading: string) => `chunk:${docSlug}#${heading}`;

/** Nội dung của một mục dùng để so khi xét quyết định còn hiệu lực: cách hỏi, cụm nhận biết, câu trả lời gốc. */
export const templateHash = (t: Template) => sha1(JSON.stringify({ q: t.match.examples, p: t.match.keywords, a: t.answers.en ?? "", f: t.answer_from ?? "" }));
export const textHash = (text: string) => sha1(text);

/** Cặp luôn được lưu theo thứ tự khoá tăng dần để (A,B) và (B,A) là một. */
export function orderPair(a: { key: string; hash: string }, b: { key: string; hash: string }) {
  return a.key <= b.key ? { aKey: a.key, aHash: a.hash, bKey: b.key, bHash: b.hash } : { aKey: b.key, aHash: b.hash, bKey: a.key, bHash: a.hash };
}

/** Có quyết định còn hiệu lực cho cặp này không (cả hai bên còn đúng nội dung lúc quyết). */
export function hasValidDecision(decisions: PairDecision[], a: { key: string; hash: string }, b: { key: string; hash: string }): PairDecision | undefined {
  const p = orderPair(a, b);
  return decisions.find((d) => d.aKey === p.aKey && d.bKey === p.bKey && d.aHash === p.aHash && d.bHash === p.bHash);
}

/** Nhận xét của AI (SKILL review-overlap) cho một cặp nội dung, gắn với nội dung hai bên lúc kiểm tra (bảng kb_pair_reviews). */
export interface PairReview {
  aKey: string;
  aHash: string;
  aTitle: string;
  bKey: string;
  bHash: string;
  bTitle: string;
  verdict: string;
  reason: string | null;
  suggestion: string | null;
}

/** Kết luận của AI cần người duyệt quyết trước khi publish */
const BLOCKING_VERDICTS: ReadonlySet<string> = new Set(["duplicate", "conflict", "contradiction", "supersedes"]);
/** Ghi khi AI không kiểm tra được cặp này (mất kết nối, đầu ra hỏng): cặp bị chặn tới khi AI kiểm tra lại được */
export const UNCHECKED_VERDICT = "unchecked";

export interface ReviewBlock {
  aKey: string;
  bKey: string;
  aTitle: string;
  bTitle: string;
  /** "decide": AI đã kết luận cho đúng nội dung hiện tại, cần người duyệt xử lý; "recheck": nội dung đã đổi sau lần AI kiểm tra, cần kiểm tra lại */
  need: "decide" | "recheck";
  verdict: string;
  reason: string | null;
  suggestion: string | null;
}

/**
 * Cặp nào còn chặn publish của các nội dung trong bản nháp (`draftKeys`). Thuần: không đọc DB.
 * `current(key)` = hash hiện tại của một nội dung (bản nháp trước, rồi bản đang chạy); undefined = nội dung đó không còn.
 *  - có nhận xét cho ĐÚNG nội dung hiện tại của hai bên: chặn nếu AI kết luận trùng / xung đột / mâu thuẫn / có thể thay thế mà
 *    chưa có quyết định còn hiệu lực (giữ cả hai, đã sửa, thay thế);
 *  - không có nhận xét cho nội dung hiện tại nhưng từng có kết luận cần quyết (một bên đã đổi sau đó): chặn, cần AI kiểm tra lại.
 */
export function blockingReviews(draftKeys: ReadonlySet<string>, reviews: PairReview[], current: (key: string) => string | undefined, decisions: PairDecision[]): ReviewBlock[] {
  const groups = new Map<string, PairReview[]>();
  for (const r of reviews) {
    if (!draftKeys.has(r.aKey) && !draftKeys.has(r.bKey)) continue;
    const k = `${r.aKey}|${r.bKey}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: ReviewBlock[] = [];
  for (const group of groups.values()) {
    const { aKey, bKey } = group[0]!;
    const hA = current(aKey);
    const hB = current(bKey);
    if (!hA || !hB) continue; // một bên không còn (đã bỏ / đã được thay thế)
    const a = { key: aKey, hash: hA };
    const b = { key: bKey, hash: hB };
    if (hasValidDecision(decisions, a, b) || supersededNow(decisions, a, b)) continue;
    const now = group.find((r) => r.aHash === hA && r.bHash === hB);
    const push = (r: PairReview, need: ReviewBlock["need"]) => out.push({ aKey, bKey, aTitle: r.aTitle, bTitle: r.bTitle, need, verdict: r.verdict, reason: r.reason, suggestion: r.suggestion });
    if (now) {
      if (now.verdict === UNCHECKED_VERDICT) push(now, "recheck");
      else if (BLOCKING_VERDICTS.has(now.verdict)) push(now, "decide");
      continue;
    }
    const old = group.find((r) => BLOCKING_VERDICTS.has(r.verdict) || r.verdict === UNCHECKED_VERDICT);
    if (old) push(old, "recheck");
  }
  return out;
}

/** Người duyệt đã xác nhận một bên thay thế bên kia, và bên bị thay vẫn đúng nội dung lúc xác nhận (bên thắng có thể chưa publish). */
function supersededNow(decisions: PairDecision[], a: { key: string; hash: string }, b: { key: string; hash: string }): boolean {
  const p = orderPair(a, b);
  const d = decisions.find((x) => x.aKey === p.aKey && x.bKey === p.bKey && x.decision === "supersedes");
  if (!d?.winnerKey) return false;
  return d.winnerKey === p.aKey ? d.bHash === p.bHash : d.winnerKey === p.bKey ? d.aHash === p.aHash : false;
}
