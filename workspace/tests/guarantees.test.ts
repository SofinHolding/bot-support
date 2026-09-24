/** Các bảo đảm nghiệp vụ không được vỡ: ngữ cảnh không lây, ca cần người thật luôn có ticket, không mất tin, hồi quy chặn đúng. */
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/kb/service";
import { fakeLlm, makeWorld, type World } from "./helpers";

let w: World;
afterEach(async () => w?.close());
const HOUR = 3_600_000;
const episodesOf = async (uid: number) => (await w.conv.recentEpisodes(uid, 10)).map((e) => ({ group: e.topic_group, status: e.status, issue: e.issue }));

describe("ngữ cảnh của vấn đề cũ không bị vấn đề khác làm hỏng", () => {
  it("câu lạ (escalate) sau thời gian im lặng KHÔNG đóng episode KYC, và KYC không bị ép chuyển support về sau", async () => {
    w = await makeWorld({ llm: fakeLlm() }); // fakeLlm phân loại mọi câu lạ là escalate
    await w.say(8001, "how to KYC");
    const kycAnswer = w.channel.textsTo(8001).at(-1)!;
    const before = (await episodesOf(8001))[0]!;
    expect(before).toMatchObject({ group: "KYC", status: "open" });

    w.clock.advance(2 * HOUR);
    await w.say(8001, "please explain quantum banana zebra protocol");
    expect(w.channel.textsTo(8001).at(-1)).toContain("@interlink_technicalsupport");
    const eps = await episodesOf(8001);
    expect(eps.find((e) => e.group === "KYC")).toMatchObject({ status: "dormant", issue: before.issue }); // giữ nguyên vấn đề gốc
    expect(eps.find((e) => e.status === "escalated")).toMatchObject({ group: null, issue: "please explain quantum banana zebra protocol" });

    await w.say(8001, "how to KYC");
    expect(w.channel.textsTo(8001).at(-1)).toBe(kycAnswer); // vẫn được trả lời bằng template đã duyệt
  });

  it("FP-0 mở episode bảo mật riêng, không ghi đè vấn đề khách đang được hỗ trợ", async () => {
    w = await makeWorld();
    await w.say(8002, "how to KYC");
    await w.say(8002, "abandon, ability, able, about, above, absent, absorb, abstract, absurd, abuse, access, accident");
    const eps = await episodesOf(8002);
    expect(eps.find((e) => e.group === "KYC")).toMatchObject({ status: "open" });
    expect(eps.find((e) => e.group === "Security")).toMatchObject({ status: "security_alerted", issue: "security-alert-key-leak" });
    const stored = await w.db.query<{ text: string }>("SELECT text FROM messages WHERE user_id = 8002");
    expect(JSON.stringify(stored.rows)).not.toContain("absorb");
  });

  it("vấn đề mới không có danh mục KHÔNG bị gộp vào ticket đang mở của việc khác", async () => {
    w = await makeWorld({ llm: fakeLlm() });
    await w.say(8003, "swap fail");
    w.clock.advance(2 * HOUR);
    await w.say(8003, "please explain quantum banana zebra protocol");
    const tickets = (await w.conv.listTickets({ limit: 10, offset: 0 })).filter((t) => t.user_id === 8003);
    expect(tickets.length).toBe(2);
    expect(tickets.every((t) => !(t.notes ?? "").includes("quantum"))).toBe(true);
  });
});

describe("không chắc chắn thì chuyển người thật, và luôn để lại dấu vết", () => {
  it("không đọc được ảnh (model từ chối / lỗi) -> chuyển support + ticket, không văng lỗi 'high traffic'", async () => {
    w = await makeWorld({ llm: fakeLlm({ vision: async () => { throw new Error("refused"); } }) });
    await w.sayPhoto(8010, "f1");
    expect(w.channel.textsTo(8010).at(-1)).toContain("@interlink_technicalsupport");
    expect((await w.conv.listTickets({ limit: 10, offset: 0 })).some((t) => t.user_id === 8010)).toBe(true);
  });

  it("lượt xử lý hỏng giữa chừng: khách nhận câu cố định, hệ thống tạo ticket system-error và bản ghi quyết định", async () => {
    w = await makeWorld();
    const orig = w.live.ensureFresh.bind(w.live);
    let thrown = false;
    w.live.ensureFresh = async (...a) => {
      if (!thrown) {
        thrown = true;
        throw new Error("db hiccup");
      }
      return orig(...a);
    };
    const r = await w.say(8011, "how to login");
    expect(r.status).toBe("error");
    expect(w.channel.textsTo(8011).at(-1)).toContain("high traffic");
    const t = (await w.conv.listTickets({ limit: 10, offset: 0 })).find((x) => x.user_id === 8011)!;
    expect(t).toMatchObject({ category: "system-error", status: "open" });
    const d = await w.db.query<{ via: string; kind: string }>("SELECT via, kind FROM decisions WHERE user_id = 8011");
    expect(d.rows[0]).toMatchObject({ via: "pipeline_error", kind: "ESCALATE" });
  });
});

describe("không mất tin khi tiến trình chết giữa chừng", () => {
  it("update dang dở: lần gửi lại sớm bị báo in_progress (không xác nhận với Telegram); quá hạn thì được nhận lại; đã xong thì bỏ qua", async () => {
    w = await makeWorld();
    expect(await w.conv.claimUpdate(555)).toBe(true); // lượt đầu nhận rồi "chết" trước khi xong
    expect(await w.conv.claimUpdate(555)).toBe(false);
    expect(await w.conv.updateUnfinished(555)).toBe(true);
    const item = { updateId: 555, messageId: 1, text: "how to login" };
    const batch = { chatId: 8020, chatType: "private" as const, userId: 8020, isMention: true, at: w.clock.now, items: [item] };
    expect((await w.pipeline.handle(batch)).status).toBe("in_progress");

    await w.db.query("UPDATE inbound_updates SET received_at = now() - interval '3 minutes' WHERE telegram_update_id = 555");
    const again = await w.pipeline.handle(batch);
    expect(again.status).toBe("ok");
    expect(w.channel.textsTo(8020).length).toBe(1);
    expect((await w.pipeline.handle(batch)).status).toBe("duplicate"); // đã xong: không trả lời trùng
    expect(w.channel.textsTo(8020).length).toBe(1);
  });
});

describe("thêm nội dung không được phá câu trả lời đã duyệt", () => {
  it("một câu đang ĐÚNG bị làm sai thì chặn Publish, kể cả khi câu khác được sửa đúng bù lại (tổng độ chính xác không đổi)", async () => {
    w = await makeWorld({ adminIds: [9001, 9002] });
    const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };
    await w.kb.addEvalCase({ question: "pizza zzz recipe", expected: "new-pizza", imageType: null, source: "test" }); // hiện đang sai (chưa có template)
    const md = `---
id: new-pizza
group: Test
response_mode: EXACT_TEMPLATE
priority: 999
match:
  keywords:
    - pizza zzz recipe
    - how to login
sets_context:
  issue: pizza
  status: pending
---
<!-- answer:en -->
Pizza answer
`;
    const { version, report } = await w.kbService.createDraft({ slug: "pizza", kind: "templates", md, author: admin });
    expect(report.regression!.accuracyAfter).toBeGreaterThanOrEqual(report.regression!.accuracyBefore);
    const step = report.steps.find((s) => s.name.startsWith("5."))!;
    expect(step.status).toBe("error");
    expect(step.details.join(" ")).toContain("how to login");
    expect(report.ok).toBe(false);
    await expect(w.kbService.publish(version.id, admin)).rejects.toThrow(/chưa qua kiểm tra/);
    await w.say(8030, "how to login");
    expect(w.channel.textsTo(8030).at(-1)).toBe(w.live.index.get("how-to-login")!.answers.en); // câu trả lời đã duyệt vẫn nguyên vẹn
  });
});
