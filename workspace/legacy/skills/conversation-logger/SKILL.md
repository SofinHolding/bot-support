---
name: conversation-logger
description: >
  Tự động ghi lại các cuộc trò chuyện hỗ trợ khách hàng. Kích hoạt SAU MỖI cuộc hội thoại hỗ trợ với user thường (không phải admin). Lưu Q&A vào file memory để phục vụ tra cứu và cải thiện chất lượng trả lời trong tương lai.
---

# Conversation Logger Skill

Skill này hướng dẫn bot **tự động ghi lại** các cuộc trò chuyện với khách hàng để tham khảo sau này.

## Khi nào kích hoạt?

- **SAU MỖI cuộc hội thoại hỗ trợ** với user thường (không phải admin Anh Phi)
- Khi cuộc hội thoại kết thúc tự nhiên (user cảm ơn, không hỏi thêm, hoặc im lặng)
- Khi bot đã giải quyết xong vấn đề của user

## Ghi vào đâu?

Ghi vào file: `memory/conversations/YYYY-MM.md` (nhóm theo tháng)

Nếu thư mục `memory/conversations/` chưa tồn tại → tạo mới.

## Format ghi log

Mỗi cuộc hội thoại ghi theo format sau:

```markdown
### [HH:MM] @username — Chủ đề ngắn gọn

- **Vấn đề**: Mô tả ngắn vấn đề user hỏi
- **Phân loại**: [FAQ / Bug / Account / Game / Wallet / HCS / Burn / Mining / Other]
- **Mã lỗi** (nếu có): M01 / S02 / G03 / ...
- **Ngôn ngữ**: EN / VI
- **Đã giải quyết**: ✅ Có / ❌ Chưa / ⏳ Đang chờ (cần escalate)
- **Tóm tắt trao đổi**:
  - User: [câu hỏi chính]
  - Bot: [câu trả lời chính]
  - (thêm lượt nếu có nhiều trao đổi)
- **Ghi chú**: (nếu có gì đặc biệt — câu hỏi mới chưa có trong skill, user phản hồi tiêu cực, cần cập nhật skill, v.v.)

---
```

## Ví dụ

```markdown
### [14:32] @user123 — ITLG bị giảm

- **Vấn đề**: User báo ITLG giảm từ 5000 xuống 3500
- **Phân loại**: Burn
- **Mã lỗi**: M02
- **Ngôn ngữ**: VI
- **Đã giải quyết**: ✅ Có
- **Tóm tắt trao đổi**:
  - User: "ITLG tôi bị giảm 1500, tại sao?"
  - Bot: Giải thích cơ chế burn do referral inactive. Hướng dẫn cách khôi phục.
  - User: "Cảm ơn"
- **Ghi chú**: Không có

---

### [15:10] @newbie_xyz — How to sign up

- **Vấn đề**: User mới muốn đăng ký
- **Phân loại**: FAQ
- **Ngôn ngữ**: EN
- **Đã giải quyết**: ✅ Có
- **Tóm tắt trao đổi**:
  - User: "How do I create an account?"
  - Bot: Hướng dẫn 4 bước đăng ký + gửi mã referral
- **Ghi chú**: Không có

---
```

## Quy tắc ghi log

1. **LUÔN ghi log** sau mỗi cuộc hội thoại hỗ trợ, dù ngắn hay dài.
2. **Tóm tắt, không copy nguyên văn** — viết ngắn gọn, nắm ý chính.
3. **Ghi chú đặc biệt** khi:
   - User hỏi câu hỏi **CHƯA CÓ trong skill** → đánh dấu `⚠️ CÂU HỎI MỚI` để admin review và cập nhật skill sau.
   - User **không hài lòng** với câu trả lời → ghi rõ lý do.
   - Cần **escalate** cho dev/PIC → ghi rõ chuyển ai.
   - Bot **không chắc chắn** với câu trả lời → ghi `⚠️ CẦN XÁC NHẬN`.
4. **Phân loại chính xác** để dễ thống kê sau này.
5. **Bảo mật**: KHÔNG ghi Interlink ID, mật khẩu, seedphrase, hoặc thông tin nhạy cảm của user. Chỉ ghi @username Telegram.
6. **Ghi log sự kiện spam/chặn**: Khi user bị cảnh báo hoặc chặn do off-topic/spam, ghi log với:
   - **Phân loại**: `Spam / Off-topic`
   - **Ghi chú**: ghi rõ cấp cảnh báo (lần mấy), thời gian chặn, và nội dung off-topic (tóm tắt ngắn, KHÔNG copy nguyên văn nếu nội dung nhạy cảm)
   - **Đã giải quyết**: `🚫 Chặn [X phút/giờ]` hoặc `⚠️ Cảnh cáo`
7. **Ghi log mở chặn**: Khi user được tự động mở chặn, ghi ngắn: *"User @username — Tự động mở chặn sau [X phút/giờ]"*

## Tổng hợp hàng tuần (Heartbeat task)

Khi chạy heartbeat, nếu là đầu tuần (thứ Hai):
1. Đọc file log tháng hiện tại `memory/conversations/YYYY-MM.md`
2. Tổng hợp thống kê ngắn vào `memory/YYYY-MM-DD.md`:
   - Tổng số cuộc hội thoại tuần qua
   - Top 3 vấn đề phổ biến nhất
   - Số câu hỏi mới chưa có trong skill (⚠️)
   - Số case chưa giải quyết (❌/⏳)
3. Nếu có nhiều câu hỏi mới → thông báo admin để cập nhật skill

## Cách dùng log cho tương lai

- Khi gặp câu hỏi tương tự → đọc log cũ để xem đã trả lời thế nào
- Khi admin yêu cầu thống kê → tổng hợp từ file log
- Khi cần cập nhật skill → xem các mục `⚠️ CÂU HỎI MỚI` trong log
- Khi user quay lại hỏi tiếp → tìm log trước đó theo @username
