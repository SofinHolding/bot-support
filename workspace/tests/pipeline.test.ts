import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_FIXED_EN, NETWORK_DISCONNECTED_EN } from "../src/core/fixed-messages";
import { LlmUnavailableError } from "../src/core/ports";
import { fakeLlm, makeWorld, type World } from "./helpers";

let w: World;
let uid = 100;
const newUser = () => ++uid;

beforeAll(async () => {
  w = await makeWorld({ adminIds: [9001, 9002], ownerId: 9001 });
});
afterAll(async () => w.close());

const last = (chat: number) => w.channel.textsTo(chat).at(-1);
// Câu chuyển nhân viên chuẩn, bỏ chỗ chèn khối tóm tắt ({SUPPORT_SUMMARY} rỗng khi vụ việc chưa có gì để tóm tắt), giống resolver.forTemplate.
const tplOf = (id: string) => w.live.index.get(id)!.answers.en!.replace(/\{SUPPORT_SUMMARY\}/g, "").trimEnd();
/** Câu chuyển nhân viên (có thể kèm khối tóm tắt vụ việc: chuyển nhân viên ngay câu đầu vẫn có vụ việc để tóm tắt) */
const isEscalation = (text: string | undefined) => !!text && text.startsWith(tplOf("fp-12-escalate"));

describe("FP-0: lộ key / seed", () => {
  it("cảnh báo nguyên văn, KHÔNG lưu key, chỉ ghi security-alert-key-leak, báo owner", async () => {
    const u = newUser();
    const key = "0x" + "ab12".repeat(16);
    const r = await w.say(u, key);
    expect(r.decisionKind).toBe("SECURITY");
    expect(last(u)).toBe(tplOf("fp-0-security-alert"));
    expect(last(u)).toContain("⚠️ SECURITY ALERT");

    // Không có bản sao của key ở bất kỳ bảng nào
    const dump = JSON.stringify([
      (await w.db.query("SELECT * FROM messages")).rows,
      (await w.db.query("SELECT * FROM events")).rows,
      (await w.db.query("SELECT * FROM decisions")).rows,
      (await w.db.query("SELECT * FROM episodes")).rows,
    ]);
    expect(dump).not.toContain("ab12ab12");
    const msgs = (await w.db.query<{ text: string }>("SELECT text FROM messages WHERE user_id = $1 AND direction = 'in'", [u])).rows;
    expect(msgs[0]!.text).toBe("[REDACTED - key leak warning sent]");
    const ep = (await w.db.query<{ issue: string; status: string; last_bot_action: string }>("SELECT issue, status, last_bot_action FROM episodes WHERE user_id = $1", [u])).rows[0]!;
    expect(ep).toMatchObject({ issue: "security-alert-key-leak", status: "security_alerted", last_bot_action: "fast/FP-0" });

    // Owner nhận thông báo, không kèm dữ liệu key
    const notice = w.channel.textsTo(9001).at(-1)!;
    expect(notice).toContain("🚨 FP-0 Security Alert triggered");
    expect(notice).toContain(`(${u})`);
    expect(notice).toContain("Pattern matched: B");
    expect(notice).not.toContain("ab12");
  });

  it("ưu tiên hơn chào hỏi và hơn cả trạng thái bị chặn spam", async () => {
    const u = newUser();
    await w.conv.saveAntispam(u, { offtopic_count: 6, blocked_until: new Date(w.clock.now.getTime() + 3600_000), last_seen: w.clock.now });
    await w.conv.touchUser({ id: u }, w.clock.now);
    const seed = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const r = await w.say(u, seed);
    expect(r.decisionKind).toBe("SECURITY");
  });

  it("owner không nhận được thông báo thì tiếp tục, không retry vòng lặp", async () => {
    const u = newUser();
    w.channel.failSend = false;
    const before = w.channel.sent.length;
    const r = await w.say(u, "/wallet 0x" + "a".repeat(40));
    expect(r.status).toBe("ok");
    expect(w.channel.sent.length - before).toBe(2); // 1 cho khách + 1 cho owner
  });
});

describe("FAST-PATH và ngữ cảnh", () => {
  it("chào: 'May I help you'; có case đang dở thì dùng mẫu returning-user", async () => {
    const u = newUser();
    await w.say(u, "hi");
    expect(last(u)).toBe("May I help you");
    await w.say(u, "how to withdraw");
    expect(last(u)).toBe(tplOf("fp-2-withdraw"));
    await w.say(u, "hello");
    expect(last(u)).toBe('Hi 👋 Your previous topic was "withdraw availability". Do you want to continue with it, or ask something new?');
  });

  it("chuỗi FP-5b: email KYC -> gửi thêm ảnh gửi lại -> hỏi tiếp thì ESCALATE -> cảm ơn", async () => {
    const u = newUser();
    w.channel.images.set("kyc1", { screen_type: "kyc_email" });
    w.channel.images.set("kyc2", { screen_type: "kyc_queue_screen" });
    await w.sayPhoto(u, "kyc1");
    expect(last(u)).toBe(tplOf("fp-5b-kyc-email-queue"));
    await w.sayPhoto(u, "kyc2"); // thêm ảnh: cùng case, gửi lại cùng template
    expect(last(u)).toBe(tplOf("fp-5b-kyc-email-queue"));
    await w.say(u, "Nooo");
    // episode đã có bước hướng dẫn trước đó (2 lần gửi fp-5b-kyc-email-queue) -> khối "sao chép gửi hỗ trợ" xuất hiện
    expect(last(u)).toContain(tplOf("fp-12-escalate"));
    expect(last(u)).toContain("Summary to send to support");
    expect(last(u)).toContain("fp-5b-kyc-email-queue");
    const t = (await w.conv.listTickets({ limit: 5, offset: 0 })).find((x) => x.user_id === u)!;
    expect(t).toBeDefined();
    expect(t.status).toBe("open");
    expect(t.source_template_id).toBe("fp-5b-kyc-email-queue");
  });

  it("2 ảnh trong cùng lượt (email + màn hình queue) chỉ trả MỘT reply", async () => {
    const u = newUser();
    w.channel.images.set("a", { screen_type: "kyc_email" });
    w.channel.images.set("b", { screen_type: "kyc_queue_screen" });
    const before = w.channel.textsTo(u).length;
    await w.pipeline.handle({ chatId: u, chatType: "private", userId: u, isMention: true, at: w.clock.now, items: [{ updateId: 5001 + u, messageId: 1, photoFileId: "a" }, { updateId: 6001 + u, messageId: 2, photoFileId: "b" }] });
    expect(w.channel.textsTo(u).length - before).toBe(1);
    expect(last(u)).toBe(tplOf("fp-5b-kyc-email-queue"));
  });

  it("burn -> 'not burn' -> ESCALATE, ticket mang mã M02 và PIC Quang", async () => {
    const u = newUser();
    await w.say(u, "why ITLG reduce");
    expect(last(u)).toContain("The token burn mechanism is now active");
    await w.say(u, "not burn");
    // episode đã có bước hướng dẫn trước đó (fp-4-itlg-burn) -> khối "sao chép gửi hỗ trợ" xuất hiện
    expect(last(u)).toContain(tplOf("fp-12-escalate"));
    expect(last(u)).toContain("Summary to send to support");
    const t = (await w.conv.listTickets({ limit: 20, offset: 0 })).find((x) => x.user_id === u)!;
    expect(t).toMatchObject({ error_code: "M02", pic: "Quang" });
  });

  it("lỗi hệ thống -> câu FP-12 + ticket có mã lỗi/PIC/thông tin cần xin", async () => {
    const u = newUser();
    await w.say(u, "swap fail");
    expect(isEscalation(last(u))).toBe(true);
    expect(last(u)).toContain("Summary to send to support"); // chuyển nhân viên ngay câu đầu: vụ việc mở TRƯỚC khi dựng câu trả lời nên có khối tóm tắt
    const t = (await w.conv.listTickets({ limit: 30, offset: 0 })).find((x) => x.user_id === u)!;
    expect(t).toMatchObject({ error_code: "SWAP", pic: "Quang" });
    expect(t.required_info).toContain("wallet address");
  });

  it("khách quay lại chủ đề đã escalate: nối tiếp ticket cũ, không tạo ticket mới", async () => {
    const u = newUser();
    await w.say(u, "swap fail");
    const t1 = (await w.conv.listTickets({ limit: 50, offset: 0 })).filter((x) => x.user_id === u);
    w.clock.advance(3 * 86_400_000);
    await w.say(u, "swap error again");
    const t2 = (await w.conv.listTickets({ limit: 50, offset: 0 })).filter((x) => x.user_id === u);
    expect(t1.length).toBe(1);
    expect(t2.length).toBe(1);
    expect(t2[0]!.notes).toContain("khách hỏi lại");
  });
});

describe("chống spam", () => {
  it("bậc thang cảnh báo -> chặn, và khi bị chặn thì im lặng", async () => {
    const llm = fakeLlm({ understand: async (r) => ({ language: "en", intent: "offtopic", follow_up: "none", query_en: r.text, query_kb: r.text }) });
    const w2 = await makeWorld({ llm });
    try {
      const u = 777;
      const say = (t: string) => w2.say(u, t);
      await say("what is the weather in Paris today");
      expect(w2.channel.textsTo(u).at(-1)).toContain("I can only assist with InterLink-related questions.");
      await say("tell me a joke about cats please");
      expect(w2.channel.textsTo(u).at(-1)).toContain("This is your second off-topic message");
      await say("who won the football match yesterday");
      expect(w2.channel.textsTo(u).at(-1)).toContain("blocked for 1 minute");
      const n = w2.channel.textsTo(u).length;
      const r = await say("what is the capital of France");
      expect(r.decisionKind).toBe("BLOCKED");
      expect(w2.channel.textsTo(u).length).toBe(n); // im lặng trong thời gian chặn

      w2.clock.advance(61_000); // hết 1 phút => tự mở chặn
      await say("how do you cook rice noodles properly");
      expect(w2.channel.textsTo(u).at(-1)).toContain("blocked for 10 minutes");
      const ev = await w2.conv.userEvents(u, ["antispam_unblock", "antispam_block", "antispam_warning"], 20);
      expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(["antispam_unblock", "antispam_block", "antispam_warning"]));
    } finally {
      await w2.close();
    }
  });

  it("cảnh báo chống spam là ngoại lệ do code xử lý: luôn gửi nguyên văn tiếng Anh, không qua dịch, kể cả với khách không dùng tiếng Anh", async () => {
    let translateCalls = 0;
    const llm = fakeLlm({
      understand: async (r) => ({ language: "de", intent: "offtopic", follow_up: "none", query_en: r.text, query_kb: r.text }),
      translate: async (r) => { translateCalls++; return `[${r.lang}] ${r.text}`; },
    });
    const w2 = await makeWorld({ llm });
    try {
      const u = 778;
      await w2.say(u, "Wie ist das Wetter heute in Paris?");
      expect(w2.channel.textsTo(u)).toEqual([DEFAULT_FIXED_EN["antispam-1"]]);
      await w2.say(u, "Erzähl mir bitte einen Witz über Katzen");
      expect(w2.channel.textsTo(u).at(-1)).toBe(DEFAULT_FIXED_EN["antispam-2"]);
      expect(translateCalls).toBe(0);
    } finally {
      await w2.close();
    }
  });

  it("admin không bị chặn spam và không bị ghi hội thoại/antispam/context", async () => {
    const llm = fakeLlm({ understand: async (r) => ({ language: "en", intent: "offtopic", follow_up: "none", query_en: r.text, query_kb: r.text }) });
    const w2 = await makeWorld({ llm, adminIds: [9001], ownerId: 9001 });
    try {
      await w2.say(9001, "what is the weather in Paris today");
      await w2.say(9001, "tell me a joke about cats please");
      expect((await w2.db.query("SELECT 1 FROM antispam WHERE user_id = 9001")).rowCount).toBe(0);
      expect((await w2.db.query("SELECT 1 FROM messages WHERE user_id = 9001")).rowCount).toBe(0);
      expect((await w2.db.query("SELECT 1 FROM episodes WHERE user_id = 9001")).rowCount).toBe(0);
    } finally {
      await w2.close();
    }
  });
});

describe("admin", () => {
  it("lệnh /contexts, /usage chỉ trỏ tới trang web; user thường gõ thì xử lý như tin thường (không lộ console)", async () => {
    await w.say(9001, "/contexts");
    expect(last(9001)).toContain("https://admin.example.test");
    const u = newUser();
    await w.say(u, "/contexts");
    expect(last(u)).not.toContain("admin.example.test");
    expect(isEscalation(last(u))).toBe(true);
  });
});

describe("nhóm chat và idempotency", () => {
  it("nhóm: chỉ trả lời khi được nhắc tên", async () => {
    const u = newUser();
    const n = w.channel.sent.length;
    const r = await w.say(u, "how to withdraw", { chatType: "group", isMention: false });
    expect(r.status).toBe("ignored");
    expect(w.channel.sent.length).toBe(n);
    await w.say(u, "how to withdraw", { chatType: "group", isMention: true });
    expect(w.channel.sent.length).toBe(n + 1);
  });

  it("cùng một update_id gửi lại không tạo phản hồi/ticket trùng", async () => {
    const u = newUser();
    const batch = { chatId: u, chatType: "private" as const, userId: u, isMention: true, at: w.clock.now, items: [{ updateId: 424242 + u, messageId: 1, text: "swap fail" }] };
    const a = await w.pipeline.handle(batch);
    const b = await w.pipeline.handle(batch);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("duplicate");
    expect(w.channel.textsTo(u).length).toBe(1);
    expect((await w.conv.listTickets({ limit: 100, offset: 0 })).filter((t) => t.user_id === u).length).toBe(1);
  });
});

describe("độ bền", () => {
  it("LLM quá tải / mất kết nối ở bất kỳ bước nào -> câu báo mất kết nối cố định (tiếng Anh), không lộ lỗi kỹ thuật, không gửi nội dung kho", async () => {
    let failAt = "understand";
    const down = (step: string) => async () => { if (failAt === step) throw new LlmUnavailableError("429 usage limit"); };
    const llm = fakeLlm({
      understand: async (r) => { await down("understand")(); return { language: "en", intent: "question", follow_up: "none", query_en: r.text, query_kb: r.text }; },
      verify: async () => { await down("verify")(); return { ok: true }; },
      select: async (r) => { await down("select")(); return { ref: r.candidates[0]?.ref ?? "ESCALATE", reason: "" }; },
    });
    const w2 = await makeWorld({ llm });
    try {
      const u = 500;
      for (const step of ["understand", "verify", "select"]) {
        failAt = step;
        // "verify": câu khớp từ khoá chắc chắn ở FAST PATH; "select": câu lạ đi nhánh AI/RAG
        const r = await w2.say(u, step === "verify" ? "how to withdraw" : "some strange sentence about zebras and withdraw tokens");
        expect(r).toMatchObject({ decisionKind: "UNAVAILABLE" });
        expect(w2.channel.textsTo(u).at(-1)).toBe(NETWORK_DISCONNECTED_EN);
      }
      expect(w2.channel.textsTo(u).every((t) => t === NETWORK_DISCONNECTED_EN)).toBe(true);
      expect(w2.channel.textsTo(u).join(" ")).not.toContain("429");
      const d = (await w2.db.query<{ kind: string; template_id: string | null }>("SELECT kind, template_id FROM decisions WHERE user_id = $1", [u])).rows;
      expect(d).toEqual([{ kind: "UNAVAILABLE", template_id: null }, { kind: "UNAVAILABLE", template_id: null }, { kind: "UNAVAILABLE", template_id: null }]);
    } finally {
      await w2.close();
    }
  });

  it("Telegram lỗi -> đưa vào outbox, không mất tin", async () => {
    const u = newUser();
    w.channel.failSend = true;
    await w.say(u, "how to withdraw");
    w.channel.failSend = false;
    const due = await w.ops.dueOutbox();
    expect(due.some((o) => o.chat_id === u && o.text === tplOf("fp-2-withdraw"))).toBe(true);
  });

  it("lỗi bất ngờ trong pipeline -> gửi thông báo cố định, không có stack trace", async () => {
    const w2 = await makeWorld();
    try {
      const orig = w2.conv.touchUser;
      w2.conv.touchUser = async () => { throw new Error("db exploded at /secret/path"); };
      const r = await w2.say(601, "hello");
      expect(r.status).toBe("error");
      expect(w2.channel.textsTo(601)).toEqual([NETWORK_DISCONNECTED_EN]);
      expect(w2.channel.textsTo(601).at(-1)).not.toContain("exploded");
      w2.conv.touchUser = orig;
    } finally {
      await w2.close();
    }
  });
});

describe("đa ngôn ngữ", () => {
  it("trả lời bằng ngôn ngữ của khách: dịch MỘT lần, lưu chờ duyệt, lần sau dùng bản đã lưu; bản admin sửa và duyệt thay thế bản máy", async () => {
    let calls = 0;
    const llm = fakeLlm({ translate: async (r) => { calls++; return `[${r.lang}] ${r.text}`; } });
    const w2 = await makeWorld({ llm });
    try {
      const en = w2.live.index.get("fp-2-withdraw")!.answers.en;
      await w2.say(700, "tôi muốn rút tiền");
      expect(w2.channel.textsTo(700).at(-1)).toBe(`[vi] ${en}`);
      expect(calls).toBe(1);
      expect((await w2.kb.getTranslation("fp-2-withdraw", "vi"))?.status).toBe("pending");
      await w2.say(700, "rút tiền khi nào");
      expect(calls).toBe(1);
      expect((await w2.conv.getUser(700))?.language).toBe("vi");

      await w2.kb.approveTranslation("fp-2-withdraw", "vi", "admin#9002", "Bản admin đã sửa");
      await w2.say(700, "rút tiền thế nào");
      expect(w2.channel.textsTo(700).at(-1)).toBe("Bản admin đã sửa");
      expect(calls).toBe(1);
    } finally {
      await w2.close();
    }
  });

  it("bản dịch máy làm đổi @handle/URL thì KHÔNG được gửi: khách nhận nguyên văn tiếng Anh", async () => {
    const llm = fakeLlm({ translate: async () => { throw new Error("bản dịch làm thay đổi URL hoặc handle"); } }); // LlmClient ném lỗi này khi token bảo vệ bị đổi
    const w2 = await makeWorld({ llm });
    try {
      await w2.say(703, "câu hỏi rất lạ về quantum banana zebra");
      expect(w2.channel.textsTo(703).at(-1)).toBe(w2.live.index.get("fp-12-escalate")!.answers.en!.replace(/\{SUPPORT_SUMMARY\}/g, "").trimEnd());
      expect(await w2.kb.getTranslation("fp-12-escalate", "vi")).toBeNull();
    } finally {
      await w2.close();
    }
  });

  it("không cần duyệt bản dịch: bản dịch AI đạt kiểm tra được gửi ngay và lưu lại để dùng lượt sau", async () => {
    const w2 = await makeWorld({ llm: fakeLlm() });
    try {
      const en = w2.live.index.get("fp-2-withdraw")!.answers.en;
      await w2.say(702, "tôi muốn rút tiền");
      expect(w2.channel.textsTo(702).at(-1)).toBe(`[vi] ${en}`);
      expect((await w2.kb.getTranslation("fp-2-withdraw", "vi"))?.text).toBe(`[vi] ${en}`);
    } finally {
      await w2.close();
    }
  });

  it("dịch lỗi cả 3 lần (không phải mất kết nối) -> chuyển người thật, KHÔNG gửi câu trả lời bằng tiếng Anh", async () => {
    let calls = 0;
    const llm = fakeLlm({ translate: async () => { calls++; throw new Error("bad"); } });
    const w2 = await makeWorld({ llm });
    try {
      await w2.say(701, "tôi muốn rút tiền");
      const last = w2.channel.textsTo(701).at(-1)!;
      expect(last).not.toBe(w2.live.index.get("fp-2-withdraw")!.answers.en);
      expect(last).toContain("@interlink_technicalsupport");
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      await w2.close();
    }
  });
});

describe("ảnh", () => {
  it("ảnh có seed/key: cảnh báo che thông tin và KHÔNG lưu ảnh", async () => {
    const u = newUser();
    w.channel.images.set("s", { screen_type: "error_dialog", has_secret: true, error_text: "creating wallet failed" });
    await w.sayPhoto(u, "s");
    const texts = w.channel.textsTo(u);
    expect(texts[0]).toBe("⚠️ Please cover sensitive information (seed phrase, private key, password) before sending screenshots. NEVER share these with anyone.");
    expect(isEscalation(texts.at(-1))).toBe(true);
  });

  it("ảnh không đọc được: yêu cầu ảnh rõ hơn", async () => {
    const u = newUser();
    w.channel.images.set("blur", { screen_type: "unreadable", readable: false });
    await w.sayPhoto(u, "blur");
    expect(last(u)).toBe("Please send a clearer screenshot of the error so I can help.");
  });

  it("ảnh hộp thoại lỗi trong app -> escalate FP-12", async () => {
    const u = newUser();
    w.channel.images.set("err", { screen_type: "error_dialog", error_text: "Something went wrong, try again" });
    await w.sayPhoto(u, "err");
    expect(isEscalation(last(u))).toBe(true);
  });
});

describe("ghi nhận và riêng tư", () => {
  it("không lưu ID/số dài/email/mật khẩu vào log hội thoại", async () => {
    const u = newUser();
    await w.say(u, "how to withdraw, my id is 123456789012 and email me a@b.com password: hunter2");
    const row = (await w.db.query<{ text: string }>("SELECT text FROM messages WHERE user_id = $1 AND direction = 'in'", [u])).rows[0]!;
    expect(row.text).not.toContain("123456789012");
    expect(row.text).not.toContain("a@b.com");
    expect(row.text).not.toContain("hunter2");
  });

  it("mỗi câu trả lời có bản ghi quyết định (tầng, template, lý do) để Admin xem", async () => {
    const u = newUser();
    await w.say(u, "delete account");
    const d = (await w.db.query<{ kind: string; template_id: string; tier: number; via: string }>("SELECT * FROM decisions WHERE user_id = $1", [u])).rows[0]!;
    expect(d).toMatchObject({ kind: "TEMPLATE", template_id: "fp-9-delete-account", via: "keyword" });
    expect(Number(d.tier)).toBe(0);
  });

  it("câu hỏi lạ ngoài KB bị đánh dấu new_question để admin bổ sung", async () => {
    const u = newUser();
    await w.say(u, "please explain quantum banana zebra protocol");
    const d = (await w.db.query<{ notes: { new_question: boolean } }>("SELECT notes FROM decisions WHERE user_id = $1", [u])).rows[0]!;
    expect(d.notes.new_question).toBe(true);
  });
});

describe("chống đốt chi phí và ảnh không liên quan", () => {
  it("khách vượt hạn mức token/ngày thì KHÔNG gọi LLM nữa: nhận câu báo mất kết nối cố định, không nhận nội dung kho chưa qua AI", async () => {
    let llmCalls = 0;
    const llm = fakeLlm({
      understand: async (r) => { llmCalls++; return { language: "en", intent: "question", follow_up: "none", query_en: r.text, query_kb: r.text }; },
      verify: async () => { llmCalls++; return { ok: true }; },
      select: async () => { llmCalls++; return { ref: "ESCALATE", reason: "" }; },
    });
    const w2 = await makeWorld({ llm });
    try {
      const u = 8001;
      await w2.conv.touchUser({ id: u }, w2.clock.now);
      await w2.conv.addLlmCall({ userId: u, purpose: "classify", inputTokens: 190_000, outputTokens: 20_000 }, new Date(w2.clock.now.getTime() - 3600_000));
      await w2.say(u, "please explain quantum banana zebra protocol");
      await w2.say(u, "how to withdraw"); // câu khớp từ khoá chắc chắn cũng không được gửi thẳng
      expect(llmCalls).toBe(0);
      expect(w2.channel.textsTo(u)).toEqual([NETWORK_DISCONNECTED_EN, NETWORK_DISCONNECTED_EN]);
      // khách khác vẫn được phục vụ bằng LLM
      await w2.say(8002, "please explain quantum banana zebra protocol");
      expect(llmCalls).toBeGreaterThan(0);
      expect(w2.channel.textsTo(8002).at(-1)).toContain("I'm sorry, I don't have enough information");
    } finally {
      await w2.close();
    }
  });

  it("ảnh meme/không liên quan InterLink -> off-topic (bậc thang chống spam)", async () => {
    const u = newUser();
    w.channel.images.set("meme", { screen_type: "unrelated" });
    await w.sayPhoto(u, "meme");
    expect(last(u)).toContain("I can only assist with InterLink-related questions.");
  });
});
