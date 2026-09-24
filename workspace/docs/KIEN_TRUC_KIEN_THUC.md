# Kiến trúc hệ thống kiến thức (mục hỏi đáp)

Tài liệu cho người vận hành và cho agent đọc trước khi sửa code. Các quyết định lớn cùng lý do nằm ở [adr/](adr/).

## 1. Ba loại nội dung

| Loại | Dùng làm gì | Ai sửa | Ở đâu trong code |
|---|---|---|---|
| **Mục hỏi đáp** (`items`) | Câu trả lời đã duyệt cho từng tình huống của khách | Hệ thống tự tạo từ nội dung người dùng đưa vào ("Thêm nội dung") | `src/core/items.ts` |
| **Tài liệu tham khảo** (`knowledge`) | Whitepaper, Infrastructure, Ambassador: bot trích nguyên văn đoạn phù hợp | Hệ thống tự tạo từ nội dung người dùng đưa vào ("Thêm nội dung") | `src/core/knowledge.ts` |
| **Hướng dẫn AI làm việc** (`guide`) | Luật cho AI | Soạn trực tiếp, chỉ qua duyệt hai người | `src/core/guide.ts` |

Người dùng **không** chọn loại, không soạn Markdown/YAML: Kho tri thức là nơi duy nhất, chỉ có một cửa "Thêm nội dung". Hệ
thống (SKILL intake-draft) tự quyết là câu trả lời hay tài liệu, tự xếp chủ đề (`intakeToItems`, `GROUP_TOPIC`), tự so với dữ
liệu đang có (`relationsForNew`) và chỉ hỏi người dùng những chỗ cần quyết. API soạn thẳng (`POST /api/kb/documents`,
`PUT /api/kb/versions/:id`) chỉ còn nhận "Hướng dẫn AI làm việc".

Loại `templates` là hệ thống cũ. Nó vẫn chạy trong thời gian chuyển đổi (xem mục 5).

## 2. Mục hỏi đáp

Mỗi chủ đề (`ITEM_TOPICS`, danh sách cố định) là **một tài liệu có phiên bản**, slug `items-<chủ đề>`, nội dung YAML. Mỗi mục gồm:

- `id`: sinh tự động từ tên, **không bao giờ đổi**. Bản dịch, câu kiểm tra, ticket và code đều gọi theo id.
- `questions`: các cách khách hỏi, nên có ít nhất 3. Bot so theo nghĩa (vector), không so từng chữ.
- `phrases` (tuỳ chọn): cụm **ít nhất 2 từ**. Tin nhắn chứa đúng cụm này thì bot trả lời ngay qua đường nhanh. **Không có từ khoá một từ**.
- `applies_when`: dùng khi nào, viết bằng lời thường. AI đọc trường này khi chọn.
- `distinct_from`: các mục dễ lẫn. Mỗi dòng gồm khác nhau ở điểm nào (`difference`) và câu hỏi lại khách (`clarify`, tiếng Anh).
- `steps`: các bước trả lời. `say.en` là bản gốc. `next` cho biết khách phản hồi thế nào (`negative`, `info_provided`...) thì đi đâu: `next` (bước kế), `handoff`, hoặc `<id mục>`.
- `kind`:
  - `answer`;
  - `handoff`: dùng câu chuyển nhân viên chuẩn và tạo ticket;
  - `system`: tin do code gửi, nội dung khoá.
- `advanced`: điều kiện kỹ thuật giữ từ hệ thống cũ (exact, rules, loại ảnh...). Không sửa qua form.

**Không có độ ưu tiên dạng số.** Mọi mục ngang hàng (`ITEM_PRIORITY`). Hai mục dễ lẫn phải khai báo `distinct_from`; thứ hạng không được tự phân định giữa chúng.

**Khi publish**, `compileItems` dịch mỗi mục thành template đang chạy:
- bước 1 mang mã `id`;
- bước n mang mã `id--bN` và chỉ tới được qua tin nối tiếp.

Nhờ vậy tìm kiếm, dịch, ticket và kiểm tra hồi quy của hạ tầng cũ dùng lại được nguyên vẹn.

## 3. Vòng đời

```
"Thêm nội dung" (dán văn bản / kéo-thả tệp; hoặc "Sửa nội dung" = dán bản mới cho một nội dung có sẵn)
  ──> AI tách cấu trúc ──> bản nháp của đúng chủ đề / tài liệu ──> 6 bước kiểm tra + khung "cần bạn quyết"
  ──> Publish (duyệt hai người nếu có luật bảo mật) ──> bot nạp lại
                                                   └─ Rollback về phiên bản bất kỳ
```

Code: `/api/kb/intake` (`src/admin/server.ts`) → `intakeToItems` (`src/kb/intake.ts`) → `KbService.addIntakeItems` /
`mutateItemsDoc` / `relationsForNew` / `versionUnits`, rồi `validateSource`, `publish`, `rollback` (`src/kb/service.ts`).
Danh sách nội dung: `GET /api/kb/content` (`KbService.listContent`). Giao diện: `viewKb`, `kbContent`, `kbUnit`,
`kbIntakeNew`, `kbIntakeReview`, `kbPending` (`src/admin/web/app.js`).

## 4. Luật chặn publish (bước 3, `itemGate`)

Mọi xung đột dữ liệu phải được xử lý **xong** trước khi publish, không chỉ cảnh báo:

1. Cụm nhận biết một từ, hoặc trùng với mục khác (trong tài liệu: `validateItemsDoc`; toàn kho: `itemGate`).
2. `distinct_from` thiếu điểm khác nhau hoặc thiếu câu hỏi lại, hoặc trỏ tới mục không tồn tại.
3. **Hỏi thử bot** (`src/kb/routing-check.ts`) bằng mọi câu của mục: câu bị trả lời bằng mục khác, hoặc khớp ngang hàng với mục khác, mà hai mục chưa khai báo `distinct_from`.
4. Mục giành câu hỏi của một đoạn tài liệu mà chưa có **quyết định còn hiệu lực** trong `kb_pair_decisions`. Quyết định gắn với hash nội dung của cả hai bên; một bên đổi nội dung là quyết định hết hiệu lực (`src/kb/pair-decisions.ts`). Admin Web có nút "Ghi nhận giữ nguyên".
5. Kiểm tra hồi quy trên bộ câu kiểm tra (bước 5): câu đang đúng thành sai thì chặn.

## 5. Chọn câu trả lời lúc chạy

```
tin nhắn ─ AI hiểu (ngôn ngữ, ý định) ─┬─ ĐƯỜNG NHANH: khớp cụm nhiều từ / luật + AI xác nhận ─> trả lời
                                       └─ AI/RAG: mục hỏi đáp + đoạn tài liệu vào CÙNG một danh sách ─> AI chọn
                                            ├─ T:<mục> / K:<đoạn> ─> trả lời nguyên văn (dịch trung thành)
                                            ├─ CLARIFY:<A>,<B> ─> hỏi lại khách 1 lần (câu đã duyệt)
                                            └─ ESCALATE ─> chuyển nhân viên
```

- **Mọi câu trả lời lấy từ kho đều qua AI.** Đường nhanh vẫn phải qua SKILL `verify-answer`, kể cả tin nối tiếp và luật theo ảnh có kèm chữ. Sticker/emoji cũng qua SKILL `understand`. Không có chế độ trả lời bằng từ khoá khi AI lỗi.
- **Mất kết nối LLM** (hoặc chưa cấu hình, hết ngân sách token của khách) ở bất kỳ bước nào, kể cả lúc dịch: khách nhận một câu cố định bằng tiếng Anh ghi trong mã nguồn (`src/core/fixed-messages.ts`). Ngoại lệ do code xử lý, chạy cả khi mất kết nối, luôn tiếng Anh: cảnh báo lộ seed phrase / private key và cảnh báo chống spam.
- Hai mục đã khai báo khác nhau cùng khớp thì cổng (`src/core/gate.ts`) trả "mơ hồ", không chọn theo thứ hạng.
- **Hỏi lại khách** (`CLARIFY`) chỉ được nhận khi đủ ba điều kiện:
  - hai mục nằm trong danh sách ứng viên;
  - hai mục đã khai báo `distinct_from` có câu hỏi lại;
  - bật `episode.ask_when_unclear`.

  Code ghi `episodes.pending_clarify`. Lượt sau chỉ chọn giữa hai mục đó; vẫn không rõ thì chuyển nhân viên. Mỗi vụ việc chỉ hỏi lại một lần.
- SKILL `select-answer` bản 2 (quy tắc R3a) và câu sửa trong "Hướng dẫn AI làm việc" phải qua **duyệt hai người**. Nội dung đề xuất nằm ở [de-xuat/hoi-lai-khach-CLARIFY.md](de-xuat/hoi-lai-khach-CLARIFY.md). Khi chưa duyệt, `CLARIFY` được xử lý như chuyển nhân viên.

## 6. Chuyển từ hệ thống cũ

- **Mục hỏi đáp thay chỗ template cũ cùng mã** (`loadPublishedTemplateRows`, `src/db/repo-kb.ts`):
  - publish một chủ đề thì template cũ trùng mã bị che;
  - hoàn tác chủ đề thì template cũ tự hiện lại;
  - nhờ vậy chuyển được **từng chủ đề một** và chạy song song an toàn.
- `scripts/migrate-to-items.ts` đọc template đang chạy và ghi YAML theo chủ đề vào `.staging/items`, kèm báo cáo (ghi file, không ghi DB):
  - lỗi kiểm tra;
  - câu sẽ trả lời nhầm;
  - so sánh bộ câu kiểm tra với bộ đang chạy;
  - những gì đã đổi.
- `scripts/import-review.ts` áp quyết định của khách trong file rà soát Excel (`src/kb/review-import.ts`). Script không tự viết câu hỏi lại khách; câu đó để trống cho người quản lý viết.
- Khi mọi chủ đề đã chạy ổn, chuyển các tài liệu `templates` cũ sang lưu trữ. **Không xoá.**

## 7. Những điều KHÔNG được làm

- Không sửa "Hướng dẫn AI làm việc", SKILL hay luật bảo mật (SECURITY_RULE) ngoài quy trình duyệt hai người. Luồng nạp nội dung không được tạo hay sửa `agent-guide`.
- Không đổi nghĩa các luật [CODE]/[AI], `content/config/predicates.yml`, các mẫu SECURITY_RULE.
- Không gộp hai mục chỉ vì giống chữ. Gộp là quyết định của người duyệt (ví dụ Forgot ID và Forgot Login ID được bot cũ cố ý tách).
- Không thêm lại độ ưu tiên dạng số hay từ khoá một từ.
- Không đổi `id` của mục đã publish.
