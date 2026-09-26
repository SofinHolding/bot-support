/**
 * Memory giai đoạn 1 (huong-dan-memory-interlink-bot v3): ranh giới vụ việc theo khoá chủ đề ở mọi tầng, vụ việc xác định
 * TRƯỚC khi dựng câu trả lời (mã tham chiếu, điểm neo), bước gần nhất cho cả đoạn tài liệu, kết quả từng bước, câu hỏi gửi
 * lúc mất kết nối AI, bảo vệ biến khi dịch, lọc hiệu lực khi lấy lại đoạn tài liệu theo id.
 */
import { afterEach, describe, expect, it } from "vitest";
import { topicKeyOf, topicKeyOfGroup } from "../src/core/items";
import { LlmUnavailableError, type LlmPort, type UnderstandRequest } from "../src/core/ports";
import { protectTerms, restoreTerms, translationProblems } from "../src/core/translate";
import { PgKnowledge } from "../src/kb/knowledge-search";
import { HashEmbedder } from "../src/core/embedding";
import { HANDLERS, type JobContext } from "../src/worker/jobs";
import { fakeLlm, makeWorld, type World } from "./helpers";

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** AI không xác nhận FAST PATH (mọi tin đi nhánh AI/RAG) và chọn đúng các ứng viên được liệt kê. */
function ragLlm(pick: (candidates: string[], text: string) => string | undefined, over: Partial<LlmPort> = {}): LlmPort {
  return fakeLlm({
    verify: async () => ({ ok: false, reason: "test: force AI/RAG" }),
    select: async (r) => ({ ref: pick(r.candidates.map((c) => c.ref), r.text) ?? "ESCALATE", reason: "test" }),
    ...over,
  });
}
const episodes = async (uid: number) => (await w!.conv.recentEpisodes(uid, 10)).sort((a, b) => a.id - b.id);
const events = async (uid: number, type: string) => (await w!.db.query<{ payload: Record<string, unknown>; episode_id: string | null }>("SELECT payload, episode_id FROM events WHERE user_id = $1 AND type = $2 ORDER BY id", [uid, type])).rows;
const inbound = async (uid: number) => (await w!.db.query<{ id: string; episode_id: string | null; image_type: string | null }>("SELECT id, episode_id, image_type FROM messages WHERE user_id = $1 AND direction = 'in' ORDER BY id", [uid])).rows;

describe("khoá chủ đề chuẩn hoá (topicKeyOf)", () => {
  it("nhóm cũ và chủ đề mục hỏi đáp cho cùng một khoá; nhóm không chủ đề không có khoá", () => {
    expect(topicKeyOf({ group: "Wallet" })).toBe("wallet");
    expect(topicKeyOf({ group: "wallet" })).toBe("wallet");
    expect(topicKeyOf({ group: "Tokens" })).toBe(topicKeyOf({ group: "Withdraw" }));
    expect(topicKeyOf({ group: "KYC" })).toBe("kyc");
    for (const g of ["Greeting", "FollowUp", "Escalate", "System", "Security", "AntiSpam", "Image", "greeting", "support", "system"]) expect(topicKeyOf({ group: g })).toBeUndefined();
    expect(topicKeyOfGroup("SomethingNew")).toBe("general"); // như lúc chuyển sang mục hỏi đáp
    expect(topicKeyOf(undefined)).toBeUndefined();
  });
});

describe("ranh giới vụ việc", () => {
  it("nhánh AI/RAG: đổi chủ đề thì tách vụ việc, không ghi đè vấn đề của vụ việc trước", async () => {
    w = await makeWorld({ llm: ragLlm((c) => c.find((r) => r === "T:how-to-login" || r === "T:wallet-address")) });
    const u = 881001;
    await w.say(u, "how to login");
    await w.say(u, "wallet address");
    const eps = await episodes(u);
    expect(eps.map((e) => [e.topic_key, e.status])).toEqual([["account", "dormant"], ["wallet", "open"]]);
    expect(eps[0]!.issue).toBe("Cách login");
    const d = (await w.db.query<{ via: string; tier: number }>("SELECT via, tier FROM decisions WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [u])).rows[0]!;
    expect(d).toMatchObject({ via: "llm_select", tier: 2 }); // trước đây chỉ tách khi khớp chắc chắn ở tầng 0-1
  });

  it("câu trả lời từ tài liệu không đổi vụ việc; tin nối tiếp sau đó được hiểu theo đúng đoạn tài liệu vừa gửi", async () => {
    const seen: UnderstandRequest[] = [];
    const llm = ragLlm((c, text) => (/tokenomics/i.test(text) ? c.find((r) => r.startsWith("K:")) : c.find((r) => r === "T:how-to-login")), {
      understand: async (r) => {
        seen.push(r);
        const thanks = /^thanks/i.test(r.text) && !!r.lastAnswer;
        return { language: "en", intent: thanks ? "follow_up" : "question", follow_up: thanks ? "thanks" : "none", query_en: r.text, query_kb: r.text };
      },
    });
    w = await makeWorld({ llm });
    const u = 881002;
    await w.say(u, "how to login");
    await w.say(u, "explain the tokenomics overview");
    let [ep] = await episodes(u);
    expect((await episodes(u)).length).toBe(1);
    expect(ep!.last_ref).toMatch(/^K:\d+$/);
    expect(ep!.last_template_id).toBeNull(); // không còn áp luật nối tiếp của template how-to-login lên câu trả lời tài liệu

    await w.say(u, "thanks a lot");
    expect(seen.at(-1)!.lastAnswer?.id).toBe(ep!.last_ref);
    expect(w.channel.textsTo(u).at(-1)).toBe("You're welcome");
    const outcomes = await events(u, "step_outcome");
    expect(outcomes.map((e) => e.payload)).toEqual([
      { ref: "T:how-to-login", outcome: "asked_again", via: "understand" },
      { ref: ep!.last_ref, outcome: "solved", via: "understand" },
    ]);
    [ep] = await episodes(u);
    expect(ep!.status).toBe("resolved");
  });

  it("quay lại chủ đề cũ trong cửa sổ mở lại: mở lại vụ việc cũ, giữ điểm neo", async () => {
    w = await makeWorld();
    const u = 881003;
    await w.say(u, "how to login");
    const [a] = await episodes(u);
    w.clock.advance(60_000);
    await w.say(u, "wallet address");
    w.clock.advance(10 * 60_000);
    await w.say(u, "how to login");
    const eps = await episodes(u);
    expect(eps.length).toBe(2);
    expect(eps.find((e) => e.id === a!.id)).toMatchObject({ status: "open", anchor_message_id: a!.anchor_message_id });
    expect(eps.find((e) => e.id !== a!.id)!.status).toBe("dormant");
  });

  it("chuyển nhân viên ngay câu đầu: vụ việc có mã tham chiếu, ticket mang mã đó, tin đầu là điểm neo", async () => {
    w = await makeWorld();
    const u = 881004;
    await w.say(u, "swap fail");
    const [ep] = await episodes(u);
    expect(ep!.ref_code).toMatch(/^EP-[A-HJKMNP-Z2-9]{5}$/);
    const [msg] = await inbound(u);
    expect(Number(msg!.episode_id)).toBe(ep!.id);
    expect(ep!.anchor_message_id).toBe(Number(msg!.id));
    expect(ep!.anchor_query_en).toBe("swap fail");
    const t = (await w.conv.listTickets({ limit: 50, offset: 0 })).find((x) => x.user_id === u) as unknown as { episode_ref_code: string };
    expect(t.episode_ref_code).toBe(ep!.ref_code);
  });

  it("khách báo chưa được sau một câu trả lời: ghi kết quả của đúng bước đó, một lần", async () => {
    w = await makeWorld({
      llm: fakeLlm({
        understand: async (r) => {
          const neg = /still not/i.test(r.text) && !!r.lastAnswer;
          return { language: "en", intent: neg ? "follow_up" : "question", follow_up: neg ? "negative" : "none", query_en: r.text, query_kb: r.text };
        },
      }),
    });
    const u = 881005;
    await w.say(u, "how to login");
    await w.say(u, "still not working");
    await w.say(u, "still not working");
    expect((await events(u, "step_outcome")).map((e) => e.payload)).toEqual([{ ref: "T:how-to-login", outcome: "not_solved", via: "understand" }]);
  });
});

describe("câu hỏi gửi lúc mất kết nối AI", () => {
  it("vụ việc mở ở lượt sau nhận tin đó làm điểm bắt đầu", async () => {
    let down = true;
    w = await makeWorld({
      llm: fakeLlm({
        understand: async (r) => {
          if (down) throw new LlmUnavailableError("gateway down");
          return { language: "en", intent: "question", follow_up: "none", query_en: r.text, query_kb: r.text };
        },
      }),
    });
    const u = 881006;
    await w.say(u, "how do I login to my account");
    expect(w.channel.textsTo(u).at(-1)).toContain("Network disconnected");
    expect((await events(u, "unanswered_question")).length).toBe(1);
    expect(await episodes(u)).toEqual([]);

    down = false;
    w.clock.advance(2 * 60_000);
    await w.say(u, "how to login");
    const [ep] = await episodes(u);
    const msgs = await inbound(u);
    expect(msgs.map((m) => Number(m.episode_id))).toEqual([ep!.id, ep!.id]);
    expect(ep!.anchor_message_id).toBe(Number(msgs[0]!.id));
  });
});

describe("ảnh gắn với tin đến", () => {
  it("loại ảnh do AI đọc được ghi vào tin nhắn", async () => {
    w = await makeWorld();
    const u = 881007;
    w.channel.images.set("err1", { screen_type: "error_dialog", error_text: "Something went wrong" });
    await w.sayPhoto(u, "err1");
    expect((await inbound(u))[0]!.image_type).toBe("error_dialog");
  });
});

describe("bảo vệ biến và mã tham chiếu khi dịch", () => {
  it("biến và mã được thay bằng token bảo vệ, khôi phục đúng", () => {
    const p = protectTerms("Your previous topic was \"{ISSUE}\". Reference EP-8F3K2.{SUPPORT_SUMMARY}");
    expect(p.tokens).toEqual(expect.arrayContaining(["{ISSUE}", "{SUPPORT_SUMMARY}", "EP-8F3K2"]));
    expect(p.text).not.toMatch(/\{|EP-/);
    expect(restoreTerms(p.text, p.tokens)).toContain("EP-8F3K2");
  });

  it("bản dịch làm mất hoặc dịch luôn tên biến -> không đạt kiểm tra", () => {
    expect(translationProblems("Your previous topic was \"{ISSUE}\".", "Chủ đề trước của bạn là \"{ISSUE}\".", "vi")).toEqual([]);
    expect(translationProblems("Your previous topic was \"{ISSUE}\".", "Chủ đề trước của bạn là \"{VẤN_ĐỀ}\".", "vi").join(" ")).toContain("biến");
    expect(translationProblems("Contact support.{SUPPORT_SUMMARY}", "Liên hệ bộ phận hỗ trợ.", "vi").join(" ")).toContain("biến");
  });
});

describe("lấy lại đoạn tài liệu theo id", () => {
  it("đoạn đã hết thời gian hiệu lực không được trả về", async () => {
    w = await makeWorld();
    const knowledge = new PgKnowledge(w.kb, new HashEmbedder());
    const id = (await w.db.query<{ id: string }>("SELECT c.id::text AS id FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id WHERE v.status = 'published' ORDER BY c.id LIMIT 1")).rows[0]!.id;
    expect((await knowledge.byIds([id])).map((h) => h.chunkId)).toEqual([id]);
    await w.db.query("UPDATE kb_chunks SET metadata = metadata || '{\"valid_until\": \"2000-01-01\"}'::jsonb WHERE id = $1", [id]);
    expect(await knowledge.byIds([id])).toEqual([]);
  });
});

describe("hồ sơ khách xuyên vụ việc (thiết bị, phiên bản app)", () => {
  it("giá trị code trích được nhớ qua vụ việc sau và đưa vào ngữ cảnh AI", async () => {
    const seen: UnderstandRequest[] = [];
    w = await makeWorld({ llm: fakeLlm({ understand: async (r) => { seen.push(r); return { language: "en", intent: "question", follow_up: "none", query_en: r.text, query_kb: r.text }; } }) });
    const u = 881008;
    await w.say(u, "how to login, I use Samsung S23 with version 3.2.1");
    expect((await w.conv.getUser(u))!.profile).toMatchObject({ device: { value: "Samsung S23" }, app_version: { value: "3.2.1" } });
    w.clock.advance(3 * 86_400_000);
    await w.say(u, "wallet address");
    expect(seen.at(-1)!.context?.profile).toContain("device: Samsung S23; app version: 3.2.1");
  });
});

describe("xoá dữ liệu theo thời hạn (job retention)", () => {
  it("mặc định không xoá gì; đặt thời hạn thì xoá đúng thứ tự, giữ sự kiện bảo mật / ticket và dòng vụ việc", async () => {
    w = await makeWorld();
    const u = 881009;
    await w.say(u, "swap fail");
    await w.say(u, "abandon ability able about above absent absorb abstract absurd abuse access accident");
    const count = async (sql: string) => Number((await w!.db.query<{ n: string }>(sql, [u])).rows[0]!.n);
    const snapshot = async () => ({
      messages: await count("SELECT count(*) AS n FROM messages WHERE user_id = $1"),
      decisions: await count("SELECT count(*) AS n FROM decisions WHERE user_id = $1"),
      kept: await count("SELECT count(*) AS n FROM events WHERE user_id = $1 AND (type = 'security_alert' OR type LIKE 'ticket\\_%')"),
      events: await count("SELECT count(*) AS n FROM events WHERE user_id = $1"),
      episodes: await count("SELECT count(*) AS n FROM episodes WHERE user_id = $1"),
    });
    const ctx = { ops: w.ops, settings: w.settings, now: () => new Date(w!.clock.now.getTime() + 400 * 86_400_000) } as unknown as JobContext;
    const before = await snapshot();
    expect((await HANDLERS.retention!(ctx, {})) as { purged: Record<string, number> }).toMatchObject({ purged: {} });
    expect(await snapshot()).toEqual(before);

    for (const k of ["messages", "events", "decisions", "episodes"]) await w.ops.setSetting(`retention.${k}_days`, 180, "test");
    w.settings.invalidate();
    await HANDLERS.retention!(ctx, {});
    const after = await snapshot();
    expect(after).toMatchObject({ messages: 0, decisions: 0, episodes: before.episodes });
    expect(after.kept).toBe(before.kept);
    expect(after.events).toBe(before.kept);
    const ep = (await w.db.query<{ issue: string | null; summary: unknown }>("SELECT issue, summary FROM episodes WHERE user_id = $1 AND closed_at IS NOT NULL", [u])).rows;
    expect(ep.every((e) => e.issue === null && e.summary === null)).toBe(true);
  });
});
