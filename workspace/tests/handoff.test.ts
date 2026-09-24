/**
 * Conversation Escalation & Support Summary (core/handoff.ts): khối "sao chép gửi hỗ trợ" khi bot chuyển người thật.
 *  - buildHandoffText/hasHandoffContent: hàm thuần, không bịa thêm nội dung ngoài input.
 *  - Phạm vi (Conversation Scope): chỉ episode ĐANG MỞ, không lẫn vấn đề cũ đã escalate/đã đóng của cùng khách.
 */
import { describe, expect, it } from "vitest";
import { buildHandoffText, hasHandoffContent } from "../src/core/handoff";
import type { EpisodeSummary } from "../src/core/summary";
import { fakeLlm, makeWorld, type World } from "./helpers";

const SUMMARY: EpisodeSummary = { issue: "cannot log in", user_reported: "customer says login fails after entering password", unresolved_points: "no error code given yet", exact_facts: ["error: Network timeout 504"], model_note: "" };

describe("buildHandoffText / hasHandoffContent", () => {
  it("chỉ in ra đúng phần có dữ liệu, không suy đoán thêm", () => {
    const text = buildHandoffText({ issue: "cannot log in", summary: SUMMARY, stepsSent: ["fp-8-forgot-id", "esc-wallet-create"], ticketId: 42 });
    expect(text).toContain("Ticket: #42");
    expect(text).toContain("Issue: cannot log in");
    expect(text).toContain("customer says login fails after entering password");
    expect(text).toContain("1. fp-8-forgot-id");
    expect(text).toContain("2. esc-wallet-create");
    expect(text).toContain("error: Network timeout 504");
    expect(text).toContain("no error code given yet");
    expect(text).toContain("a human agent is needed"); // câu trạng thái cuối
  });

  it("không có nội dung nào đáng kể -> hasHandoffContent = false (không dựng khối trống)", () => {
    expect(hasHandoffContent({ stepsSent: [] })).toBe(false);
    expect(hasHandoffContent({ issue: "  ", stepsSent: [] })).toBe(false);
    expect(hasHandoffContent({ issue: "x", stepsSent: [] })).toBe(true);
  });

  it("chỉ có issue (chưa có bước hướng dẫn/tóm tắt) vẫn ra được văn bản gọn, không có mục rỗng", () => {
    const text = buildHandoffText({ issue: "cannot log in", stepsSent: [] });
    expect(text).toContain("Issue: cannot log in");
    expect(text).not.toContain("Bot guidance");
    expect(text).not.toContain("Customer reported");
  });
});

describe("Phạm vi tóm tắt (Conversation Scope): chỉ vấn đề đang mở, không lẫn vấn đề cũ", () => {
  let w: World;
  const u = 8801;
  it("khách escalate vấn đề burn/tokenomics rồi hỏi sang vấn đề KHÁC (KYC) -> khối tóm tắt của lần 2 không nhắc gì tới lần 1, dù cùng 1 khách", async () => {
    // Tóm tắt phản chiếu đúng nội dung tin nhắn thật (không phải hằng số cố định "u"/"p" của fakeLlm mặc định) để phát hiện được rò rỉ giữa hai episode.
    const llm = fakeLlm({ summarize: async (req) => ({ issue: "", user_reported: req.messages.filter((m) => m.role === "user").map((m) => m.text).join(" | "), unresolved_points: "" }) });
    w = await makeWorld({ llm });
    try {
      // Vấn đề 1 (burn/tokenomics): hướng dẫn xong không giải quyết được -> escalate -> episode đóng lại (status=escalated)
      await w.say(u, "why ITLG reduce");
      expect(w.channel.textsTo(u).at(-1)).toContain("The token burn mechanism is now active");
      await w.say(u, "not burn");
      const first = w.channel.textsTo(u).at(-1)!;
      expect(first).toContain("Summary to send to support");
      expect(first).toContain("why ITLG reduce");

      // Vấn đề 2 (KYC): hoàn toàn khác chủ đề -> episode MỚI (EpisodeManager tách theo topic_group), không kế thừa gì từ episode 1 ở trên
      w.channel.images.set("kyc1", { screen_type: "kyc_email" });
      w.channel.images.set("kyc2", { screen_type: "kyc_queue_screen" });
      await w.sayPhoto(u, "kyc1");
      await w.sayPhoto(u, "kyc2");
      await w.say(u, "Nooo");
      const second = w.channel.textsTo(u).at(-1)!;
      expect(second).toContain("Summary to send to support");
      expect(second).not.toContain("why ITLG reduce"); // KHÔNG lẫn nội dung vấn đề cũ
      expect(second.toLowerCase()).not.toContain("burn");
    } finally {
      await w.close();
    }
  });
});

describe("Hai lớp kiểm trước khi gửi khối tóm tắt (không phải tóm tắt xong dịch rồi gửi thẳng)", () => {
  const u = 8802;
  it("nội dung tóm tắt dính từ khoá bị cấm (vd 'ROI') -> checkOutput chặn, KHÔNG gửi khối này (khách vẫn nhận câu FP-12 + có ticket)", async () => {
    const llm = fakeLlm({ summarize: async () => ({ issue: "", user_reported: "customer asked about ROI on their tokens", unresolved_points: "" }) });
    const w = await makeWorld({ llm });
    try {
      await w.say(u, "why ITLG reduce");
      await w.say(u, "not burn");
      const reply = w.channel.textsTo(u).at(-1)!;
      expect(reply).toContain("@interlink_technicalsupport"); // câu FP-12 gốc vẫn gửi
      expect(reply).not.toContain("Network disconnected"); // chuyển người thật thật sự, không phải câu báo mất kết nối
      expect(reply).not.toContain("Summary to send to support"); // nhưng không kèm khối tóm tắt dính chính sách
      const t = (await w.conv.listTickets({ limit: 20, offset: 0 })).find((x) => x.user_id === u)!;
      expect(t).toBeDefined(); // ticket vẫn được tạo bình thường, không phụ thuộc khối tóm tắt
    } finally {
      await w.close();
    }
  });

  it("SKILL verify-handoff từ chối (nội dung không đúng nguồn/vi phạm giới hạn) -> KHÔNG gửi khối tóm tắt", async () => {
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
      expect(reply).not.toContain("Network disconnected"); // chuyển người thật thật sự, không phải câu báo mất kết nối
      expect(reply).not.toContain("Summary to send to support");
    } finally {
      await w.close();
    }
  });

  it("verify-handoff lỗi (LLM ném exception) -> KHÔNG gửi khối tóm tắt, không làm hỏng cả câu trả lời", async () => {
    const llm = fakeLlm({
      summarize: async () => ({ issue: "cannot log in", user_reported: "customer says login fails", unresolved_points: "" }),
      verifyHandoff: async () => { throw new Error("503"); },
    });
    const w = await makeWorld({ llm });
    try {
      await w.say(u + 2, "why ITLG reduce");
      await w.say(u + 2, "not burn");
      const reply = w.channel.textsTo(u + 2).at(-1)!;
      expect(reply).toContain("@interlink_technicalsupport");
      expect(reply).not.toContain("Network disconnected"); // chuyển người thật thật sự, không phải câu báo mất kết nối
      expect(reply).not.toContain("Summary to send to support");
    } finally {
      await w.close();
    }
  });
});
