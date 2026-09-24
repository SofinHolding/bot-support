# Hướng dẫn sử dụng Admin Web cho người vận hành

Tài liệu này dành cho quản trị viên không phải lập trình viên. Nó mô tả từng mục trên Admin Web: mục đó để làm gì, thao tác ra sao, và điều gì xảy ra với bot sau khi thao tác.

Nguyên tắc chung của hệ thống, cần nắm trước khi đọc:

- **Bot chỉ gửi nội dung đã được duyệt hoặc được viết từ nội dung đã duyệt.** Với tình huống hỗ trợ, AI chọn câu trả lời có sẵn và dịch trung thành. Với câu hỏi về dự án, AI viết câu trả lời từ đoạn tài liệu đã chọn, không được thêm số liệu hay dữ kiện ngoài tài liệu.
- **Mọi thứ AI làm đều bị code kiểm lại** (số liệu, link, ngôn ngữ, lựa chọn có nằm trong danh sách không). Không đạt thì chuyển nhân viên, không đoán.
- **Nội dung có phiên bản.** Sửa gì cũng qua Draft → Kiểm tra → Publish, có rollback. Bot nạp bản mới trong vài giây, không cần khởi động lại.

---

## 1. Kho tri thức

Đây là nơi chứa mọi thứ bot dùng để trả lời. Có năm tab.

### 1.1 Tài liệu

Danh sách các tài liệu, mỗi tài liệu là một file Markdown có phiên bản. Có ba loại:

| Loại | Chứa gì | Bot dùng để |
|---|---|---|
| `templates` | Nhiều **template**: câu trả lời đã duyệt + từ khoá + câu mẫu + điều kiện | Trả lời các tình huống hỗ trợ (rút tiền, KYC, ví…) bằng nguyên văn |
| `knowledge` | Tài liệu tri thức về dự án (whitepaper, tokenomics, chương trình…) | Trả lời câu hỏi về dự án: AI **viết câu trả lời từ đoạn đã chọn** bằng ngôn ngữ của khách, có trích dẫn và link; code kiểm số liệu, link, ngôn ngữ; không đạt thì gửi nguyên văn đoạn (cài đặt `router.tier3_mode`) |
| `guide` | Hướng dẫn AI làm việc (chỉ có một, xem 1.2) | Bối cảnh cho AI khi phán đoán |

**Quy trình thêm hoặc sửa:**

1. Bấm **Tài liệu mới** (hoặc mở tài liệu có sẵn → **Tạo phiên bản mới**). Ô soạn thảo đã có sẵn **một mẫu template đầy đủ có chú thích từng dòng** (hoặc mẫu tài liệu tri thức nếu chọn loại `knowledge`): sửa theo mẫu, xoá phần không dùng.
2. Hoặc dán nội dung Markdown / nạp file `.md` từ máy.
3. Bấm **Tạo Draft & kiểm tra**. Hệ thống chạy 6 bước kiểm tra và hiện báo cáo:
   - Cấu trúc: đúng định dạng chưa, thiếu trường gì.
   - Quét an toàn: có chuỗi giống seed phrase, script, link ngoài danh sách cho phép không.
   - Trùng và mâu thuẫn: từ khoá trùng template khác nhưng đáp án khác; **chồng lấn** với template hoặc đoạn tri thức đang chạy (dùng chính bộ tìm kiếm lúc khách hỏi — kể cả tài liệu tri thức mới so với template cũ, và ngược lại), kèm gợi ý *tạo phiên bản mới* nếu đây là bản cập nhật của tài liệu đã có; với Hướng dẫn AI là câu nới lỏng điều cấm.
   - Bản dịch: template thiếu bản dịch ngôn ngữ nào; **câu mẫu yếu** (chỉ chép lại từ khoá).
   - Hồi quy: chạy bộ câu hỏi mẫu (mục 4) trước và sau khi áp dụng bản này. Có câu đang đúng mà thành sai → **chặn Publish**.
   - Replay: chạy lại tin nhắn thật 14 ngày qua, báo bao nhiêu tin sẽ đổi câu trả lời.
4. Sửa cho tới khi hết lỗi, rồi bấm **Publish**. Bot dùng ngay.
5. Cần quay lại bản cũ: mở tài liệu → **Rollback** về phiên bản trước.

**Một template trông như thế nào** (trong file loại `templates`, nhiều template ngăn bằng `<!-- next -->`):

```markdown
---
id: fp-2-withdraw                    # mã duy nhất, dùng ở mọi nơi khác trong Admin Web
group: Withdraw                      # nhóm chủ đề
response_mode: EXACT_TEMPLATE        # gửi nguyên văn
priority: 890                        # trùng nhiều template thì ưu tiên số cao hơn
match:
  keywords: [withdraw, rút tiền, cash out]      # khớp chữ, bỏ dấu
  examples:                                     # câu khách hay nhắn: dùng để tìm theo ý nghĩa và để AI hiểu template này dành cho tình huống nào
    - when can I take my tokens out of the app?
    - bao giờ rút được ITLG về ví?
  excludes: [completed_level_1]                 # điều kiện loại trừ (định nghĩa ở Cấu hình → Predicates)
follow_up: { negative: ESCALATE, thanks: you-are-welcome }   # khách phản hồi "chưa được" / "cảm ơn" thì làm gì
sets_context: { issue: withdraw availability, status: pending }
ticket: { category: Wallet, error_code: W01, pic: Quang }   # thông tin ticket nếu tình huống này chuyển nhân viên
---
<!-- answer:en -->
Câu trả lời tiếng Anh (bắt buộc), gửi nguyên văn.
<!-- answer:vi -->
Bản tiếng Việt do admin soạn (tuỳ chọn). Không có thì AI dịch và chờ duyệt ở mục Bản dịch.
```

Mã template (`fp-2-withdraw`, `fp-3-listing-tge`, `esc-swap`…) là tên gọi duy nhất của một câu trả lời. Muốn biết mã nào là câu gì: tab **Template** (1.4) hoặc mở tài liệu chứa nó.

Lời khuyên quan trọng: **câu mẫu (`examples`) quyết định chất lượng tìm kiếm.** Câu mẫu phải là câu khách thật hay nhắn, diễn đạt khác từ khoá. Template chỉ có từ khoá, không có câu mẫu đúng nghĩa, sẽ chỉ được tìm thấy khi khách dùng đúng chữ đó; bước Kiểm tra sẽ cảnh báo trường hợp này.

### 1.2 Hướng dẫn AI làm việc

Một tài liệu duy nhất, sáu mục bắt buộc (Giới thiệu, Nhiệm vụ, Cách giao tiếp, Mục tiêu, Yêu cầu và giới hạn, Quy trình). Đây là cách người vận hành nói cho AI biết doanh nghiệp là ai, phục vụ ai, được làm gì và không được làm gì.

- Mỗi việc của AI chỉ nhận các mục liên quan: hiểu câu hỏi (mục 1, 2), chọn câu trả lời (1, 2, 5), kiểm duyệt (5), tóm tắt (1, 4), dịch (3).
- Tài liệu này là **bối cảnh**, không thay được luật do code cưỡng chế (bảo mật, chống spam, ngôn ngữ, kiểm tra đầu ra). Bước Kiểm tra sẽ chặn nếu tài liệu có câu cho phép điều hệ thống cấm (dự đoán giá, lộ công thức HCS, xin seed phrase, dùng kiến thức chung, bỏ qua luật).
- **Publish cần một quản trị viên khác duyệt** (xem mục 3) khi cài đặt "Cần người thứ hai duyệt" đang bật, vì nó đổi cách AI phán đoán.
- Nếu chưa có hoặc đọc lỗi, AI vẫn chạy với luật cố định của hệ thống.

### 1.3 SKILL AI

Mỗi bước AI làm (hiểu câu hỏi, chọn câu trả lời, kiểm duyệt FAST PATH, dịch câu hỏi, dịch câu trả lời, đánh giá câu mẫu) có một **SKILL**: file chỉ dẫn gồm frontmatter, mục `## Requirements` (các yêu cầu R1, R2…) và `## Output`. Tab này hiển thị toàn bộ SKILL đang dùng; admin sửa trực tiếp và bấm **Lưu**. Hệ thống kiểm tra cấu trúc trước khi nhận; bản sửa có hiệu lực trong vài giây (hoặc sau khi người thứ hai duyệt, nếu cài đặt đó đang bật). **Về bản mặc định** quay lại file gốc của dự án.

Lưu ý: SKILL thay đổi cách AI làm việc, nhưng các kiểm tra bằng code (số liệu, link, ngôn ngữ, chỉ được chọn trong danh sách) vẫn áp dụng dù SKILL viết gì.

### 1.4 Template

Bảng tra cứu toàn bộ template đang chạy: mã, nhóm, chế độ, ưu tiên, các ngôn ngữ có bản dịch sẵn, số từ khoá, thông tin ticket, câu trả lời tiếng Anh. Có ô tìm theo mã hoặc nhóm; nút **Sửa** mở đúng template trong trình soạn thảo.

**Quét chồng lấn toàn kho** (thẻ phía trên bảng): code dùng chính bộ tìm kiếm lúc khách hỏi (vector câu mẫu + vector đoạn tri thức, cùng model embedding đang chọn, và tín hiệu từ khoá nằm trong câu) để liệt kê các **cặp** template/đoạn tri thức mà bot có thể lẫn. Máy quét chỉ cờ, không kết luận — giống về chữ chưa chắc cùng một việc. Bấm **AI** ở từng cặp (hoặc "Đánh giá 20 cặp đầu") để AI phân loại *trùng / bao hàm / mâu thuẫn / khác nhau* kèm gợi ý sửa; mỗi lời gọi chỉ gửi đúng hai mục, không gửi cả kho. Quyết định và sửa là của bạn (nút Sửa / Mở tài liệu ngay trên dòng). Nên chạy sau khi thêm nội dung mới và định kỳ, vì bước kiểm tra lúc import chỉ so bản nháp với kho, không nhìn lại những gì đã publish từ trước.

Luật cố định liên quan: **lối tắt chuyển nhân viên** (template `esc-*` mà câu trả lời trỏ về câu chung FP-12) chỉ được chọn khi khớp từ khoá/luật rõ ràng, không còn được kéo vào danh sách ứng viên chỉ vì *giống mờ* về nghĩa — tránh việc một câu hỏi chung chung ("không đăng nhập được") bị lối tắt cũ giành mất tài liệu hướng dẫn mới.

---

## 2. Bản dịch

Mục này là **bộ nhớ các bản dịch của template**, dành cho ngôn ngữ chưa có bản admin soạn sẵn.

Cách hoạt động: khách nhắn tiếng Đức, template chỉ có tiếng Anh → AI dịch **một lần** theo SKILL `translate-answer` (giữ nguyên số liệu, link, tên sản phẩm; không thêm bớt) → code kiểm lại (số liệu khớp, đúng ngôn ngữ đích, link trong danh sách cho phép) → bản dịch được **lưu ở đây với trạng thái chờ duyệt** và được gửi cho khách. Những khách Đức sau đó nhận đúng bản đã lưu, không dịch lại.

Việc của quản trị viên: đọc bản dịch, sửa cho tự nhiên nếu cần, bấm **Duyệt**. Bản đã duyệt là bản chính thức cho ngôn ngữ đó. Khi câu tiếng Anh gốc thay đổi, hệ thống tự tạo bản dịch mới chờ duyệt lại.

Trả lời câu hỏi "đã có SKILL dịch rồi thì mục này để làm gì": SKILL là **quy tắc** để AI dịch đúng ở mỗi lần dịch; mục Bản dịch là **kết quả** của lần dịch đó, được lưu lại để dùng chung và để người thật kiểm tra thêm một lớp. Hai thứ bổ sung cho nhau: SKILL bảo đảm bản dịch đầu tiên đã an toàn để gửi, mục Bản dịch bảo đảm bản dùng lâu dài là bản người thật đã đọc.

Cài đặt liên quan (Cấu hình → `translation.send_unapproved`): bật (mặc định) thì gửi bản dịch máy ngay khi qua kiểm tra; tắt (chế độ chặt) thì chỉ gửi bản đã duyệt, chưa duyệt gửi tiếng Anh.

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

Một dòng như `when can I take my tokens out of the app?` · kỳ vọng `fp-2-withdraw` · bot chọn `ESCALATE` nghĩa là: câu này không trùng từ khoá nào của template rút tiền, nên tầng 0–1 chuyển nhân viên. Trên bot thật, câu này sẽ đi tiếp qua AI và thường được trả lời đúng; nhưng nếu AI không khả dụng thì khách bị chuyển nhân viên. Muốn tầng 0–1 tự xử lý được, thêm câu đó vào `examples` (hoặc từ khoá) của template `fp-2-withdraw` rồi Publish.

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
| **Cấu hình** | Luồng xử lý (`router.mode`: hybrid / llm_first / code_first), kiểm duyệt FAST PATH, ngưỡng điểm, ngôn ngữ kho, gateway LLM và model, **Embedding** (chọn đúng một model: API ngoài hoặc cục bộ; API lỗi thì tự chuyển cục bộ, khoá lựa chọn API và cảnh báo đỏ cho tới khi admin kiểm tra và mở khoá), predicates, danh sách link cho phép |
| **Chi phí LLM** | Token và chi phí theo ngày, theo khách, theo việc |
| **Nhật ký** | Ai đã thay đổi gì, khi nào |

---

## 6. Việc thường gặp: bot trả lời sai hoặc chuyển nhân viên một câu đáng lẽ trả lời được

1. Mở **Hội thoại**, tìm lượt đó, đọc "Vì sao bot trả lời thế này" để biết bot đi nhánh nào và AI chọn gì.
2. Nếu thiếu nội dung: thêm template hoặc tài liệu tri thức (mục 1.1).
3. Nếu có template nhưng không tìm thấy: thêm câu khách vừa nhắn vào `examples` của template đó (mục 1.1), Publish.
4. Thêm câu đó vào **Câu hỏi mẫu** với kỳ vọng đúng (mục 4) để lần sau không tái diễn.
5. Nếu AI chọn sai dù có ứng viên đúng: xem lại **Hướng dẫn AI làm việc** (1.2), phần Nhiệm vụ và Giới hạn.
