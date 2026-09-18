# App chậm / lag / số dư chưa cập nhật
UPDATED: 2026-09-18
OWNER: admin

## Mining lag vào giờ cao điểm
TRIGGER: mining lag, app lag, app chậm, giật lag, peak hours, giờ cao điểm
ANSWER:
- Khung 19h–23h (UTC+7) là giờ cao điểm, hệ thống đông người nên mining có thể bị lag.
- Hãy thử lại sau giờ cao điểm; thao tác mining của bạn không bị mất.
ESCALATE_IF: user báo lag kèm mất ITLG hoặc lỗi hiển thị ngoài giờ cao điểm

## Số dư ví hiển thị chậm
TRIGGER: balance chưa cập nhật, số dư chưa hiện, wallet loading, load balance slow
ANSWER:
- Số dư ví có thể mất khoảng 2–5 phút để tải xong.
- Hãy đợi 2–5 phút rồi mở lại màn hình ví.
ESCALATE_IF: sau 5 phút số dư vẫn không hiển thị
