---
id: fp-0-security-alert
group: Security
response_mode: SECURITY_RULE
priority: 0
source: AGENTS.md#FP-0
sets_context:
  issue: security-alert-key-leak
  status: none
---
<!-- answer:en -->
⚠️ SECURITY ALERT

You may have shared your private key or seed phrase. This is EXTREMELY DANGEROUS.

🚨 IMMEDIATE ACTIONS:
1. If you have any assets in this wallet — TRANSFER them to a NEW wallet immediately.
2. NEVER share your seed phrase or private key with anyone, including this bot or InterLink support.
3. Any "giveaway" asking for your seed/key is a SCAM.

The real InterLink team NEVER asks for seed phrase or private key. Official support: @interlink_technicalsupport
<!-- next -->
---
id: fp-0-owner-notice
group: Security
response_mode: SECURITY_RULE
priority: 0
source: AGENTS.md#FP-0 (thông báo cho owner)
sets_context:
  status: none
---
<!-- answer:en -->
🚨 FP-0 Security Alert triggered
User: {sender_name} ({sender_id})
Time: {timestamp}
Pattern matched: {A | B | C — chỉ tên pattern, KHÔNG kèm dữ liệu key/seed}
Bot đã cảnh báo user không share seed/key và transfer assets sang ví mới.
<!-- next -->
---
id: admin-console-moved
group: System
response_mode: EXACT_TEMPLATE
priority: 0
source: mới (thay lệnh /contexts, /usage)
sets_context:
  status: none
---
<!-- answer:en -->
Admin Console đã chuyển sang web: {URL}
Xem Hội thoại (thay /contexts) và Usage (thay /usage) trên trang quản trị.
<!-- next -->
---
id: greeting-returning
group: Greeting
response_mode: EXACT_TEMPLATE
priority: 0
source: AGENTS.md#Lời chào
sets_context:
  status: none
---
<!-- answer:en -->
Hi 👋 Your previous topic was "{ISSUE}". Do you want to continue with it, or ask something new?
<!-- next -->
---
id: high-traffic
group: System
response_mode: EXACT_TEMPLATE
priority: 0
source: AGENTS.md#Error Handling
sets_context:
  status: none
---
<!-- answer:en -->
⚠️ The system is currently experiencing high traffic. Please try again in a few minutes. We apologize for the inconvenience. If the issue persists, please contact @interlink_technicalsupport for assistance.
<!-- next -->
---
id: network-disconnected
group: System
response_mode: EXACT_TEMPLATE
priority: 0
source: core/fixed-messages.ts (câu khẩn khi mất kết nối AI)
sets_context:
  status: none
---
<!-- answer:en -->
⚠️ Network disconnected: our support system cannot connect to its AI service right now, so your message could not be processed. Please try again in a few minutes. If the issue persists, please contact @interlink_technicalsupport.
<!-- next -->
---
id: image-unreadable
group: Image
response_mode: EXACT_TEMPLATE
priority: 0
source: image-reader/SKILL.md
sets_context:
  status: none
---
<!-- answer:en -->
Please send a clearer screenshot of the error so I can help.
<!-- next -->
---
id: image-cover-secret
group: Image
response_mode: EXACT_TEMPLATE
priority: 0
source: image-reader/SKILL.md
sets_context:
  status: none
---
<!-- answer:en -->
⚠️ Please cover sensitive information (seed phrase, private key, password) before sending screenshots. NEVER share these with anyone.
<!-- next -->
---
id: antispam-1
group: AntiSpam
response_mode: SECURITY_RULE
priority: 0
source: AGENTS.md#Anti-Spam
sets_context:
  status: none
---
<!-- answer:en -->
I can only assist with InterLink-related questions. For other topics, please contact @interlink_technicalsupport. ⚠️ Please note: continued off-topic messages will result in a warning.
<!-- next -->
---
id: antispam-2
group: AntiSpam
response_mode: SECURITY_RULE
priority: 0
source: AGENTS.md#Anti-Spam
sets_context:
  status: none
---
<!-- answer:en -->
⚠️ Warning: This is your second off-topic message. I can only help with InterLink support. If you send another off-topic message, you will be blocked for 1 minute.
<!-- next -->
---
id: antispam-3
group: AntiSpam
response_mode: SECURITY_RULE
priority: 0
source: AGENTS.md#Anti-Spam
sets_context:
  status: none
---
<!-- answer:en -->
🟡 You have been temporarily blocked for 1 minute due to repeated off-topic messages. Please focus on InterLink-related questions. Next violation: 10-minute block.
<!-- next -->
---
id: antispam-4
group: AntiSpam
response_mode: SECURITY_RULE
priority: 0
source: AGENTS.md#Anti-Spam
sets_context:
  status: none
---
<!-- answer:en -->
🟠 You have been blocked for 10 minutes due to continued off-topic activity. Next violation: 30-minute block. For InterLink support, I'm always here to help.
<!-- next -->
---
id: antispam-5
group: AntiSpam
response_mode: SECURITY_RULE
priority: 0
source: AGENTS.md#Anti-Spam
sets_context:
  status: none
---
<!-- answer:en -->
🟠 You have been blocked for 30 minutes. Next violation: 1-hour block. Please use this bot only for InterLink-related questions.
<!-- next -->
---
id: antispam-6
group: AntiSpam
response_mode: SECURITY_RULE
priority: 0
source: AGENTS.md#Anti-Spam
sets_context:
  status: none
---
<!-- answer:en -->
🔴 You have been blocked for 1 hour due to spam activity. Next violation: 24-hour block.
<!-- next -->
---
id: antispam-7plus
group: AntiSpam
response_mode: SECURITY_RULE
priority: 0
source: AGENTS.md#Anti-Spam
sets_context:
  status: none
---
<!-- answer:en -->
⛔ Your access has been restricted for 24 hours due to repeated spam. For urgent InterLink support, contact @interlink_technicalsupport directly.
