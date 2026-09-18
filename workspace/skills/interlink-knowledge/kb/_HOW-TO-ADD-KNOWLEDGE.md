# Hướng dẫn thêm kiến thức cho admin

## Thêm ngữ cảnh mới
1. Copy `skills/interlink-knowledge/kb/_TEMPLATE.md` thành file mới dạng `<ten-ngu-canh>.md` trong thư mục `skills/interlink-knowledge/kb/`.
2. Viết từng khối tình huống bằng heading `##`, kèm `TRIGGER:` và `ANSWER:`.
3. Thêm 1 dòng vào `skills/interlink-knowledge/kb/INDEX.md` theo mẫu:

```text
<file>.md :: từ khoá 1, từ khoá 2, từ khoá tiếng Anh, từ khoá tiếng Việt
```

## Sửa nội dung
- Sửa trực tiếp phần `ANSWER:` trong file `.md` tương ứng.
- Không cần báo dev.
- Nội dung có hiệu lực ở phiên hội thoại kế tiếp.

## Xoá ngữ cảnh
- Xoá dòng của file đó trong `INDEX.md`.
- File `.md` có thể giữ lại để tham khảo; bot chỉ đọc file được khai báo trong `INDEX.md`.

## Khoá bắt buộc và tuỳ chọn
- Bắt buộc trong mỗi khối: `## tiêu đề`, `TRIGGER:`, `ANSWER:`.
- Tuỳ chọn: `LINKS:`, `ESCALATE_IF:`.

## Từ khoá
- Viết thường.
- Có thể dùng nhiều ngôn ngữ.
- Mỗi từ khoá cách nhau bằng dấu phẩy.
- Không để 1 từ khoá xuất hiện ở 2 file khác nhau, vì sẽ gây nhập nhằng định tuyến.

## Kiểm tra sau khi sửa
1. Mở CMD tại thư mục `workspace`.
2. Chạy:

```bat
node scripts/kb-lint.mjs
```

3. Kết quả đúng phải có dòng:

```text
KB OK
```

## Cảnh báo nội dung
- KHÔNG viết dự đoán giá / ROI / lợi nhuận token.
- KHÔNG viết công thức HCS.
- KHÔNG yêu cầu khách gửi seed phrase / private key / mật khẩu.
- Bot sẽ từ chối dùng khối vi phạm các nội dung trên.

## Độ ưu tiên
- Template đã duyệt trong `AGENTS.md` (FP-0…FP-13) và `skills/interlink-support/SKILL.md` luôn thắng KB nếu trùng chủ đề.
