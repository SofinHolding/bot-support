---
name: whitepaper-sync
description: >
  Daily sync và lưu trữ nội dung từ InterLink Whitepaper (https://whitepaper.interlinklabs.ai). Chạy tự động lúc 3:00 AM hàng ngày qua cron. Dùng để trả lời câu hỏi về token, tokenomics, technical, vision, roadmap từ whitepaper chính thức.
---

# Whitepaper Sync Skill

Skill này quy định cách bot **tự động tổng hợp nội dung** từ Interlink Whitepaper và lưu thành dữ liệu hỗ trợ khách hàng.

## Nguồn dữ liệu

Các trang whitepaper cần sync (tất cả thuộc `https://whitepaper.interlinklabs.ai`):

| Trang | URL |
|-------|-----|
| InterLink Token ($ITL) | `/interlink-token-usditl` |
| InterLink Genesis Token ($ITLG) | `/interlink-genesis-token-usditlg` |
| InterLink Token And InterLink Genesis | `/interlink-token-and-interlink-genesis` |
| ITL - The Human Currency | `/itl-the-human-currency-of-global-payments` |
| Token Mining Mechanism | `/token-mining-mechanism-and-sustainability` |
| FAQ | `/faq` |
| Tokenomics Introducing | `/interlink-tokenomics/introducing` |

## Lịch chạy

- **Cron**: Hàng ngày lúc **3:00 AM UTC+7** (20:00 UTC ngày trước)
- Cron job ID: `whitepaper-daily-sync`

## Quy trình sync (Bot thực hiện khi cron kích hoạt)

1. **Đọc dữ liệu hiện tại**: Đọc `memory/whitepaper-data.md` trước để biết nội dung đã lưu
2. **Fetch từ web**: Dùng `web_fetch` để đọc từng trang whitepaper trong danh sách
3. **So sánh — CHỈ LẤY CÁI MỚI**:
   - So sánh nội dung vừa fetch với dữ liệu đã lưu trong `memory/whitepaper-data.md`
   - **BỎ QUA** mọi nội dung đã tồn tại trong file — KHÔNG ghi lại thông tin cũ
   - **CHỈ GHI** những nội dung MỚI hoặc ĐÃ THAY ĐỔI so với bản đã lưu
4. **Nếu có nội dung mới/thay đổi**:
   - Append nội dung mới vào đúng section trong `memory/whitepaper-data.md`
   - Cập nhật dòng "Last synced" ở đầu file
   - **⛔ KHÔNG tạo file `memory/YYYY-MM-DD.md`** — daily memory files đã bị bỏ. Chỉ append vào `whitepaper-data.md`.
   - Nếu thay đổi lớn → thông báo admin qua channel cố định.
5. **Nếu KHÔNG có gì mới** → chỉ cập nhật "Last synced" date. KHÔNG tạo daily log file.

> ⚠️ **NGUYÊN TẮC QUAN TRỌNG**: KHÔNG bao giờ ghi đè toàn bộ file. Chỉ thêm/sửa phần mới. Tiết kiệm token và tránh mất dữ liệu đã có.

## Cách dùng dữ liệu

- Khi user hỏi về $ITL, $ITLG, tokenomics, mining mechanism, v.v. → đọc `memory/whitepaper-data.md`
- Kết hợp với skill `interlink-support` để trả lời đầy đủ
- Luôn trích dẫn nguồn: "According to the InterLink Whitepaper..."

## Response rules khi trả lời từ whitepaper

1. **Chính xác**: Trả lời đúng theo nội dung whitepaper, KHÔNG suy diễn
2. **Trích nguồn**: Gửi kèm link whitepaper cho user tham khảo thêm
3. **Không dự đoán giá**: KHÔNG bao giờ dự đoán giá token, ROI, hay lợi nhuận
4. **Disclaimer**: Khi nói về token/đầu tư, nhắc user đọc disclaimer trên whitepaper
