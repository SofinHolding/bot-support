---
name: interlink-knowledge
description: >
  Kho kiến thức do admin quản lý (skills/interlink-knowledge/kb/). Kích hoạt CHỈ khi message KHÔNG match FAST-PATH (FP-0→FP-11b) VÀ KHÔNG match section nào trong skills/interlink-support/SKILL.md — tức bước 5 của luồng support, trước khi HANDOFF.
---

# InterLink Knowledge — Admin-managed KB Router

## Flow bắt buộc (đúng thứ tự, tối đa 2 lượt read)

1. `read skills/interlink-knowledge/kb/INDEX.md`.
   - ENOENT → coi như KB rỗng, sang HANDOFF, KHÔNG retry.
2. Parse `INDEX.md`:
   - Bỏ dòng rỗng và dòng bắt đầu bằng `#`.
   - Mỗi dòng còn lại tách bằng ` :: ` → `file` + danh sách từ khoá.
   - Danh sách từ khoá tách bằng dấu phẩy, `trim`, lowercase.
   - Dòng không có ` :: ` → bỏ qua dòng đó, KHÔNG báo lỗi cho user.
3. Chấm điểm từng file:
   - Điểm = số từ khoá của file xuất hiện trong message user.
   - So khớp lowercase, không phân biệt dấu câu.
   - Chọn file điểm cao nhất.
   - Bằng điểm → chọn file xuất hiện trước trong `INDEX.md`.
   - Điểm 0 → **KB miss**.
4. `read skills/interlink-knowledge/kb/<file>`.
   - Đọc ĐÚNG 1 file.
   - KHÔNG đọc file khác.
   - KHÔNG đọc file tên bắt đầu `_`.
5. Trong file KB, chọn khối `## ...` có nhiều từ khoá `TRIGGER:` khớp message nhất.
   - Không khối nào khớp → dùng khối đầu tiên của file nếu message khớp ≥2 từ khoá `INDEX` của file đó.
   - Ngược lại → **KB miss**.
6. KB miss → đọc `skills/support-handoff/SKILL.md` và chuyển HANDOFF.

## Luật soạn câu trả lời từ KB

- Chỉ dùng dữ kiện trong `ANSWER:` của khối đã chọn.
- Có thể dùng nguyên văn URL trong `LINKS:` nếu khối có `LINKS:`.
- Được rút gọn, sắp xếp lại thành các bước, dịch sang ngôn ngữ user theo mục "Ngôn ngữ" của `AGENTS.md`.
- **CẤM** thêm dữ kiện / bước / thời hạn / số liệu không có trong khối.
- **CẤM** đoán nguyên nhân.
- **CẤM** nói về file / KB / skill / hệ thống nội bộ.
- **CẤM** chain-of-thought.
- Giữ nguyên URL và tên sản phẩm: Interlink, ITLG, ITL, HCS, HHP, KYC.
- Giữ nguyên Telegram handle nếu có.
- Reply ≤ 1200 ký tự.

## Chặn nội dung xấu trong KB

Nếu khối đã chọn chứa bất kỳ nội dung nào dưới đây → **KHÔNG dùng khối đó**, xử lý như KB miss:

- Dự đoán giá / ROI / lợi nhuận token.
- Công thức HCS.
- Yêu cầu seed phrase / private key / mật khẩu.

Luôn giữ nguyên luật `⛔ KHÔNG dự đoán giá / ROI` và `KHÔNG public công thức HCS` của `AGENTS.md`.

## Kết thúc turn khi trả lời từ KB

Sau khi trả lời từ KB, ghi `memory/contexts/{uid}.json`:

```json
{
  "last_matched_section": "kb/<file>#<tên khối>",
  "status": "pending",
  "last_bot_action": "<1 câu mô tả đã hướng dẫn gì>",
  "issue": "<cập nhật nếu chưa có>",
  "issue_started_at": "<iso nếu vừa tạo issue mới>",
  "thread": [
    {"r":"u","t":"<≤160 ký tự>","at":"<iso>"},
    {"r":"b","t":"<≤160 ký tự>","at":"<iso>"}
  ],
  "updated_at": "<iso>"
}
```

`thread` phải theo luật tại `AGENTS.md` mục `Kết thúc turn`.

## Follow-up sau câu trả lời KB

- Nếu lượt sau user báo vẫn chưa được / vẫn lỗi / khớp `ESCALATE_IF:` của khối đã dùng → chuyển HANDOFF ngay, KHÔNG lặp lại cùng khối.
- Nếu user cảm ơn (`thanks`, `cảm ơn`, `ok`) → `You're welcome` (dịch theo ngôn ngữ user), set `status: "resolved"`.
