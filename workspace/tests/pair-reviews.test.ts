import { describe, expect, it } from "vitest";
import { blockingReviews, UNCHECKED_VERDICT, type PairDecision, type PairReview } from "../src/kb/pair-decisions";

const review = (over: Partial<PairReview>): PairReview => ({ aKey: "item:a", aHash: "a1", aTitle: "A", bKey: "item:b", bHash: "b1", bTitle: "B", verdict: "contradiction", reason: "nói khác nhau", suggestion: null, ...over });
const decision = (over: Partial<PairDecision>): PairDecision => ({ aKey: "item:a", bKey: "item:b", aHash: "a1", bHash: "b1", decision: "keep_both", note: null, decidedBy: "t", decidedAt: new Date(), ...over });
const hashes = (m: Record<string, string>) => (k: string) => m[k];

describe("blockingReviews: nhận xét của AI chặn publish tới khi được xử lý", () => {
  const draft = new Set(["item:a"]);
  it("AI kết luận mâu thuẫn cho đúng nội dung hiện tại, chưa quyết -> chặn, cần người duyệt quyết", () => {
    expect(blockingReviews(draft, [review({})], hashes({ "item:a": "a1", "item:b": "b1" }), [])).toEqual([expect.objectContaining({ need: "decide", verdict: "contradiction" })]);
  });
  it("khác phạm vi / bổ sung -> không chặn", () => {
    expect(blockingReviews(draft, [review({ verdict: "distinct" })], hashes({ "item:a": "a1", "item:b": "b1" }), [])).toEqual([]);
    expect(blockingReviews(draft, [review({ verdict: "complement" })], hashes({ "item:a": "a1", "item:b": "b1" }), [])).toEqual([]);
  });
  it("giữ cả hai / đã sửa gắn với đúng nội dung -> hết chặn; một bên đổi nội dung -> quyết định hết hiệu lực", () => {
    expect(blockingReviews(draft, [review({})], hashes({ "item:a": "a1", "item:b": "b1" }), [decision({})])).toEqual([]);
    expect(blockingReviews(draft, [review({})], hashes({ "item:a": "a2", "item:b": "b1" }), [decision({})])).toEqual([expect.objectContaining({ need: "recheck" })]);
  });
  it("nội dung đổi sau lần AI kiểm tra: chặn, cần AI kiểm tra lại; AI kiểm tra lại thấy hết mâu thuẫn -> hết chặn", () => {
    expect(blockingReviews(draft, [review({})], hashes({ "item:a": "a2", "item:b": "b1" }), [])).toEqual([expect.objectContaining({ need: "recheck" })]);
    expect(blockingReviews(draft, [review({ aHash: "a2", verdict: "distinct" }), review({})], hashes({ "item:a": "a2", "item:b": "b1" }), [])).toEqual([]);
  });
  it("AI không kiểm tra được -> chặn, cần kiểm tra lại", () => {
    expect(blockingReviews(draft, [review({ verdict: UNCHECKED_VERDICT })], hashes({ "item:a": "a1", "item:b": "b1" }), [])).toEqual([expect.objectContaining({ need: "recheck", verdict: UNCHECKED_VERDICT })]);
  });
  it("người duyệt xác nhận nội dung mới thay thế: hết chặn khi nội dung cũ còn đúng như lúc xác nhận", () => {
    const sup = decision({ decision: "supersedes", winnerKey: "item:a", aHash: "chưa publish" });
    expect(blockingReviews(draft, [review({})], hashes({ "item:a": "a1", "item:b": "b1" }), [sup])).toEqual([]);
    expect(blockingReviews(draft, [review({})], hashes({ "item:a": "a1", "item:b": "b2" }), [sup])).toEqual([expect.objectContaining({ need: "recheck" })]);
  });
  it("một bên không còn (đã bỏ) -> không chặn; cặp không thuộc bản nháp -> bỏ qua", () => {
    expect(blockingReviews(draft, [review({})], hashes({ "item:a": "a1" }), [])).toEqual([]);
    expect(blockingReviews(new Set(["item:z"]), [review({})], hashes({ "item:a": "a1", "item:b": "b1" }), [])).toEqual([]);
  });
});
