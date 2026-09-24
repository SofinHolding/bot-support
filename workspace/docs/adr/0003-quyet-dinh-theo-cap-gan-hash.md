# ADR 0003 — Quyết định về cặp nội dung gắn với nội dung lúc quyết

Ngày: 2026-09-24 · Trạng thái: chấp nhận

## Bối cảnh

Một số chồng lấn là có chủ ý. Ví dụ mục "Muốn làm Ambassador" và đoạn tài liệu "How to Become an Ambassador" nói cùng một việc. Nếu lưu quyết định "cho qua" vĩnh viễn, thì khi một bên đổi nội dung, xung đột mới sẽ bị che mất.

## Quyết định

- Bảng `kb_pair_decisions` lưu hai bên cùng **hash nội dung lúc quyết**: với mục là cách hỏi, cụm, câu trả lời; với đoạn là nguyên văn.
- Quyết định chỉ còn hiệu lực khi cả hai hash chưa đổi (`hasValidDecision`). Đổi nội dung thì bước kiểm tra chặn lại và hỏi lại người duyệt.
- Cặp luôn lưu theo thứ tự khoá, nên (A,B) và (B,A) là một.

## Hệ quả

Người duyệt đôi khi phải xác nhận lại sau khi sửa nội dung. Đó là cái giá chấp nhận được để không có xung đột nào bị coi là "đã xử lý" nhờ một quyết định cũ.
