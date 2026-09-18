# KYC — tài liệu cần chuẩn bị theo từng level
UPDATED: 2026-09-18
OWNER: admin

## Level 1 cần gì
TRIGGER: kyc level 1, level 1 cần gì, document level 1, giấy tờ level 1
ANSWER:
- Level 1: ảnh mặt trước và mặt sau giấy tờ tuỳ thân (Identity Card / Driver License / Passport / Birth Certificate).
- Sau khi curator chọn ID của bạn, bạn có 24 giờ để nộp tài liệu.
ESCALATE_IF: user đã nộp nhưng app không nhận tài liệu

## Level 2 cần gì
TRIGGER: kyc level 2, level 2 cần gì, portrait kyc, ảnh chân dung kyc
ANSWER:
- Level 2: ảnh chân dung của bạn kèm một tờ giấy ghi "Interlink" và ngày hôm nay, cùng ảnh mặt trước giấy tờ tuỳ thân.
ESCALATE_IF: user đã nộp đúng nhưng bị từ chối không rõ lý do

## Level 3 cần gì
TRIGGER: kyc level 3, level 3 cần gì
ANSWER:
- Level 3: ảnh chân dung của bạn cầm điện thoại hiển thị màn hình Home của app InterLink kèm số dư ITLG.
ESCALATE_IF: user đã nộp đúng nhưng bị từ chối không rõ lý do

## KYC bị Failed thì làm gì
TRIGGER: kyc failed, kyc bị từ chối, kyc không đạt, kyc rejected
ANSWER:
- Kết quả KYC là Passed hoặc Failed; nếu Failed, hệ thống có kèm lý do.
- Hãy khắc phục theo lý do được ghi, sau đó match Curator lại và nộp lại tài liệu.
- Thông tin nhạy cảm trong tài liệu được hệ thống tự động che (auto-redact).
ESCALATE_IF: user không thấy lý do Failed hoặc không match lại được curator
