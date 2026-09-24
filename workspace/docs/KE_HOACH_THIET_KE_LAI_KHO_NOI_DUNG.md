# Kế hoạch thiết kế lại cách quản lý nội dung của chatbot (cho người không biết code)

Ngày: 2026-09-23 · Trạng thái: **đề xuất, chưa triển khai**

## 1. Vấn đề hiện tại

Người quản lý nội dung đang phải hiểu cách **máy** tổ chức dữ liệu, trong khi họ chỉ cần làm một việc: *"khi khách hỏi thế này thì bot trả lời thế kia"*.

| Hiện tại (ngôn ngữ của máy) | Người quản lý thực sự nghĩ |
|---|---|
| "Template", `id`, `group`, `response_mode`, `priority`, `match.keywords/examples` | "Một câu trả lời có sẵn cho một vấn đề" |
| "Tài liệu" (file `.md` chứa **nhiều** template cùng lúc, ví dụ `fast-path.md` chứa 25 cái) | "Tôi muốn sửa câu trả lời về rút tiền", không quan tâm nó nằm trong file nào |
| Tab "Câu hỏi mẫu" (menu trái) **và** mục "câu mẫu" bên trong template: trùng tên, khác việc | Hai thứ khác nhau nhưng tên gần như giống hệt |
| "Chồng lấn nội dung", "ngưỡng điểm 0.55", "vector", "xuyên ngôn ngữ" | "Có câu trả lời nào dễ bị bot nhầm với nhau không?" |
| Sửa bằng cách viết Markdown/YAML | Điền vào ô: câu hỏi, câu trả lời |

Ngoài ra, rất nhiều template hiện có **chép câu mẫu y hệt từ khoá** (ví dụ `how-to-login`: từ khoá và câu mẫu đều là "how to login / cách login / đăng nhập"), nên phần "câu mẫu" gần như không thêm giá trị và càng khó hiểu nó để làm gì.

## 2. Nguyên tắc bất biến: KHÔNG được thay đổi

Kế hoạch này chỉ đổi **cách hiển thị và cách nhập liệu**. Những thứ sau giữ nguyên tuyệt đối, cả nội dung lẫn ý nghĩa:

1. **Tài liệu "Hướng dẫn AI làm việc" (`agent-guide`)**: không đổi chữ nào, mọi quy tắc **[CODE]** và **[AI]** giữ nguyên. Giao diện mới chỉ hiển thị nó ở chế độ đọc; sửa vẫn qua trình soạn thảo riêng như hiện nay.
2. **Ràng buộc của từng SKILL** (`content/skills/*/SKILL.md`, mục Requirements R1, R2…): không đổi.
3. **9 template `SECURITY_RULE`** (seed phrase, private key…) và **`content/config/predicates.yml`**: không đổi nội dung. Trên giao diện mới, người không có quyền owner chỉ được xem.
4. **Câu trả lời đã duyệt gửi nguyên văn**, dịch trung thành, không bao giờ gửi tiếng Việt cho khách không dùng tiếng Việt: logic bot không bị đụng tới.
5. **Định dạng lưu trữ** (file Markdown + YAML, bảng `kb_documents`/`kb_versions`, vector) giữ nguyên. Giao diện mới đọc/ghi qua đúng bộ chuyển đổi đang có (`parseTemplateFile` ↔ `templatesToMarkdown`), nên bot, bộ định tuyến và kiểm tra không cần sửa.
6. **Quy trình an toàn trước khi publish**: 6 bước kiểm tra, chạy bộ kiểm tra hồi quy, duyệt 2 người khi cần, rollback theo phiên bản. Giữ nguyên, chỉ đổi cách trình bày kết quả.
7. **Giá trị `priority`, `rules`, `requires/excludes`, `answer_from`, `follow_up`, `ticket` của 71 template hiện có**: không bị thay đổi khi chuyển sang giao diện mới (xem mục 5, kiểm chứng tự động).

## 3. Mô hình mới: 4 khái niệm, đặt tên theo đời thường

| Tên mới trên giao diện | Thực chất bên dưới (không đổi) | Người quản lý làm gì |
|---|---|---|
| **Câu trả lời có sẵn** | 1 template | Thêm / sửa / tắt từng câu trả lời |
| **Tài liệu tham khảo** | tài liệu tri thức (`knowledge`, ví dụ Ambassador, Whitepaper) | Dán/tải lên tài liệu dài; bot tự viết câu trả lời từ đó, có trích dẫn |
| **Câu hỏi kiểm tra** | bộ câu hỏi mẫu (`eval_cases.jsonl`, `handwritten.jsonl`) | Ghi các câu khách hay hỏi kèm "phải ra câu trả lời nào" để máy tự kiểm tra trước khi publish |
| **Quy tắc của bot** | `agent-guide` + SKILL + SECURITY_RULE | Chỉ đọc (owner mới sửa, qua màn hình riêng) |

Tab "Template" và "Tài liệu" gộp thành **"Câu trả lời có sẵn"**. Khái niệm "file chứa nhiều template" được ẩn khỏi người dùng thường (vẫn tồn tại bên dưới, hệ thống tự biết câu trả lời nằm ở file nào).

## 4. Các màn hình mới

### 4.1. Danh sách "Câu trả lời có sẵn"

Mỗi dòng là **một** câu trả lời, dạng thẻ dễ đọc thay cho bảng 10 cột:

```
[Rút tiền]  Khách hỏi về rút tiền / cash out
  Bot trả lời: "you can not withdraw now, it will be withdrawn in the future..."
  Ví dụ câu khách hỏi: rút tiền · cash out · how to withdraw        ✔ 4 câu kiểm tra đạt
  [Sửa]  [Thử hỏi bot]
```

- Lọc theo **chủ đề** (chính là `group`: Tài khoản, KYC, Ví, Rút tiền…), tìm theo chữ trong câu hỏi **hoặc** câu trả lời.
- Huy hiệu sức khoẻ trên từng thẻ: "✔ kiểm tra đạt", "⚠ dễ bị nhầm với *Quên Login ID*", "⚠ chưa có ví dụ câu hỏi".
- Thẻ `SECURITY_RULE` và thẻ có điều kiện nâng cao hiện biểu tượng khoá 🔒 "Quy tắc an toàn, chỉ xem".

### 4.2. Form "Sửa câu trả lời" (thay cho trình soạn Markdown)

Các ô theo đúng thứ tự người ta nghĩ:

1. **Chủ đề**: chọn từ danh sách có sẵn (hoặc thêm chủ đề mới).
2. **Khách thường hỏi thế nào?**: mỗi dòng một câu. Gợi ý: "viết như khách thật nhắn, càng đa dạng càng tốt". *(Bên dưới: `examples`.)*
3. **Từ khoá bắt buộc** (tuỳ chọn, ẩn trong "Nâng cao" cho người mới): cụm từ mà hễ xuất hiện là chắc chắn chọn câu trả lời này. *(Bên dưới: `keywords`.)*
4. **Bot trả lời**: ô văn bản tiếng Anh (bản gốc đã duyệt); các ngôn ngữ khác nằm ở tab "Bản dịch" như hiện tại.
5. **Nếu khách nói vẫn chưa được thì**: chọn "Chuyển nhân viên" / "Trả lời tiếp câu …" / "Không làm gì". *(Bên dưới: `follow_up`.)*
6. **Có tạo ticket cho nhân viên không?**: bật/tắt, mã lỗi, danh mục, người phụ trách. *(Bên dưới: `ticket`.)*
7. **Nâng cao** (thu gọn, chỉ owner/admin kỹ thuật): độ ưu tiên, điều kiện `rules/requires/excludes`, `answer_from`, chế độ trả lời. Các giá trị này được **giữ nguyên** khi người dùng thường lưu form, dù họ không nhìn thấy.

Nút **"Xem bản kỹ thuật"** mở trình soạn Markdown cũ cho ai cần, không bỏ.

Khi lưu: form → `templatesToMarkdown` → tạo bản nháp của đúng file chứa câu trả lời đó → chạy 6 bước kiểm tra như hiện nay.

### 4.3. Nút "Thử hỏi bot" ngay trên form

Gõ một câu như khách → hiện ngay "bot sẽ chọn: *câu trả lời X*" (dùng lại tính năng "Thử câu hỏi" và vết định tuyến đã có). Nếu kết quả sai, có nút **"Lưu câu này thành câu hỏi kiểm tra"**. Đây là cách tự nhiên nhất để người không biết code xây bộ kiểm tra.

### 4.4. "Câu hỏi kiểm tra" (đổi tên từ "Câu hỏi mẫu")

- Đổi tên menu để không trùng với "ví dụ câu khách hỏi" trong form.
- Mỗi câu hỏi kiểm tra hiện **tên câu trả lời đúng bằng chữ** (không phải mã `fp-2-withdraw`) và có liên kết qua lại với thẻ câu trả lời.
- Một dòng giải thích ở đầu trang: *"Trước khi publish, máy tự hỏi bot tất cả các câu này. Nếu có câu bot trả lời sai so với trước, publish bị chặn để bạn xem lại."*

### 4.5. "Chồng lấn nội dung" → **"Câu trả lời dễ bị nhầm"**

- Bỏ khỏi màn hình chính: ngưỡng 0.55, chữ "vector", "xuyên ngôn ngữ" (dời vào "Nâng cao").
- Mỗi kết quả là một câu văn: *"Khi khách hỏi 'quên mật khẩu đăng nhập', bot có thể chọn nhầm giữa **Quên Login ID** và **Quên mật khẩu**. AI đánh giá: hai câu trả lời khác nhau, nên thêm ví dụ câu hỏi rõ hơn cho từng cái."* kèm nút **Sửa** mở thẳng form 4.2 của từng thẻ (dùng lại hộp xung đột + chấm đỏ của tính năng "Nạp nội dung mới").
- Tự chạy sau mỗi lần publish (đã có `syncConflictsAfterPublish`); nút quét tay vẫn giữ.

### 4.6. Trang chủ "Nội dung của bot": bảng sức khoẻ

Một màn hình tóm tắt thay cho việc phải mò từng tab:
- Số câu trả lời, số câu hỏi kiểm tra, tỉ lệ đạt lần chạy gần nhất.
- "Câu khách hỏi mà bot chưa trả lời được" trong 7 ngày (đã có dữ liệu "câu hỏi mới"), mỗi câu có nút **"Tạo câu trả lời cho câu này"** → mở luồng "Nạp nội dung mới".
- Danh sách "dễ bị nhầm" chưa xử lý, câu trả lời thiếu bản dịch.

## 5. Kiểm chứng "không đổi ý nghĩa" (bắt buộc trước khi bật giao diện mới)

1. **Kiểm tra chuyển đổi khứ hồi**: với cả 71 template hiện có, đọc vào form → lưu ra Markdown → đọc lại, so sánh **từng trường** với bản gốc. Phải giống hệt 100% (kể cả `priority`, `rules`, `answer_from`, `ticket`). Chạy tự động trong bộ test.
2. **So sánh định tuyến trước/sau** bằng công cụ `src/cli/parity.ts` đã có: toàn bộ 252 câu hỏi kiểm tra phải chọn ra đúng cùng một câu trả lời như trước.
3. **Checksum tài liệu bất biến**: `agent-guide.md`, các `SKILL.md`, `predicates.yml`, 9 template `SECURITY_RULE`: băm nội dung trước và sau, phải trùng.
4. Chạy toàn bộ test hiện có (366 test) + test mới.

## 6. Lộ trình triển khai (mỗi giai đoạn dùng được ngay, không phá giai đoạn trước)

| Giai đoạn | Nội dung | Rủi ro với dữ liệu |
|---|---|---|
| **1. Đổi tên & giải thích** | Đổi nhãn menu/tab/cột theo mục 3, thêm dòng giải thích đầu mỗi trang, viết lại màn "Chồng lấn" thành "Câu trả lời dễ bị nhầm" (4.5) | Không có, chỉ đổi chữ trên giao diện |
| **2. Danh sách thẻ + form sửa** | Mục 4.1, 4.2 + kiểm chứng 5.1 | Thấp: lưu qua bộ chuyển đổi có sẵn, có test khứ hồi |
| **3. Thử hỏi bot & câu hỏi kiểm tra** | Mục 4.3, 4.4 | Không có: chỉ thêm câu kiểm tra |
| **4. Bảng sức khoẻ** | Mục 4.6 | Không có: chỉ đọc |
| **5. (Tuỳ chọn) Làm sạch ví dụ câu hỏi** | Dùng AI gợi ý thêm ví dụ câu hỏi đa dạng cho các template đang chép y hệt từ khoá; **người duyệt từng thẻ**, bắt buộc qua kiểm chứng 5.2 trước khi publish | Trung bình: đổi ví dụ làm đổi cách bot so khớp, nên phải qua bộ kiểm tra hồi quy |

Giai đoạn 1–4 **không làm thay đổi bất kỳ câu trả lời nào bot gửi cho khách**. Chỉ giai đoạn 5 ảnh hưởng tới hành vi bot, nên tách riêng, làm sau cùng và chỉ khi bạn đồng ý.
