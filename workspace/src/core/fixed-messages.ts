/**
 * "Câu khẩn": câu phải gửi được NGAY, kể cả khi AI chậm hoặc mất kết nối — cảnh báo lộ seed/private key, cảnh báo ảnh chứa
 * bí mật, chống spam, báo mất kết nối, câu chuyển nhân viên (docs: huong-dan-memory v3 mục 8; quyết định owner QĐ1, QĐ3).
 *
 * Gửi bằng NGÔN NGỮ CỦA KHÁCH qua đường dịch nhanh (`ResponseResolver.forUrgent`): bước AI duy nhất là dịch, làm trước (job
 * `prewarm-urgent-translations` lưu bản dịch sẵn) hoặc tại chỗ với thời gian chờ ngắn. Không qua understand / select / verify.
 * Lời gọi dịch chỉ nhận câu mẫu đã duyệt, không bao giờ nhận tin của khách hay bí mật của khách (N8).
 *
 * Bản mặc định dưới đây là bản CHÉP NGUYÊN VĂN mẫu đã duyệt trong content/templates/system.md (test
 * tests/fixed-messages.test.ts bắt lệch). Lúc chạy ưu tiên bản tiếng Anh đang publish của mẫu; mẫu chưa có trong kho
 * (DB cũ chưa seed mẫu mới) thì dùng bản mặc định này.
 */
import type { TemplateIndex } from "./template-index";

export const NETWORK_DISCONNECTED_EN =
  "⚠️ Network disconnected: our support system cannot connect to its AI service right now, so your message could not be processed. Please try again in a few minutes. If the issue persists, please contact @interlink_technicalsupport.";

export const NETWORK_DISCONNECTED_ID = "network-disconnected";

export const DEFAULT_FIXED_EN: Record<string, string> = {
  [NETWORK_DISCONNECTED_ID]: NETWORK_DISCONNECTED_EN,
  "image-cover-secret": "⚠️ Please cover sensitive information (seed phrase, private key, password) before sending screenshots. NEVER share these with anyone.",
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

/** Nhóm câu khẩn: được dịch sẵn sang mọi ngôn ngữ khách đã dùng (job prewarm-urgent-translations). */
export const URGENT_TEMPLATE_IDS = [
  "fp-0-security-alert",
  "image-cover-secret",
  "antispam-1",
  "antispam-2",
  "antispam-3",
  "antispam-4",
  "antispam-5",
  "antispam-6",
  "antispam-7plus",
  NETWORK_DISCONNECTED_ID,
  "fp-12-escalate",
] as const;

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
