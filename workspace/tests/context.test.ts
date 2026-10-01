/**
 * Hai lớp giữ mạch hội thoại: (1) ngữ cảnh nạp lại = sự kiện + giá trị do code trích + tóm tắt + vài tin mới nhất,
 * (2) quy tắc tóm tắt cuộn có code kiểm chứng. (Việc làm câu hỏi tiếp nối đứng độc lập để tìm tri thức nay nằm trong
 * `understand()` của routeLlmFirst — SKILL translate-query độc lập cũ đã bỏ 2026-09-30, xem tests/core.test.ts.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractFacts, mergeFacts } from "../src/core/facts";
import type { LlmPort, UnderstandRequest } from "../src/core/ports";
import { cleanSummary, degradedSummary, readSummary, summaryForContext, SUMMARY_LIMITS } from "../src/core/summary";
import { HANDLERS, type JobContext } from "../src/worker/jobs";
import { fakeLlm, makeWorld, type World } from "./helpers";

describe("core/facts: giá trị khách nêu do code trích", () => {
  it("mã lỗi, phiên bản, thiết bị, số lượng, ngày, khoảng thời gian", () => {
    const f = extractFacts("App version 2.3.1 on Android 14 shows error code 504 when I swap 1,250.5 ITLG since 12/09/2026, waiting 3 days");
    expect(f).toEqual(expect.arrayContaining([
      { kind: "error_code", value: "504" },
      { kind: "app_version", value: "2.3.1" },
      { kind: "device", value: "Android 14" },
      { kind: "amount", value: "1,250.5 ITLG" },
      { kind: "date", value: "12/09/2026" },
      { kind: "duration", value: "3 days" },
    ]));
  });
  it("tiếng Việt; không nhận mã xác minh (OTP) và số đã bị che", () => {
    expect(extractFacts("bị lỗi 403 đã chờ 2 giờ, phiên bản 1.8")).toEqual(expect.arrayContaining([
      { kind: "error_code", value: "403" },
      { kind: "duration", value: "2 giờ" },
      { kind: "app_version", value: "1.8" },
    ]));
    expect(extractFacts("my verification code 482913 and my id is [NUMBER]")).toEqual([]);
    expect(extractFacts("how do I withdraw?")).toEqual([]);
  });
  it("gộp nhiều lượt: bỏ trùng, giá trị nhắc lại gần nhất đứng sau", () => {
    expect(mergeFacts([[{ kind: "error_code", value: "504" }], [{ kind: "app_version", value: "2.3.1" }], [{ kind: "error_code", value: "504" }]])).toEqual(["app_version=2.3.1", "error_code=504"]);
  });
});

describe("core/summary: quy tắc tóm tắt có code kiểm chứng", () => {
  const sources = ["I get Network timeout 504 when swapping 100 ITLG on app version 2.3.1", "please help"];
  it("giữ giá trị có trong tin nhắn, BỎ giá trị LLM tự thêm", () => {
    const { summary, droppedFacts } = cleanSummary(
      { issue: "swap fails", user_reported: "swap fails with a timeout", unresolved_points: "cause unknown", exact_facts: ["error: Network timeout 504", "amount: 100 ITLG", "amount: 250 ITLG", "app version 9.9.9", "error: Network timeout 504"] },
      sources,
    );
    expect(summary.exact_facts).toEqual(["error: Network timeout 504", "amount: 100 ITLG"]);
    expect(droppedFacts).toEqual(["amount: 250 ITLG", "app version 9.9.9"]);
  });
  it("giá trị của bản tóm tắt trước vẫn được giữ khi tin gốc không còn trong lô đang tóm tắt", () => {
    const prev = readSummary({ issue: "i", user_reported: "u", unresolved_points: "p", exact_facts: ["error: Network timeout 504"] })!;
    const { summary } = cleanSummary({ issue: "i", user_reported: "u", unresolved_points: "p", exact_facts: ["error: Network timeout 504"] }, ["still not working"], prev);
    expect(summary.exact_facts).toEqual(["error: Network timeout 504"]);
  });
  it("che dữ liệu nhạy cảm và cắt theo giới hạn cứng: tóm tắt không phình", () => {
    const { summary } = cleanSummary({ issue: "x".repeat(900), user_reported: `mail a.b@example.com id 1234567890 ${"y".repeat(900)}`, unresolved_points: "z".repeat(900), exact_facts: Array.from({ length: 20 }, (_, i) => `please help ${i}`) }, ["please help"]);
    expect(summary.issue.length).toBe(SUMMARY_LIMITS.issue);
    expect(summary.user_reported.length).toBe(SUMMARY_LIMITS.userReported);
    expect(summary.user_reported).toContain("[EMAIL]");
    expect(summary.user_reported).not.toContain("1234567890");
    expect(summary.unresolved_points.length).toBe(SUMMARY_LIMITS.unresolved);
    expect(summary.exact_facts.length).toBeLessThanOrEqual(SUMMARY_LIMITS.facts);
  });
  it("LLM lỗi: bản dự phòng chỉ gồm lời khách (mới nhất được ưu tiên), giữ phần đã có, đánh dấu degraded", () => {
    const prev = readSummary({ issue: "swap fails", user_reported: "timeout on swap", unresolved_points: "cause", exact_facts: ["error 504"] })!;
    const d = degradedSummary(prev, [{ role: "user", text: "now it says error 500" }, { role: "bot", text: "template text" }, { role: "user", text: "my mail is a@b.co" }]);
    expect(d).toMatchObject({ issue: "swap fails", degraded: true, exact_facts: ["error 504"] });
    expect(d.user_reported).toBe("timeout on swap | now it says error 500 | my mail is [EMAIL]");
    expect(d.user_reported).not.toContain("template text");
    expect(summaryForContext(d)).toContain("raw fallback");
    const long = degradedSummary(undefined, Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, text: `message number ${i} ${"w".repeat(60)}` })));
    expect(long.user_reported.length).toBeLessThanOrEqual(SUMMARY_LIMITS.userReported);
    expect(long.user_reported).toContain("message number 29");
  });
});

describe("pipeline + worker: ngữ cảnh không mất khi tin cũ rời cửa sổ", () => {
  let w: World;
  let ctx: JobContext;
  let understandSeen: UnderstandRequest[] = [];
  let summarize: LlmPort["summarize"];
  const U = 4242;

  beforeAll(async () => {
    // AI hiểu (nhận ngữ cảnh nạp lại) -> câu truy vấn luôn dẫn tới fp-2-withdraw -> AI chọn fp-2-withdraw: vụ việc "pending" luôn mở qua các lượt
    const llm: LlmPort = {
      ...fakeLlm(),
      understand: async (req) => { understandSeen.push(req); return { language: "en", intent: "question", follow_up: "none", query_en: `${req.text} withdraw`, query_kb: `${req.text} withdraw` }; },
      select: async (req) => ({ ref: req.candidates.some((c) => c.ref === "T:fp-2-withdraw") ? "T:fp-2-withdraw" : "ESCALATE", reason: "" }),
      summarize: (r) => summarize(r),
    };
    w = await makeWorld({ llm });
    ctx = {
      db: w.db, conv: w.conv, kb: w.kb, ops: w.ops, settings: w.settings, kbService: w.kbService, channel: w.channel, llm,
      ownerId: 9001, adminWebUrl: "https://admin.example.test", now: () => w.clock.now, fetchImpl: fetch, log: () => undefined,
    };
  });
  afterAll(() => w.close());

  it("giá trị khách nêu được ghi thành sự kiện và có mặt trong ngữ cảnh của lượt sau, tách khỏi 8 sự kiện gần nhất", async () => {
    await w.say(U, "I cannot withdraw, the app shows error code 504 on app version 2.3.1"); // fp-2-withdraw: episode "pending", còn mở
    const ep = (await w.conv.getActiveEpisode(U))!;
    const facts = (await w.conv.episodeEvents(ep.id)).filter((e) => e.type === "customer_fact");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.payload).toEqual({ facts: [{ kind: "error_code", value: "504" }, { kind: "app_version", value: "2.3.1" }] });

    understandSeen = [];
    for (let i = 0; i < 5; i++) {
      w.clock.advance(60_000);
      await w.say(U, `another strange zebra statement number ${i}`);
    }
    expect(understandSeen).toHaveLength(5);
    expect((await w.conv.getActiveEpisode(U))!.id).toBe(ep.id); // vẫn cùng vụ việc
    const last = understandSeen[understandSeen.length - 1]!;
    expect(last.context!.facts).toEqual(["error_code=504", "app_version=2.3.1"]);
    expect(last.context!.events.join("\n")).not.toContain("customer_fact");
  });

  it("tóm tắt: cập nhật tại chỗ từ bản trước, bỏ giá trị bịa, dời mốc; lượt sau chỉ nạp tóm tắt + tin sau mốc", async () => {
    const ep = (await w.conv.recentEpisodes(U, 1))[0]!;
    let got: Parameters<LlmPort["summarize"]>[0] | undefined;
    summarize = async (r) => { got = r; return { issue: "dashboard error", user_reported: "dashboard shows an error", unresolved_points: "cause unknown", exact_facts: ["error code 504", "app version 7.7.7"] }; };
    const res = (await HANDLERS["summarize-episode"]!(ctx, { episodeId: ep.id })) as { upTo: number; droppedFacts: string[] };
    expect(got!.previous).toBeUndefined();
    expect(res.droppedFacts).toEqual(["app version 7.7.7"]);
    const saved = (await w.conv.getEpisode(ep.id))!;
    expect(readSummary(saved.summary)).toMatchObject({ issue: "dashboard error", exact_facts: ["error code 504"] });
    expect(saved.summary_upto_message_id).toBe(res.upTo);

    understandSeen = [];
    w.clock.advance(60_000);
    await w.say(U, "one more strange zebra statement");
    const c = understandSeen[0]!.context!;
    expect(c.summary).toContain("exact values stated by the customer: error code 504");
    expect(c.recent.every((m) => !m.text.includes("error code 504"))).toBe(true); // tin gốc đã nằm sau mốc tóm tắt
    expect(c.facts).toContain("error_code=504"); // nhưng giá trị do code trích vẫn còn

    summarize = async (r) => { got = r; return { issue: "dashboard error", user_reported: "still failing", unresolved_points: "", exact_facts: ["error code 504"] }; };
    await HANDLERS["summarize-episode"]!(ctx, { episodeId: ep.id });
    expect(got!.previous).toMatchObject({ issue: "dashboard error", exact_facts: ["error code 504"] });
    expect(readSummary((await w.conv.getEpisode(ep.id))!.summary)!.exact_facts).toEqual(["error code 504"]);
  });

  it("LLM tóm tắt lỗi: lưu bản dự phòng, KHÔNG dời mốc, job vẫn báo lỗi để được chạy lại; lần sau viết lại bản sạch", async () => {
    const ep = (await w.conv.recentEpisodes(U, 1))[0]!;
    w.clock.advance(60_000);
    await w.say(U, "now the zebra dashboard says error 500");
    const before = (await w.conv.getEpisode(ep.id))!;
    summarize = async () => { throw new Error("bad json"); };
    await expect(HANDLERS["summarize-episode"]!(ctx, { episodeId: ep.id })).rejects.toThrow("bad json");
    const after = (await w.conv.getEpisode(ep.id))!;
    expect(after.summary_upto_message_id).toBe(before.summary_upto_message_id);
    const d = readSummary(after.summary)!;
    expect(d.degraded).toBe(true);
    expect(d.user_reported).toContain("error 500");
    expect(d.exact_facts).toEqual(["error code 504"]);

    let got: Parameters<LlmPort["summarize"]>[0] | undefined;
    summarize = async (r) => { got = r; return { issue: "dashboard error", user_reported: "error changed from 504 to 500", unresolved_points: "", exact_facts: ["error 500"] }; };
    await HANDLERS["summarize-episode"]!(ctx, { episodeId: ep.id });
    expect(got!.previous?.degraded).toBe(true);
    const clean = readSummary((await w.conv.getEpisode(ep.id))!.summary)!;
    expect(clean.degraded).toBeUndefined();
    expect(clean.exact_facts).toEqual(["error 500"]);
  });
});
