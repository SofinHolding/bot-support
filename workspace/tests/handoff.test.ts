/**
 * Khối "tóm tắt gửi hỗ trợ" (core/handoff.ts, pipeline.ts › buildSupportSummaryVar):
 *  - hàm thuần: không bịa thêm nội dung ngoài input; nhãn đã duyệt thay cho id; kết quả từng bước;
 *  - phạm vi: chỉ vụ việc hiện tại, không lẫn vấn đề cũ của cùng khách;
 *  - tin RIÊNG dạng khối code (entity "pre"); câu chuyển nhân viên luôn mang mã tham chiếu;
 *  - hai bậc A/B, cả hai đều qua checkOutput + verify-handoff; không đạt thì không có khối (không có bản tiếng Anh dự phòng).
 */
import { describe, expect, it } from "vitest";
import { buildHandoffText, buildTimeline, handoffReasonOf, hasHandoffContent, stepLabel, staffLabelProblems } from "../src/core/handoff";
import type { Template } from "../src/domain/types";
import { fakeLlm, makeWorld, type World } from "./helpers";

const tpl = (over: Partial<Template> & { id: string; group: string }): Template => ({
  response_mode: "EXACT_TEMPLATE", priority: 0, answers: { en: "x" }, follow_up: {}, sets_context: { status: "pending" },
  match: { keywords: [], exact: [], examples: [], image_types: [], rules: [], requires: [], excludes: [], overrides_context: false },
  ...over,
});

describe("buildHandoffText / hasHandoffContent", () => {
  it("in đúng phần có dữ liệu: mã, vấn đề, bước kèm kết quả, giá trị khách nêu, lý do", () => {
    const text = buildHandoffText({
      refCode: "EP-8F3K2",
      issue: "cannot log in",
      summary: { user_reported: "customer says login fails after entering password", unresolved_points: "no error code given yet" },
      steps: [{ kind: "answer", ref: "T:how-to-login", label: "Login with your ID", outcome: "not_solved" }, { kind: "answer", ref: "K:12", label: "Invalid ID error" }],
      droppedSteps: 2,
      facts: ["error: Network timeout 504"],
      reason: "steps_exhausted",
    });
    expect(text).toContain("Ref: EP-8F3K2");
    expect(text).toContain("Issue: cannot log in");
    expect(text).toContain("(+2 earlier steps)");
    expect(text).toContain("1. Login with your ID - not solved");
    expect(text).toContain("2. Invalid ID error - no feedback");
    expect(text).toContain("error: Network timeout 504");
    expect(text).toContain("Still unresolved: no error code given yet");
    expect(text).toContain("Reason for transfer: the approved steps for this case did not solve it");
    expect(text).not.toMatch(/how-to-login|K:12/); // không in id nội bộ
  });

  it("không có nội dung nào đáng kể -> không dựng khối", () => {
    expect(hasHandoffContent({ steps: [], facts: [], reason: "other", refCode: "EP-AAAAA" })).toBe(false);
    expect(hasHandoffContent({ issue: "  ", steps: [], facts: [], reason: "other" })).toBe(false);
    expect(hasHandoffContent({ issue: "x", steps: [], facts: [], reason: "other" })).toBe(true);
  });
});

describe("nhãn bước, lý do chuyển, dòng thời gian", () => {
  it("nhãn: staff_label -> tên mục -> tên vụ việc -> câu mẫu, bỏ nhãn tiếng Việt; đoạn tài liệu dùng tiêu đề lá", () => {
    expect(stepLabel("T:a", tpl({ id: "a", group: "Wallet", staff_label: "Transfer time (15-30 minutes)", sets_context: { issue: "x", status: "pending" } }))).toBe("Transfer time (15-30 minutes)");
    expect(stepLabel("T:a", tpl({ id: "a", group: "Account", sets_context: { issue: "Cách login", status: "pending" }, match: { keywords: [], exact: [], examples: ["how to login"], image_types: [], rules: [], requires: [], excludes: [], overrides_context: false } }))).toBe("how to login");
    expect(stepLabel("T:zz", undefined)).toBe("Approved answer zz");
    expect(stepLabel("K:7", undefined, "Tokenomics Overview › Token Supply")).toBe("Token Supply");
    expect(stepLabel("K:7", undefined, "Không đăng nhập được › Bước 1 — Lỗi Invalid ID")).toBe("Document section 7");
  });

  it("nhãn cho nhân viên: kiểm tra khi publish", () => {
    expect(staffLabelProblems("Internal transfer processing time (15-30 minutes)", "Transfers usually complete within 15-30 minutes.")).toEqual([]);
    const bad = staffLabelProblems("Thời gian chuyển ví 45 phút https://x.com", "Transfers usually complete within 15-30 minutes.").join(" ");
    expect(bad).toContain("tiếng Anh");
    expect(bad).toContain("link");
    expect(bad).toContain("45");
  });

  it("lý do chuyển nhân viên từ lý do bot ghi", () => {
    expect(handoffReasonOf("follow-up (negative) sau template x")).toBe("steps_exhausted");
    expect(handoffReasonOf("khách báo vẫn chưa giải quyết được; kho không còn cách nào khác cho vấn đề này")).toBe("steps_exhausted");
    expect(handoffReasonOf("không tìm được nội dung phù hợp trong kho")).toBe("no_content");
    expect(handoffReasonOf("đã hỏi lại khách nhưng vẫn chưa phân biệt được khách cần mục nào")).toBe("clarify_failed");
    expect(handoffReasonOf("khách quay lại chủ đề \"kyc\" đã được chuyển support trước đó")).toBe("returning_topic");
    expect(handoffReasonOf("khách gửi tệp bot không đọc được (video/voice/tài liệu)")).toBe("media");
    expect(handoffReasonOf("nội dung trong kho đang mâu thuẫn và cùng mốc thời gian, chưa được thống nhất")).toBe("content_conflict");
    expect(handoffReasonOf("lý do mới chưa có trong danh sách")).toBe("other");
  });

  it("dòng thời gian: gộp kết quả vào đúng bước, bỏ lời chào / tin hệ thống, giữ các bước gần nhất", () => {
    const templates: Record<string, Template> = {
      "how-to-login": tpl({ id: "how-to-login", group: "Account", staff_label: "Login with your ID" }),
      "fp-1-greeting": tpl({ id: "fp-1-greeting", group: "Greeting" }),
    };
    const ev = (type: string, payload: Record<string, unknown>) => ({ type, payload });
    const { steps, dropped } = buildTimeline(
      [
        ev("template_sent", { template_id: "fp-1-greeting" }),
        ev("template_sent", { template_id: "how-to-login" }),
        ev("template_sent", { template_id: "how-to-login" }),
        ev("step_outcome", { ref: "T:how-to-login", outcome: "not_solved" }),
        ev("knowledge_sent", { chunk_ids: ["12"], headings: ["Login › Invalid ID"] }),
        ev("image_received", { image_type: "error_dialog" }),
      ],
      (id) => templates[id],
      2,
    );
    expect(dropped).toBe(1);
    expect(steps).toEqual([
      { kind: "answer", ref: "K:12", label: "Invalid ID" },
      { kind: "image", imageType: "error_dialog" },
    ]);
    const all = buildTimeline([ev("template_sent", { template_id: "how-to-login" }), ev("step_outcome", { ref: "T:how-to-login", outcome: "not_solved" })], (id) => templates[id]);
    expect(all.steps).toEqual([{ kind: "answer", ref: "T:how-to-login", label: "Login with your ID", outcome: "not_solved" }]);
  });
});

/** Tin khối tóm tắt gần nhất gửi cho khách (entity "pre") */
const lastBlock = (w: World, u: number) => w.channel.sent.filter((s) => s.chatId === u && s.entities?.some((e) => e.type === "pre")).at(-1);

describe("khối tóm tắt trong luồng thật", () => {
  it("tin riêng dạng khối code; câu chuyển nhân viên có mã tham chiếu; vấn đề mới của cùng khách không lẫn vấn đề cũ", async () => {
    let w: World | undefined;
    const u = 8801;
    const llm = fakeLlm({ summarize: async (req) => ({ issue: "", user_reported: req.messages.filter((m) => m.role === "user").map((m) => m.text).join(" | "), unresolved_points: "" }) });
    w = await makeWorld({ llm });
    try {
      await w.say(u, "why ITLG reduce");
      expect(w.channel.textsTo(u).at(-1)).toContain("The token burn mechanism is now active");
      await w.say(u, "not burn");
      const [ep1] = await w.conv.recentEpisodes(u, 1);
      const texts = w.channel.textsTo(u);
      const block = lastBlock(w, u)!;
      expect(texts.at(-2)).toContain(`Your reference code: ${ep1!.ref_code}`);
      expect(block.text).toBe(texts.at(-1));
      expect(block.entities).toEqual([{ type: "pre", offset: 0, length: block.text.length }]);
      expect(block.text).toContain(`Ref: ${ep1!.ref_code}`);
      expect(block.text).toContain("why ITLG reduce");
      expect(block.text).toContain("Reason for transfer: the approved steps for this case did not solve it");
      expect(block.text).not.toContain("```");

      // Vấn đề 2 (KYC): vụ việc MỚI, không kế thừa gì từ vụ việc 1
      w.channel.images.set("kyc1", { screen_type: "kyc_email" });
      w.channel.images.set("kyc2", { screen_type: "kyc_queue_screen" });
      await w.sayPhoto(u, "kyc1");
      await w.sayPhoto(u, "kyc2");
      await w.say(u, "Nooo");
      const second = lastBlock(w, u)!;
      expect(second.text).not.toBe(block.text);
      expect(second.text).not.toContain("why ITLG reduce");
      expect(second.text.toLowerCase()).not.toContain("burn");
      const ev = await w.db.query<{ payload: { tier: string } }>("SELECT payload FROM events WHERE user_id = $1 AND type = 'handoff_block' ORDER BY id", [u]);
      expect(ev.rows.map((r) => r.payload.tier)).toEqual(["A", "A"]);
    } finally {
      await w?.close();
    }
  });
});

describe("hai bậc kiểm trước khi gửi khối", () => {
  const u = 8802;
  it("tóm tắt dính từ khoá bị cấm (vd 'ROI') -> bậc A bị chặn, gửi bậc B (không có chữ AI viết bị chặn)", async () => {
    const llm = fakeLlm({ summarize: async () => ({ issue: "", user_reported: "customer asked about ROI on their tokens", unresolved_points: "" }) });
    const w = await makeWorld({ llm });
    try {
      await w.say(u, "why ITLG reduce");
      await w.say(u, "not burn");
      const block = lastBlock(w, u)!;
      expect(block.text).not.toContain("ROI");
      expect(block.text).toContain("Bot guidance already given");
      expect(w.channel.textsTo(u).at(-2)).toContain("@interlink_technicalsupport");
      expect((await w.conv.listTickets({ limit: 20, offset: 0 })).find((x) => x.user_id === u)).toBeDefined();
      const ev = await w.db.query<{ payload: { tier: string } }>("SELECT payload FROM events WHERE user_id = $1 AND type = 'handoff_block'", [u]);
      expect(ev.rows[0]!.payload.tier).toBe("B");
    } finally {
      await w.close();
    }
  });

  it("verify-handoff từ chối cả hai bậc -> không có khối, câu chuyển nhân viên vẫn có mã tham chiếu", async () => {
    const llm = fakeLlm({
      summarize: async () => ({ issue: "cannot log in", user_reported: "customer says login fails", unresolved_points: "" }),
      verifyHandoff: async () => ({ ok: false, reason: "test: nội dung không khớp nguồn" }),
    });
    const w = await makeWorld({ llm });
    try {
      await w.say(u + 1, "why ITLG reduce");
      await w.say(u + 1, "not burn");
      const reply = w.channel.textsTo(u + 1).at(-1)!;
      expect(reply).toContain("@interlink_technicalsupport");
      expect(reply).toMatch(/Your reference code: EP-[A-HJKMNP-Z2-9]{5}/);
      expect(reply).not.toContain("Network disconnected");
      expect(lastBlock(w, u + 1)).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  it("verify-handoff lỗi -> không có khối, không làm hỏng câu trả lời", async () => {
    const llm = fakeLlm({
      summarize: async () => ({ issue: "cannot log in", user_reported: "customer says login fails", unresolved_points: "" }),
      verifyHandoff: async () => { throw new Error("503"); },
    });
    const w = await makeWorld({ llm });
    try {
      await w.say(u + 2, "why ITLG reduce");
      await w.say(u + 2, "not burn");
      expect(w.channel.textsTo(u + 2).at(-1)).toContain("@interlink_technicalsupport");
      expect(lastBlock(w, u + 2)).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  it("verify-handoff chỉ đối chiếu phần nội dung: không có tiêu đề, mã tham chiếu, lý do chuyển (chữ cố định của code)", async () => {
    const texts: string[] = [];
    const llm = fakeLlm({ verifyHandoff: async (r) => { texts.push(r.text); return { ok: true }; } });
    const w = await makeWorld({ llm });
    try {
      await w.say(u + 4, "why ITLG reduce");
      await w.say(u + 4, "not burn");
      expect(texts.length).toBe(1);
      expect(texts[0]).toContain("Bot guidance already given");
      expect(texts[0]).not.toMatch(/Ref: |Support request|@interlink_technicalsupport|Reason for transfer/);
      expect(lastBlock(w, u + 4)!.text).toMatch(/Ref: EP-.*Reason for transfer/s);
    } finally {
      await w.close();
    }
  });

  it("gửi khối lỗi -> hộp thư đi giữ định dạng khối để gửi lại", async () => {
    const w = await makeWorld();
    try {
      await w.say(u + 3, "why ITLG reduce");
      w.channel.failSend = true;
      await w.say(u + 3, "not burn");
      const rows = (await w.db.query<{ text: string; entities: { type: string }[] | null }>("SELECT text, entities FROM outbox WHERE chat_id = $1 ORDER BY id", [u + 3])).rows;
      expect(rows.length).toBe(2);
      expect(rows[1]!.entities).toEqual([{ type: "pre", offset: 0, length: rows[1]!.text.length }]);
    } finally {
      await w.close();
    }
  });
});
