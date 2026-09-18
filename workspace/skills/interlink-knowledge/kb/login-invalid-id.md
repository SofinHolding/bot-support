# Đăng nhập báo Invalid ID / không vào được ID
UPDATED: 2026-09-18
OWNER: admin

## ID bắt đầu bằng số 0 nên báo Invalid ID
TRIGGER: invalid id, id không hợp lệ, id sai, không đăng nhập được, id bắt đầu bằng 0, id starts with 0
ANSWER:
- Nếu InterLink ID của bạn bắt đầu bằng số 0, hãy bỏ số 0 ở đầu khi nhập ID để đăng nhập.
- Nhập lại ID (đã bỏ số 0 đầu) cùng passcode 6 số và thử đăng nhập lại.
ESCALATE_IF: user báo đã bỏ số 0 đầu mà vẫn báo Invalid ID

## Khuôn mặt đã dùng cho account khác
TRIGGER: 2 account cùng mặt, face verify 2 account, verify account thứ 2, same face two accounts
ANSWER:
- Mỗi khuôn mặt chỉ được xác minh cho 1 account. Account thứ hai dùng cùng khuôn mặt sẽ bị hệ thống đánh dấu.
- Hãy đăng nhập lại bằng đúng account đã xác minh khuôn mặt đó.
ESCALATE_IF: user cho biết account đã xác minh trước đó cũng không vào được
