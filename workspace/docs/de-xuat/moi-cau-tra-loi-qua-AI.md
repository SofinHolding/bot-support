# Đề xuất sửa "Hướng dẫn AI làm việc": mọi câu trả lời đều qua AI; mất kết nối thì báo bằng tiếng Anh

Code đã làm theo quy tắc này (commit "every answer goes through an AI SKILL"). "Hướng dẫn AI làm việc" hiện còn 4 chỗ mô tả
hành vi cũ, cần sửa cho khớp. Đây là nội dung ràng buộc nên phải qua **duyệt hai người**: Admin Web → Kho tri thức →
"Hướng dẫn AI làm việc" → sửa → gửi duyệt. Nên gửi cùng đợt với đề xuất hỏi lại khách (`hoi-lai-khach-CLARIFY.md`).

## Quy tắc

- Không có đường nào gửi thẳng nội dung trong kho cho khách: mọi câu trả lời phải được một SKILL AI đánh giá trong chính lượt
  đó (verify-answer ở FAST PATH, select-answer ở nhánh AI/RAG), rồi dịch sang ngôn ngữ của khách.
- Mất kết nối LLM, LLM quá tải, chưa cấu hình, hoặc khách hết ngân sách token: gửi đúng một câu cố định bằng tiếng Anh, ghi
  trong mã nguồn:
  > ⚠️ Network disconnected: our support system cannot connect to its AI service right now, so your message could not be processed. Please try again in a few minutes. If the issue persists, please contact @interlink_technicalsupport.
- Ngoại lệ do code xử lý, chạy cả khi mất kết nối, luôn bằng tiếng Anh: cảnh báo lộ seed phrase / private key, cảnh báo và
  chặn chống spam. Nội dung là bản đã duyệt; bản mặc định chép nguyên văn trong mã nguồn.
- Chế độ `code_first` (trả lời bằng từ khoá không qua AI) và cài đặt tắt bước AI xác nhận (`router.fast_verify`) đã bị bỏ.

## Các chỗ cần sửa

**1. Bảng xử lý tình huống — dòng "AI lỗi hoặc quá tải"**

Hiện tại:
> | AI lỗi hoặc quá tải | Câu "hệ thống đang bận" cố định; không đoán |

Đề xuất:
> | Mất kết nối AI, AI quá tải hoặc chưa cấu hình | Câu báo mất kết nối cố định bằng tiếng Anh **[CODE]**; không gửi bất kỳ nội dung nào lấy từ kho; không đoán |

**2. Quy trình — bước 2**

Hiện tại:
> 2. **An toàn trước tiên:** kiểm tra lộ seed/private key → cảnh báo cố định; kiểm tra khách có đang bị chặn vì spam **[CODE]**.

Đề xuất:
> 2. **An toàn trước tiên:** kiểm tra lộ seed/private key → cảnh báo cố định; kiểm tra khách có đang bị chặn vì spam **[CODE]**. Các cảnh báo này và cảnh báo chống spam luôn gửi bằng tiếng Anh, vẫn chạy khi mất kết nối AI **[CODE]**.

**3. Quy trình — bước 5, FAST PATH**

Hiện tại:
> - **FAST PATH:** chỉ khi câu đã chuẩn hoá khớp CHẮC CHẮN bằng luật, điều kiện, hoặc từ khoá mà cụm khớp chiếm từ một nửa nội dung câu hỏi. Không thêm lời gọi AI.

Đề xuất:
> - **FAST PATH:** chỉ khi câu đã chuẩn hoá khớp CHẮC CHẮN bằng luật, điều kiện, hoặc từ khoá mà cụm khớp chiếm từ một nửa nội dung câu hỏi. Câu trả lời vẫn phải được AI xác nhận là trả lời đúng tin của khách trước khi gửi **[AI]**; không xác nhận thì sang nhánh AI/RAG **[CODE]**.

**4. Đoạn cuối phần Quy trình**

Hiện tại:
> Khi AI không dùng được (chưa cấu hình, quá tải): hệ thống tự chuyển sang khớp bằng luật và từ khoá; câu không khớp chắc chắn thì chuyển nhân viên. Không bao giờ đoán.

Đề xuất:
> Khi AI không dùng được (mất kết nối, quá tải, chưa cấu hình): hệ thống **không** trả lời bằng khớp luật hay từ khoá; khách nhận câu báo mất kết nối cố định bằng tiếng Anh **[CODE]**. Không bao giờ gửi nội dung trong kho mà chưa qua AI đánh giá. Không bao giờ đoán.
