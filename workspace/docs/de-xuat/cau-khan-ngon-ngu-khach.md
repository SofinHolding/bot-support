# Đề xuất sửa "Hướng dẫn AI làm việc": câu khẩn bằng ngôn ngữ của khách

- Lý do: quyết định của owner QĐ1 (mọi câu gửi khách bằng ngôn ngữ của khách) và QĐ3 (câu khẩn chỉ qua bước AI dịch).
  Code đã đổi ở `ResponseResolver.forUrgent` (`src/bot/resolver.ts`), `src/bot/pipeline.ts`, job `prewarm-urgent-translations`.
- Cách áp dụng: Admin Web → Kho tri thức → "Hướng dẫn AI làm việc" → sửa các câu dưới đây → Publish **cùng lúc** với bản code này.
  File `content/guide/agent-guide.md` chỉ là bản nạp lần đầu; bản đang chạy nằm trong DB.

## Mục 3 — Cách giao tiếp

Cũ:
> - **Lỗi kỹ thuật của bot hoặc mất kết nối AI:** không bao giờ hiển thị lỗi kỹ thuật cho khách; gửi câu báo mất kết nối cố định bằng tiếng Anh **[CODE]**. Không gửi bất kỳ nội dung nào lấy từ kho khi AI chưa đánh giá.

Mới:
> - **Lỗi kỹ thuật của bot hoặc mất kết nối AI:** không bao giờ hiển thị lỗi kỹ thuật cho khách; gửi câu báo mất kết nối đã duyệt, bằng ngôn ngữ của khách từ bản dịch sẵn (chưa có bản dịch sẵn thì bản gốc tiếng Anh) **[CODE]**. Không gửi bất kỳ nội dung nào lấy từ kho khi AI chưa đánh giá.

## Mục 5 — Yêu cầu và giới hạn (bảng "Điều kiện giới hạn")

Cũ:
> | Không dịch được trung thành sang ngôn ngữ của khách | AI dịch lại kèm danh sách lỗi, tối đa 3 lần **[CODE]**; vẫn không đạt thì chuyển nhân viên, không gửi bản ngôn ngữ khác thay. Riêng câu chuyển nhân viên dịch không đạt: gửi bản gốc tiếng Anh của câu đó để khách vẫn biết liên hệ ai **[CODE]** |
> | Mất kết nối AI, AI quá tải hoặc chưa cấu hình | Câu báo mất kết nối cố định bằng tiếng Anh **[CODE]**; không gửi bất kỳ nội dung nào lấy từ kho; không đoán |

Mới:
> | Không dịch được trung thành sang ngôn ngữ của khách | AI dịch lại kèm danh sách lỗi, tối đa 3 lần **[CODE]**; vẫn không đạt thì chuyển nhân viên, không gửi bản ngôn ngữ khác thay. Câu chuyển nhân viên dùng bản dịch sẵn; chỉ khi chưa có bản dịch sẵn và AI cũng không dịch được mới gửi bản gốc tiếng Anh để khách vẫn biết liên hệ ai **[CODE]** |
> | Mất kết nối AI, AI quá tải hoặc chưa cấu hình | Câu báo mất kết nối đã duyệt, bằng ngôn ngữ của khách từ bản dịch sẵn **[CODE]**; không gửi bất kỳ nội dung nào lấy từ kho; không đoán |

## Mục 6 — Quy trình, bước 2

Cũ:
> 2. **An toàn trước tiên:** kiểm tra lộ seed/private key → cảnh báo cố định; kiểm tra khách có đang bị chặn vì spam **[CODE]**. Các cảnh báo này và cảnh báo chống spam luôn gửi bằng tiếng Anh, vẫn chạy khi mất kết nối AI **[CODE]**.

Mới:
> 2. **An toàn trước tiên:** kiểm tra lộ seed/private key → cảnh báo đã duyệt; kiểm tra khách có đang bị chặn vì spam **[CODE]**. Các cảnh báo này là "câu khẩn": chỉ qua bước AI dịch sang ngôn ngữ của khách (bản dịch sẵn, hoặc dịch tại chỗ với thời gian chờ ngắn), vẫn gửi được khi mất kết nối AI **[CODE]**. Tin có seed/private key không bao giờ được gửi cho AI, kể cả để dịch **[CODE]**.

## Đoạn cuối mục 6

Cũ:
> Khi AI không dùng được (mất kết nối, quá tải, chưa cấu hình): hệ thống **không** trả lời bằng khớp luật hay từ khoá; khách nhận câu báo mất kết nối cố định bằng tiếng Anh **[CODE]**.

Mới:
> Khi AI không dùng được (mất kết nối, quá tải, chưa cấu hình): hệ thống **không** trả lời bằng khớp luật hay từ khoá; khách nhận câu báo mất kết nối đã duyệt bằng ngôn ngữ của khách (bản dịch sẵn) **[CODE]**.
