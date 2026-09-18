---
name: image-reader
description: >
  OCR + phân tích image (screenshot) trong support flow. Trigger khi message kèm image.
  KHÔNG dùng câu "ảnh không rõ" tùy tiện — phải OCR thực sự, nếu đọc được error text → match FAST-PATH/SKILL.
---

# Image Reader — Support OCR

**⚡ NGUYÊN TẮC:** Bot MUST đọc thực sự (vision OCR) → trích text → match keyword → reply theo FAST-PATH/SKILL. **KHÔNG deflect bằng "ảnh không rõ"** trừ khi ảnh THỰC SỰ không đọc được (blur, dark, không có text).

## Flow xử lý image (BẮT BUỘC theo thứ tự)

1. **OCR thực sự**: dùng vision capability đọc TOÀN BỘ text trong ảnh. Trích:
   - Error message (dialog "failed", "error occurred", "try again"...)
   - App screen name (Wallet, KYC, Mining, Settings...)
   - Numbers/IDs nếu có
   - Buttons label (Back, Try Again, Retry...)

2. **Match keyword theo text OCR** rồi reply theo template tương ứng:
   - **[PRIORITY 1 — CHECK TRƯỚC mọi rule khác]** Ảnh KYC verification (1 trong 2 type dưới đây, hoặc cả 2 cùng turn) → **AGENTS.md FP-5b** (gửi NGUYÊN VĂN template KYC notification, 1 reply DUY NHẤT cho dù gửi 1 hay 2 ảnh):
     - **Type 1 — Email InterLink KYC notification**: OCR thấy "Verification is available for your account" / "Your verification turn is here" / "Quá trình xác minh của bạn đã sẵn sàng" / "Match Curator" / "upload verification documents" / "tải lên các tài liệu xác minh" / "complete your submission within 24 hours" / button "Start verifying" + branding InterLink.
     - **Type 2 — Screen KYC trong app InterLink hiện queue/waiting** (đa ngôn ngữ):
       - EN: "Verification" / "Verification Stage" / "Stage 1: Document Review" / "In the queue" / "Queue: X Users".
       - DE: "Verifizierung" / "Verifizierungsstufe" / "Stufe 1: Dokumentenprüfung" / "In der Warteschlange" / "Warteschlange: X Nutzer".
       - VI: "Xác minh" / "Bước xác minh" / "Bước 1: Kiểm tra tài liệu" / "Đang trong hàng chờ" / "Hàng chờ: X người dùng".
       - Khác (FR/ES/PT/RU/JP/KO/ZH...): nội dung tương đương "verification stage 1 / queue / document review" + branding InterLink (logo, ID: #00XX, progress 1→2→3).
     - Áp dụng KỂ CẢ KHI: ảnh standalone (không caption); caption là `?`/`help`/`hi`/"vẫn đang chờ"/"still in queue"/"still waiting"/"không thấy màn hình xác minh".
     - User gửi **2 ảnh cùng turn** (Type 1 + Type 2) → vẫn chỉ 1 reply (KHÔNG gấp đôi, KHÔNG mô tả ảnh).
     - **⛔ KHÔNG escalate FP-12 ở turn 1** dù có keyword "KYC + verification + waiting". Chỉ escalate khi user FOLLOW-UP sau template này.
   - Có "creating wallet failed" / "wallet error" / "tạo ví" lỗi → **FP-12 ESCALATE**
   - Có "KYC", "curator", "verification" + error → **FP-12 ESCALATE**
   - Có "mining", "HHP", "ITLG" + error → **FP-12 ESCALATE**
   - Có "login fail", "ID not found", "password" + error → **FP-12 ESCALATE**
   - Có "swap", "balance", "wallet address" + error → **FP-12 ESCALATE**
   - Có "scan face", "camera" đen/black → **SKILL section S03 (camera permission)**
   - Có sticker, meme, emoji không liên quan → **FP-13 off-topic**
   - Text rõ ràng nhưng KHÔNG match case nào → **FP-12 ESCALATE**

3. **Reply**: GỬI NGUYÊN VĂN template tương ứng từ AGENTS.md (FP-12) hoặc SKILL.md. **KHÔNG mô tả lại ảnh, KHÔNG hỏi thêm chi tiết**.

## ⛔ CẤM TUYỆT ĐỐI

- **KHÔNG** reply `"I received your image, but I need a clearer screenshot..."` khi ảnh ĐÃ RÕ. Đây là deflection SAI — chỉ dùng khi ảnh THỰC SỰ blur / dark / unreadable.
- **KHÔNG** reply `"Mình thấy trong ảnh bạn đang gặp lỗi..."` rồi giải thích — đây là chain-of-thought, output PHẢI là template từ FAST-PATH/SKILL.
- **KHÔNG** lặp lại error message từ ảnh trong reply (tránh leak ID/info user).
- **KHÔNG** hỏi thêm "ở bước nào / màn hình nào" khi ảnh đã chỉ rõ context.
- **KHÔNG** đọc to seed phrase / private key / password nếu ảnh chứa — cảnh báo user che lại.

## Trường hợp ảnh THỰC SỰ không đọc được (rare)

CHỈ khi:
- Ảnh full đen / trắng / blur nặng → KHÔNG đọc được text nào.
- Ảnh không liên quan (mèo, người, scene ngoài app InterLink).
- Ảnh quá nhỏ (< 100x100px).

→ GỬI NGUYÊN VĂN: `Please send a clearer screenshot of the error so I can help.`

## Bảo mật

- Nếu OCR thấy seed phrase / private key / password trong ảnh → CẢNH BÁO trước, rồi mới xử lý phần còn lại:
  → `⚠️ Please cover sensitive information (seed phrase, private key, password) before sending screenshots. NEVER share these with anyone.`
