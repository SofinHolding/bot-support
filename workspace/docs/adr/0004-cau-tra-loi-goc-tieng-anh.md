# ADR 0004 — Câu trả lời gốc tiếng Anh; kho tài liệu mặc định tiếng Anh

Ngày: 2026-09-24 · Trạng thái: chấp nhận

## Quyết định

- Người quản lý bot viết câu trả lời gốc (`say.en`) và câu hỏi lại khách bằng **tiếng Anh**. Bot dịch trung thành sang ngôn ngữ của khách; bản dịch được lưu và duyệt ở mục Bản dịch.
- Đổi câu gốc thì các bản ngôn ngữ khác đi kèm bị bỏ và được dịch lại. Script áp quyết định của khách nhắc viết lại khi câu mới có vẻ là tiếng Việt.
- `router.knowledge_lang` mặc định là `en`, vì ba tài liệu tham khảo viết tiếng Anh. Trước đây mặc định `vi` khiến câu hỏi tiếng Anh bị dịch sang tiếng Việt để tìm trong tài liệu tiếng Anh (audit R5).
- Vector của đoạn tài liệu tính trên đủ đường dẫn tiêu đề "A › B" (audit R7). Câu gửi khách và khoá bản dịch không đổi.
