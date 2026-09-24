/**
 * Quyết định của người duyệt về một cặp nội dung bị phát hiện chồng lấn (bảng kb_pair_decisions, migration 006).
 * Quyết định gắn với NỘI DUNG lúc quyết (hash của cả hai bên): một bên đổi nội dung là quyết định hết hiệu lực và hệ thống
 * hỏi lại — không bao giờ coi một xung đột là "đã xử lý" chỉ vì từng có người bấm đồng ý với một phiên bản khác.
 */
import { sha1 } from "../core/knowledge";
import type { Template } from "../domain/types";

export type PairDecisionKind = "distinct" | "keep_both" | "merged" | "fixed";

export interface PairDecision {
  aKey: string;
  bKey: string;
  aHash: string;
  bHash: string;
  decision: PairDecisionKind;
  note: string | null;
  decidedBy: string;
  decidedAt: Date;
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
