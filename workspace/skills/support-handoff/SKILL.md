---
name: support-handoff
description: >
  Sinh bản tóm tắt vấn đề của 1 user để user copy gửi @interlink_technicalsupport. Kích hoạt khi bot không giải quyết được (FP-12 HANDOFF, hoặc KB miss, hoặc user báo đã làm đủ hướng dẫn mà vẫn lỗi).
---

# Support Handoff — Copyable Summary

## Phạm vi tóm tắt (bắt buộc)

- Chỉ tóm tắt vấn đề **đang xử lý** của **đúng user gửi tin**.
- Mốc bắt đầu = tin nhắn user mở đầu vấn đề hiện tại: `contexts.issue_started_at` / `thread[0]`.
- Mốc kết thúc = tin mới nhất.
- KHÔNG tóm tắt các vấn đề đã đóng trước đó.
- KHÔNG gộp tin nhắn của thành viên khác trong group.

## Nguồn dữ liệu (theo thứ tự ưu tiên)

1. Lịch sử hội thoại trong phiên hiện tại của user đó.
2. `memory/contexts/{uid}.json` field `thread` + `issue` khi phiên đã reset.
3. Không có cả hai → dựng block chỉ với tin nhắn mới nhất của user, `Diễn biến` 1 dòng.

## Redaction bắt buộc trong block

Trong block, thay các dữ liệu sau bằng `[REDACTED]`:

- Seed phrase.
- Private key.
- Passcode / mật khẩu.
- Mã OTP.
- Chuỗi `0x` + ≥ 20 ký tự hex.
- ≥10 từ tiếng Anh viết thường liên tiếp dạng BIP39.

KHÔNG chèn suy đoán nguyên nhân. KHÔNG chèn tên file / skill / FP. KHÔNG chèn handle `@interlink_technicalsupport` **vào trong** block.

## Output

Gửi đúng 1 message Telegram, gồm:

1. Dòng hướng dẫn.
2. Fenced block markdown (3 dấu backtick) là phần cuối cùng của message.

Dòng hướng dẫn = dịch nguyên nghĩa câu nguồn sang ngôn ngữ user, giữ nguyên handle:

`I've noted your issue. Please copy the message below and send it to @interlink_technicalsupport so our support team can help you further.`

**Bắt buộc format block bằng fenced block markdown.** Openclaw convert sang `<pre>`, Telegram hiện nút copy.

**CẤM raw HTML** (`<pre>`, `<code>`) vì openclaw escape thành text.

Trong block KHÔNG được chứa ký tự backtick.

## Khung block

Nhãn dịch theo ngôn ngữ user. Bản `vi` và `en` dưới đây là chuẩn. Ngôn ngữ khác dịch từ bản `en`.

Bản `vi`:

```text
=== INTERLINK SUPPORT REQUEST ===
Telegram: @username (id 123456789)
InterLink ID: chưa cung cấp
Thời gian: 2026-09-18 14:32 (UTC+7)
Vấn đề: không nhận được mã xác thực khi đăng nhập
Diễn biến:
1. User: không đăng nhập được vào tài khoản InterLink
2. Bot: hướng dẫn nhập lại ID và bỏ số 0 ở đầu
3. User: đã bỏ số 0 nhưng vẫn báo Invalid ID
Đã thử: nhập lại ID không có số 0 ở đầu, thử lại 2 lần
Hiện trạng: vẫn không đăng nhập được
=== END ===
```

Nhãn bản `en`:

- `Telegram`
- `InterLink ID`
- `Time`
- `Issue`
- `History`
- `Tried`
- `Current status`

Hai dòng mốc `=== INTERLINK SUPPORT REQUEST ===` và `=== END ===` giữ nguyên tiếng Anh ở mọi ngôn ngữ.

## Giới hạn

- `Diễn biến` / `History` tối đa 6 dòng.
- Ưu tiên giữ dòng đầu của user + các dòng mới nhất.
- Mỗi dòng diễn biến ≤ 160 ký tự.
- Cả block ≤ 1200 ký tự.
- Cả message ≤ 4096 ký tự.

## Thiếu dữ liệu

- Không có username → `Telegram: id 123456789`.
- User chưa cung cấp InterLink ID → giữ dòng `InterLink ID:` với giá trị `chưa cung cấp` (bản `en`: `not provided`) để user tự điền trước khi gửi.
- Không xác định được `Đã thử` / `Tried` → bỏ hẳn dòng đó, KHÔNG in dòng rỗng.

## Cập nhật context sau khi gửi

Ghi `memory/contexts/{uid}.json`:

```json
{
  "status": "pending",
  "last_bot_action": "handoff_summary_sent",
  "last_matched_section": "handoff",
  "handoff_sent_at": "<iso>",
  "updated_at": "<iso>"
}
```

Giữ và cập nhật `issue`, `issue_started_at`, `thread` theo luật `AGENTS.md`.

## Lượt tiếp theo sau handoff

Áp dụng khi `handoff_sent_at` đã có, cùng `issue`:

- User cung cấp **thông tin mới** (thêm triệu chứng / bước đã thử / ID / ảnh) → sinh lại block đã cập nhật cùng khung, ghi lại `handoff_sent_at`.
- User chỉ nhắc lại / hỏi bao lâu / không có thông tin mới → **KHÔNG gửi lại block**, reply dịch câu nguồn:
  `Your summary above is ready — please send it to @interlink_technicalsupport. If you have new details, share them and I'll update the summary.`
- User cảm ơn → `You're welcome` (dịch), set `status: "resolved"`.

## Không áp dụng handoff cho

- FP-0 security alert.
- FP-13 / off-topic + anti-spam.
- Session của admin (admin console).
