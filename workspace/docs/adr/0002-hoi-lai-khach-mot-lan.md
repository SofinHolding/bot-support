# ADR 0002 — Hỏi lại khách một lần khi mơ hồ giữa hai mục đã khai báo khác nhau

Ngày: 2026-09-24 · Trạng thái: code đã có; luật (SKILL select-answer v2, Hướng dẫn AI) chờ duyệt hai người

## Bối cảnh

Luật hiện hành: AI phân vân giữa hai cách hiểu thì chuyển nhân viên. Với các cặp cố ý tách, như Forgot ID và Forgot Login ID, cách này làm chuyển nhân viên thừa, còn nếu để thứ hạng tự quyết thì dễ trả lời nhầm.

Người dùng chốt hai điều: "cho phép hỏi lại khách 1 lần", và "xung đột dữ liệu phải xử lý trước khi áp dụng".

## Quyết định

- Chỉ hỏi lại khi hai mục **đã được người duyệt khai báo** `distinct_from` kèm câu hỏi lại. AI không tự đặt câu hỏi.
- AI trả `CLARIFY:<A>,<B>`. Code nhận khi cả hai mục nằm trong danh sách ứng viên, có lời khai, và bật `episode.ask_when_unclear`; thiếu điều kiện nào thì chuyển nhân viên.
- Episode ghi `pending_clarify`. Lượt sau chỉ chọn giữa A và B; vẫn không rõ thì chuyển nhân viên. Mỗi vụ việc hỏi tối đa **một lần**.
- Cổng quyết định không bao giờ tự chọn giữa hai mục đã khai báo khác nhau theo độ dài cụm hay thứ hạng.
- SKILL `select-answer` và "Hướng dẫn AI làm việc" chỉ đổi qua duyệt hai người. Nội dung đề xuất ở `docs/de-xuat/hoi-lai-khach-CLARIFY.md`.

## Hệ quả

Khi luật chưa được duyệt, hành vi giữ như cũ: mơ hồ thì chuyển nhân viên. Tính năng bật bằng một cài đặt, tắt được ngay.
