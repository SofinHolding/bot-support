# ADR 0001 — Mục hỏi đáp thay cho template; giữ nguyên hạ tầng

Ngày: 2026-09-24 · Trạng thái: chấp nhận

## Bối cảnh

Hệ thống template chép cách tổ chức của bot cũ. Rà soát (docs/AUDIT_KHO_TRI_THUC.md) cho thấy lỗi nằm ở cách xây dựng:

- Bot khớp bằng từ khoá "chứa trong câu", kể cả từ đơn: từ "ambassador" giành mọi câu về Ambassador.
- Độ ưu tiên dạng số được gán theo thứ tự trong tài liệu cũ: mục Niêm yết ưu tiên 880 thắng mục Chuyển ITLG ưu tiên 500 với câu "convert ITLG to ITL".
- Câu trả lời soạn sẵn luôn được xét trước tài liệu tham khảo.
- Không có chỗ khai báo "hai mục khác nhau ở đâu".
- Nội dung phải sửa bằng Markdown/YAML.

## Quyết định

- Thay mô hình nội dung bằng **mục hỏi đáp**:
  - nhiều cách hỏi cho một câu trả lời;
  - có nhiều bước;
  - có `distinct_from` kèm câu hỏi lại khách;
  - không có độ ưu tiên số, không có từ khoá một từ.
- Mục hỏi đáp được **dịch sang template lúc publish** (`compileItems`), nên giữ nguyên toàn bộ hạ tầng: Postgres, phiên bản và hoàn tác, duyệt hai người, dịch, ticket, kiểm tra hồi quy, luồng Telegram, luật bảo mật và chống spam.
- Mỗi chủ đề là một tài liệu có phiên bản (`items-<chủ đề>`). Người quản lý sửa bằng form trên Admin Web.
- Giữ nguyên `id` từ hệ thống cũ. Mục hỏi đáp **thay chỗ** template cũ cùng mã khi publish, nên chuyển được từng chủ đề và hoàn tác được.

## Hệ quả

- Câu một từ ("twin", "register") không còn khớp thẳng mà đi qua bước AI chọn. Bộ câu kiểm tra phải cập nhật có chủ ý: bước hồi quy sẽ chặn cho tới khi làm việc này.
- Xung đột giữa các mục phải xử lý trước khi publish (bước 3 chặn), không chỉ cảnh báo.
- Không làm lại router từ đầu. Router hiện có đã xét mục hỏi đáp và đoạn tài liệu trong cùng một danh sách ở nhánh AI/RAG.
