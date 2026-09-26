# Đề xuất sửa nội dung: khối tóm tắt gửi support và mã tham chiếu

- Lý do: memory giai đoạn 3 (huong-dan-memory v3 mục 7). Code: `src/core/handoff.ts`, `src/bot/pipeline.ts` › `buildSupportSummaryVar`.
- Cách áp dụng: sửa trên Admin Web và publish **cùng lúc** với bản code này. File trong `content/` chỉ là bản nạp lần đầu.

## 1. Template `fp-12-escalate` (Kho tri thức → nội dung chứa câu chuyển nhân viên)

Bản code mới gửi khối tóm tắt thành **tin riêng** và điền mã tham chiếu vào biến `{REF}`. Bản đang chạy trong DB vẫn có
`{SUPPORT_SUMMARY}` ở cuối: code điền biến này bằng rỗng nên không lỗi, nhưng khách **không thấy mã tham chiếu** cho tới khi
sửa câu như sau.

Cũ:
> Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance.{SUPPORT_SUMMARY}

Mới:
> Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance. Your reference code: {REF}

Bản dịch đã lưu của câu cũ tự bị thay (hash bản gốc đổi); job `prewarm-urgent-translations` dịch lại trong vòng một giờ.

## 2. "Hướng dẫn AI làm việc" mục 2 — đoạn cuối

Cũ:
> Khi chuyển nhân viên trong một vụ việc đang mở, câu chuyển nhân viên kèm **khối tóm tắt vụ việc** để khách bấm sao chép và gửi cho `@interlink_technicalsupport`: vấn đề, điều khách đã báo (giữ nguyên mã lỗi, số liệu), các hướng dẫn bot đã gửi, điểm còn chưa giải quyết. Khối này do code dựng từ tóm tắt vụ việc, không chứa ID, email, mật khẩu, seed phrase **[CODE]**; AI kiểm tra nội dung khớp nguồn và không vi phạm giới hạn nghiệp vụ **[AI]**, rồi dịch sang ngôn ngữ của khách như mọi nội dung khác. Không đạt ở bước nào thì bỏ khối này, câu chuyển nhân viên vẫn được gửi **[CODE]**.

Mới:
> Mỗi vụ việc có một **mã tham chiếu** (dạng EP-XXXXX); câu chuyển nhân viên luôn kèm mã này để nhân viên tra lại toàn bộ vụ việc **[CODE]**. Sau câu chuyển nhân viên, bot gửi thêm một tin riêng là **khối tóm tắt vụ việc** (khách chạm để sao chép và gửi cho `@interlink_technicalsupport`): mã tham chiếu, vấn đề, điều khách đã báo (giữ nguyên mã lỗi, số liệu), các hướng dẫn bot đã gửi kèm kết quả (được / chưa được), điểm còn chưa giải quyết, lý do chuyển. Khối chỉ nói về vụ việc hiện tại, tính từ lúc khách nêu vấn đề; hướng dẫn đã gửi được ghi bằng nhãn đã duyệt, không phải chữ AI viết **[CODE]**. Khối không chứa ID, email, mật khẩu, seed phrase **[CODE]**; AI kiểm tra nội dung khớp nguồn và không vi phạm giới hạn nghiệp vụ **[AI]**, rồi dịch sang ngôn ngữ của khách như mọi nội dung khác. Bản đầy đủ không đạt thì thử bản rút gọn (bỏ phần tóm tắt do AI viết); vẫn không đạt thì không gửi khối, câu chuyển nhân viên (có mã tham chiếu) vẫn được gửi **[CODE]**.

## 3. Nhãn cho nhân viên (`staff_label`) — tuỳ chọn, làm dần

Mỗi câu trả lời / mỗi bước của mục hỏi đáp có thể thêm `staff_label`: một dòng tiếng Anh ≤ 90 ký tự, không link, không số
ngoài câu trả lời (kiểm khi publish). Chưa có nhãn thì khối dùng tên mục / câu hỏi mẫu tiếng Anh; không có gì phù hợp thì ghi
"Approved answer <mã>". Ví dụ trong YAML mục hỏi đáp:

```yaml
steps:
  - say: "Internal transfers usually complete within 15-30 minutes."
    staff_label: "Internal transfer processing time (15-30 minutes)"
```
