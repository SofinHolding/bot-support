/**
 * Câu cố định gửi khách KHÔNG qua AI, luôn bằng tiếng Anh, ghi sẵn trong mã nguồn để vẫn gửi được khi mất kết nối LLM.
 *
 * Quy tắc (docs/KIEN_TRUC_KIEN_THUC.md, "Mọi câu trả lời đều qua AI"): nội dung lấy từ kho KHÔNG BAO GIỜ được gửi thẳng
 * cho khách — phải qua SKILL AI đánh giá trong lượt đó rồi dịch sang ngôn ngữ của khách. Mất kết nối LLM ở bất kỳ bước nào
 * thì gửi NETWORK_DISCONNECTED_EN. Chỉ hai ngoại lệ do code xử lý (chạy cả khi mất LLM, luôn tiếng Anh):
 *   - cảnh báo bảo mật khi khách gửi seed phrase / private key (FP-0, luật SECURITY_RULE);
 *   - cảnh báo / chặn chống spam.
 *
 * Bản mặc định dưới đây là bản CHÉP NGUYÊN VĂN mẫu đã duyệt trong content/templates/system.md (test
 * tests/fixed-messages.test.ts bắt lệch). Lúc chạy ưu tiên bản tiếng Anh đang publish của mẫu (sửa qua duyệt hai người);
 * mẫu không đọc được thì dùng bản mặc định này.
 */
import type { TemplateIndex } from "./template-index";

export const NETWORK_DISCONNECTED_EN =
  "⚠️ Network disconnected: our support system cannot connect to its AI service right now, so your message could not be processed. Please try again in a few minutes. If the issue persists, please contact @interlink_technicalsupport.";

export const DEFAULT_FIXED_EN: Record<string, string> = {
  "fp-0-security-alert": `⚠️ SECURITY ALERT

You may have shared your private key or seed phrase. This is EXTREMELY DANGEROUS.

🚨 IMMEDIATE ACTIONS:
1. If you have any assets in this wallet — TRANSFER them to a NEW wallet immediately.
2. NEVER share your seed phrase or private key with anyone, including this bot or InterLink support.
3. Any "giveaway" asking for your seed/key is a SCAM.

The real InterLink team NEVER asks for seed phrase or private key. Official support: @interlink_technicalsupport`,
  "antispam-1": "I can only assist with InterLink-related questions. For other topics, please contact @interlink_technicalsupport. ⚠️ Please note: continued off-topic messages will result in a warning.",
  "antispam-2": "⚠️ Warning: This is your second off-topic message. I can only help with InterLink support. If you send another off-topic message, you will be blocked for 1 minute.",
  "antispam-3": "🟡 You have been temporarily blocked for 1 minute due to repeated off-topic messages. Please focus on InterLink-related questions. Next violation: 10-minute block.",
  "antispam-4": "🟠 You have been blocked for 10 minutes due to continued off-topic activity. Next violation: 30-minute block. For InterLink support, I'm always here to help.",
  "antispam-5": "🟠 You have been blocked for 30 minutes. Next violation: 1-hour block. Please use this bot only for InterLink-related questions.",
  "antispam-6": "🔴 You have been blocked for 1 hour due to spam activity. Next violation: 24-hour block.",
  "antispam-7plus": "⛔ Your access has been restricted for 24 hours due to repeated spam. For urgent InterLink support, contact @interlink_technicalsupport directly.",
};

/** Bản tiếng Anh của một câu cố định: bản đang publish nếu đọc được, không thì bản mặc định trong mã nguồn. */
export function fixedEnglish(index: TemplateIndex | undefined, id: string): string {
  let live: string | undefined;
  try {
    const t = index?.get(id);
    live = t ? index!.resolveAnswerSource(t).answers.en : undefined;
  } catch {
    live = undefined;
  }
  const text = live?.trim() ? live : DEFAULT_FIXED_EN[id];
  if (!text) throw new Error(`không có câu cố định cho ${id}`);
  return text.trimEnd();
}
