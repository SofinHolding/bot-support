# Hướng dẫn sử dụng Admin Web cho người vận hành

Tài liệu này dành cho quản trị viên không phải lập trình viên. Nó mô tả từng mục trên Admin Web: mục đó để làm gì, thao tác ra sao, và điều gì xảy ra với bot sau khi thao tác.

Nguyên tắc chung của hệ thống, cần nắm trước khi đọc:

- **Bot chỉ gửi nội dung đã được duyệt hoặc được viết từ nội dung đã duyệt.** Với tình huống hỗ trợ, AI chọn câu trả lời có sẵn và dịch trung thành. Với câu hỏi về dự án, AI viết câu trả lời từ đoạn tài liệu đã chọn, không được thêm số liệu hay dữ kiện ngoài tài liệu.
- **Mọi thứ AI làm đều bị code kiểm lại** (số liệu, link, ngôn ngữ, lựa chọn có nằm trong danh sách không). Không đạt thì chuyển nhân viên, không đoán.
- **Nội dung có phiên bản.** Sửa gì cũng qua Draft → Kiểm tra → Publish, có rollback. Bot nạp bản mới trong vài giây, không cần khởi động lại.

---

## 1. Kho tri thức

Nơi **duy nhất** quản lý nội dung của bot. Bạn chỉ đưa nội dung vào; hệ thống tự phân tích, tự sắp xếp, tự so với dữ liệu đang
có và chỉ hỏi bạn những chỗ cần quyết. Không cần biết Markdown, YAML, "template" hay "knowledge". Có năm tab.

### 1.1 Nội dung

Toàn bộ nội dung bot đang dùng:

- **Câu trả lời**, gom theo chủ đề (Tài khoản, KYC, ITLG, Ví…). Mỗi câu trả lời có các cách khách hay hỏi và câu bot trả lời
  (có thể nhiều bước: khách nói "vẫn chưa được" thì bot gửi bước tiếp theo). Nhãn "dữ liệu cũ" = nội dung từ hệ thống cũ,
  chưa được chuyển sang cấu trúc mới.
- **Tài liệu tham khảo** (Whitepaper, Infrastructure, Ambassador…), chia theo từng đoạn. Bot trích đúng đoạn trả lời câu hỏi.

Ô **Thử hỏi bot**: gõ một câu khách có thể hỏi, xem bot sẽ trả lời bằng nội dung nào (không tốn phí AI). Ô lọc giúp tìm nhanh.

Bấm vào một nội dung để xem đầy đủ, các xung đột đang mở với nội dung khác, và:
- **Sửa nội dung**: nội dung đang dùng được điền sẵn; sửa trực tiếp rồi bấm phân tích. Hệ thống tạo bản nháp, so với bản đang
  dùng và kiểm tra lại. Khách chưa thấy gì thay đổi cho tới khi publish.
- **Lịch sử phiên bản**: các phiên bản trước, **Rollback** về bản cũ.

Tin hệ thống (cảnh báo bảo mật, chống spam…) do code gửi, nội dung khoá, không sửa ở đây.

### 1.2 Thêm nội dung

1. Dán văn bản tự do hoặc kéo-thả tệp (.txt, .pdf, .doc, .docx, .xlsx): câu trả lời hỗ trợ, ghi chú, FAQ, tài liệu…
2. Bấm **Phân tích & tạo bản nháp**. Hệ thống:
   - tự quyết là câu trả lời hay tài liệu tham khảo, tự xếp chủ đề;
   - tự tạo các cách hỏi, bỏ từ khoá một từ (loại gây trả lời nhầm);
   - tự so với nội dung đang có: trùng, bổ sung, khác phạm vi, mâu thuẫn, bot sẽ trả lời nhầm…;
   - chạy 6 bước kiểm tra: cấu trúc, an toàn (seed phrase, script, link lạ), trùng và mâu thuẫn, bản dịch, hồi quy trên bộ câu
     hỏi mẫu, chạy lại tin nhắn thật 14 ngày qua.
3. Màn hình kết quả hiện **nội dung của bản nháp** (mới / thay đổi / giữ nguyên) và các **khung cần bạn quyết**. Mỗi khung là
   một nội dung đang có bị trùng hoặc mâu thuẫn; mở khung để xem gợi ý của AI và chọn cách xử lý.
4. Bản nháp có **lỗi chặn** thì chưa publish được. Xung đột dữ liệu phải xử lý xong trước khi áp dụng: hai nội dung dễ lẫn phải
   được phân biệt, nội dung giành câu hỏi của tài liệu phải được ghi nhận có chủ ý...
5. Bấm **Publish tất cả**. Bot dùng ngay; nội dung có luật bảo mật cần người thứ hai duyệt (mục 3).

Không tạo được "Hướng dẫn AI làm việc" qua đường này.

### 1.3 Chờ xử lý

- Các bản nháp chưa publish: đạt / chưa đạt kiểm tra, đang chờ người thứ hai duyệt. Mở một bản để xem nội dung, báo cáo, thử hỏi
  bot trên bản nháp, rồi Publish.
- **Nhập file rà soát khách hàng trả về (.xlsx)**: quyết định của khách (giữ / gộp / sửa / thêm cách hỏi) được áp vào bản nháp,
  không publish.
- **Kiểm tra bot có trả lời nhầm không** (toàn kho): liệt kê các cặp nội dung bot có thể lẫn, AI phân loại từng cặp.

### 1.4 Hướng dẫn AI làm việc

Một tài liệu duy nhất, sáu mục bắt buộc (Giới thiệu, Nhiệm vụ, Cách giao tiếp, Mục tiêu, Yêu cầu và giới hạn, Quy trình). Đây là cách người vận hành nói cho AI biết doanh nghiệp là ai, phục vụ ai, được làm gì và không được làm gì.

- Mỗi việc của AI chỉ nhận các mục liên quan: hiểu câu hỏi (mục 1, 2), chọn câu trả lời (1, 2, 5), kiểm duyệt (5), tóm tắt (1, 4), dịch (3).
- Tài liệu này là **bối cảnh**, không thay được luật do code cưỡng chế (bảo mật, chống spam, ngôn ngữ, kiểm tra đầu ra). Bước Kiểm tra sẽ chặn nếu tài liệu có câu cho phép điều hệ thống cấm (dự đoán giá, lộ công thức HCS, xin seed phrase, dùng kiến thức chung, bỏ qua luật).
- Đây là tài liệu duy nhất còn soạn trực tiếp; **Publish cần một quản trị viên khác duyệt** (xem mục 3) khi cài đặt "Cần người thứ hai duyệt" đang bật.
- Nếu chưa có hoặc đọc lỗi, AI vẫn chạy với luật cố định của hệ thống.

### 1.5 SKILL AI

Mỗi bước AI làm (hiểu câu hỏi, chọn câu trả lời, kiểm duyệt, dịch câu hỏi, dịch câu trả lời, phân tích nội dung mới, so sánh cặp nội dung…) có một **SKILL**: file chỉ dẫn gồm frontmatter, mục `## Requirements` (các yêu cầu R1, R2…) và `## Output`. Tab này hiển thị toàn bộ SKILL đang dùng; sửa và gửi duyệt. Hệ thống kiểm tra cấu trúc trước khi nhận. **Về bản mặc định** quay lại file gốc của dự án.

Lưu ý: SKILL thay đổi cách AI làm việc, nhưng các kiểm tra bằng code (số liệu, link, ngôn ngữ, chỉ được chọn trong danh sách) vẫn áp dụng dù SKILL viết gì.

### 1.6 Bot dùng nội dung thế nào

- **Mọi câu trả lời lấy từ kho đều qua AI đánh giá** trong chính lượt đó rồi được dịch sang ngôn ngữ của khách. Khớp chắc
  chắn bằng cụm từ thì AI xác nhận; còn lại AI chọn trong các nội dung gần nghĩa nhất. Không nội dung nào đúng thì chuyển nhân viên.
- **Mất kết nối AI** (hoặc AI quá tải, chưa cấu hình): khách nhận một câu cố định bằng tiếng Anh báo mất kết nối. Bot không
  trả lời thẳng từ kho khi AI không đánh giá được.
- Cảnh báo lộ seed phrase / private key và cảnh báo chống spam do code gửi, luôn bằng tiếng Anh, chạy cả khi mất kết nối AI.

---

## 2. Bản dịch

Mục này là **bộ nhớ các bản dịch của template**, dành cho ngôn ngữ chưa có bản admin soạn sẵn.

Cách hoạt động: khách nhắn tiếng Đức, nội dung chỉ có tiếng Anh → AI dịch theo SKILL `translate-answer` (giữ nguyên số liệu, link, tên sản phẩm; không thêm bớt; không có chữ tiếng Việt khi khách không dùng tiếng Việt) → code kiểm lại (số liệu khớp, đúng ngôn ngữ đích, không sót tiếng Việt, link trong danh sách cho phép).

- Đạt: gửi cho khách và **lưu ở đây**. Những khách Đức sau đó nhận đúng bản đã lưu, không dịch lại.
- Không đạt: code gửi lại cho AI **danh sách lỗi** của bản vừa dịch để dịch lại, tối đa 3 lần.
- Vẫn không đạt: không gửi gì từ bản dịch đó, bot chuyển nhân viên. **Không có bản tiếng Anh dự phòng.**
- Mất kết nối AI: khách nhận câu báo mất kết nối cố định bằng tiếng Anh.

**Không cần duyệt bản dịch.** Quản trị viên có thể mở mục này để xem lại hoặc sửa cho tự nhiên hơn; bản sửa tay cũng phải qua đúng các kiểm tra trên mới được dùng. Khi nội dung gốc thay đổi, hệ thống tự dịch lại.

Mục này cũng chứa **bản dịch đoạn tri thức** (nhãn "đoạn tri thức (dịch)") và **câu AI viết từ tài liệu** (nhãn "câu AI viết từ tài liệu"): mọi nội dung AI đã dịch hoặc viết rồi gửi cho khách đều xem lại được ở đây.

---

## 3. Chờ duyệt

Nơi tập trung các thay đổi cần **người thứ hai** đồng ý mới có hiệu lực. Người đề xuất không tự duyệt được. Ba loại:

| Loại | Ai đề xuất | Ví dụ |
|---|---|---|
| Publish tài liệu nhạy cảm | Owner (luật bảo mật `SECURITY_RULE`), hoặc admin (Hướng dẫn AI làm việc) | Đổi câu cảnh báo lộ seed phrase; đổi cách AI phán đoán |
| Thay đổi quản trị viên | Admin/owner | Thêm, đổi quyền, gỡ một quản trị viên |
| Cấu hình được bảo vệ | Owner | Đổi bộ predicates (điều kiện dùng trong luật khớp), thêm host vào danh sách link cho phép |

Mỗi mục hiển thị nội dung trước/sau và người đề xuất. Bấm **Duyệt** để áp dụng ngay, **Từ chối** để huỷ (bản Draft chuyển sang trạng thái bị từ chối). Mọi thao tác ghi vào **Nhật ký**.

Để cơ chế này hoạt động, hệ thống cần **ít nhất hai** tài khoản quản trị. Nếu thấy bất tiện, owner tắt ở **Cấu hình → Duyệt → Cần người thứ hai duyệt thay đổi nhạy cảm**: khi tắt, người đề xuất có đủ quyền sẽ áp dụng ngay. Hệ thống cũ không có bước duyệt này (mọi người sửa thẳng file); nó được thêm ở bản xây lại để một tài khoản bị lộ không thể một mình đổi luật bảo mật.

---

## 4. Câu hỏi mẫu

Bộ câu hỏi có đáp án đúng, dùng làm **thước đo tự động**. Nó không dạy bot; nó phát hiện khi một thay đổi nội dung làm bot trả lời sai câu đang đúng.

### Chạy bộ câu hỏi mẫu

Bấm **Chạy**: mỗi câu được đưa qua tầng 0–1 (luật và từ khoá, không gọi AI). Kết quả hiện số câu đúng và bảng các câu sai gồm ba cột:

- **Câu hỏi**: câu của khách.
- **Kỳ vọng**: mã template mà bạn muốn bot chọn cho câu này (hoặc `ESCALATE` = mong bot chuyển nhân viên).
- **Bot chọn**: mã template bot thực sự chọn ở tầng 0–1, hoặc `ESCALATE`.

Một dòng như `when can I take my tokens out of the app?` · kỳ vọng `fp-2-withdraw` · bot chọn `ESCALATE` nghĩa là: câu này không trùng từ khoá nào của template rút tiền, nên tầng 0–1 chuyển nhân viên. Trên bot thật, câu này sẽ đi tiếp qua AI và thường được trả lời đúng (nếu AI không khả dụng, khách nhận câu báo mất kết nối, không nhận câu trả lời nào từ kho). Muốn câu này được tìm thấy chắc chắn hơn, mở nội dung "Rút tiền" ở Kho tri thức → **Sửa nội dung**, thêm câu đó vào phần "Khách hỏi" rồi Publish.

Bộ này cũng chạy tự động ở bước Kiểm tra mỗi khi tạo Draft: có câu đang đúng mà thành sai thì không cho Publish.

### Thêm câu mẫu

Ba ô:

- **Câu hỏi của khách**: nguyên văn câu khách hay nhắn, càng thật càng tốt.
- **Template id kỳ vọng**: chọn mã template mà câu này đáng lẽ phải nhận được (ô có gợi ý danh sách mã). **Không phải điền câu trả lời.** Câu trả lời đã nằm trong template; ở đây chỉ nói "câu này thuộc template nào". Để trống nghĩa là câu này **nên** bị chuyển nhân viên (câu ngoài kho, câu không được trả lời).
- **Loại ảnh**: chỉ chọn khi muốn giả lập khách gửi ảnh mà **không** có chữ. Các loại: `kyc_email` (ảnh email KYC), `kyc_queue_screen` (ảnh màn hình hàng chờ KYC), `error_dialog` (ảnh báo lỗi trong app), `app_screen` (ảnh màn hình app bình thường), `unrelated` (ảnh không liên quan). Bình thường để "Không ảnh".

**Đánh giá các câu sai bằng AI** (nút cạnh nút Chạy, tốn token): với các câu đang sai ở tầng 0–1, hệ thống (1) chạy đúng luồng bot thật có AI để xem bot sẽ chọn gì, và (2) nhờ AI nhận xét kỳ vọng có hợp lý không, có nên đổi sang template khác hay nên là chuyển nhân viên. Kết quả chỉ là gợi ý; admin quyết định sửa kỳ vọng hay sửa template.

Nguồn câu mẫu tốt nhất là mục **Tổng quan → Câu chưa khớp** (câu thật bị chuyển nhân viên) và transcript hỗ trợ cũ.

Chi phí: chạy bộ câu mẫu không tốn token. Muốn đo cả phần AI, lập trình viên chạy `npm run eval:live` (tốn token, có báo cáo theo nhánh).

---

## 5. Các mục còn lại (tóm tắt)

| Mục | Để làm gì |
|---|---|
| **Tổng quan** | Số liệu theo ngày, tỉ lệ chuyển nhân viên, **Câu chưa khớp** (câu bot không trả lời được, cần bổ sung nội dung) |
| **Hội thoại** | Từng vụ việc của khách; mỗi câu trả lời có mục "Vì sao bot trả lời thế này": ngôn ngữ, nhánh (FAST PATH / AI-RAG), AI hiểu gì, AI chọn gì, kiểm duyệt, chế độ phản hồi, kiểm tra chính sách |
| **Người dùng**, **Ticket** | Hồ sơ khách và ticket bot tự tạo khi chuyển nhân viên (danh mục, mã lỗi, người phụ trách, thông tin cần xin) |
| **Cấu hình** | Luồng xử lý (`router.mode`: hybrid / llm_first), ngưỡng điểm, ngôn ngữ kho, gateway LLM và model, **Embedding** (chọn đúng một model: API ngoài hoặc cục bộ; API lỗi thì tự chuyển cục bộ, khoá lựa chọn API và cảnh báo đỏ cho tới khi admin kiểm tra và mở khoá), predicates, danh sách link cho phép |
| **Chi phí LLM** | Token và chi phí theo ngày, theo khách, theo việc |
| **Nhật ký** | Ai đã thay đổi gì, khi nào |

---

## 6. Việc thường gặp: bot trả lời sai hoặc chuyển nhân viên một câu đáng lẽ trả lời được

1. Mở **Hội thoại**, tìm lượt đó, đọc "Vì sao bot trả lời thế này" để biết bot đi nhánh nào và AI chọn gì.
2. Nếu thiếu nội dung: **Thêm nội dung** (mục 1.2).
3. Nếu đã có nội dung nhưng bot không tìm thấy: mở nội dung đó → **Sửa nội dung**, thêm câu khách vừa nhắn vào phần "Khách hỏi" (mục 1.1), Publish.
4. Thêm câu đó vào **Câu hỏi mẫu** với kỳ vọng đúng (mục 4) để lần sau không tái diễn.
5. Nếu AI chọn sai dù có ứng viên đúng: xem lại **Hướng dẫn AI làm việc** (1.2), phần Nhiệm vụ và Giới hạn.
