# Đánh giá: có nên chuyển kho nội dung sang kiến trúc "mỗi câu trả lời một file" (như bộ đề xuất v2) không?

Ngày: 2026-09-24 · Trạng thái: **phân tích, chưa quyết định, chưa triển khai**
Tài liệu tham chiếu đầu vào: `D:\files\CODE-MIGRATION.md`, `D:\files\intake-draft-SKILL.md`, `D:\files\agent-guide.md`, `D:\files\interlink-bot-content-v2.zip`

## 1. Tóm tắt kết luận

**Không nên chuyển toàn bộ.** Sự khác biệt không chỉ nằm ở cách đặt tên file — nó thay cả **nơi lưu sự thật** (source of truth) của hệ thống, từ cơ sở dữ liệu sang file Git, và điều đó kéo theo phải viết lại gần như toàn bộ tầng lưu trữ + Admin Web + quy trình publish đang chạy tốt và đã qua kiểm thử (366 test). Lợi ích thật sự (dễ đọc hơn, gom theo chủ đề, cảnh báo xung đột tốt hơn) **đạt được mà không cần đổi kiến trúc** — bằng cách sửa cách hiển thị và bổ sung vài tính năng vào hệ thống hiện có.

Phần dưới đây giải thích rõ vì sao, theo từng khía cạnh cụ thể, để bạn tự cân nhắc.

## 2. Hai kiến trúc đang nói đến

### Kiến trúc hiện tại (đang chạy thật)

- **Nơi lưu sự thật:** Postgres — bảng `kb_documents` + `kb_document_versions` (mỗi lần publish là một dòng mới, giữ lại lịch sử đầy đủ).
- **Vai trò của thư mục `content/`:** chỉ là **dữ liệu khởi tạo lần đầu** (`seedContent`, [src/app.ts:124](src/app.ts:124)). File được `COPY content ./content` **vào bên trong image Docker lúc build** ([Dockerfile:17](Dockerfile:17)) — không phải thư mục sống, có thể ghi lúc chạy.
- **Publish:** Admin Web ghi thẳng vào DB qua transaction, có `pending_changes` cho thay đổi rủi ro cao, có rollback theo `version` bất kỳ lúc nào.
- **3 tiến trình chạy song song** (`admin`, `bot`, `worker`, xem `docker-compose.yml`) đều đọc **cùng một Postgres** — không có vấn đề đồng bộ vì DB tự lo khoá/giao dịch.
- **Tìm kiếm:** một chỉ mục vector trong bộ nhớ (`TemplateIndex`), nạp từ DB lúc khởi động và cập nhật khi có publish mới.

### Kiến trúc mà bộ file v2 giả định

- **Nơi lưu sự thật:** chính các file `.md` trên đĩa, mỗi câu trả lời một file, `status: live/review/retired` ghi ngay trong frontmatter.
- **Publish:** đổi `status` trong file, có vẻ được kỳ vọng đi kèm Git (theo cách gọi "REVIEW.md do tools tự sinh", "CATALOG.md") — nhưng tài liệu không nói rõ ai chạy `git commit`/`git push`, khi nào, bằng quyền gì.
- **Công cụ kiểm tra viết bằng Python** (`tools/check_content.py`) — dự án của bạn là TypeScript/Node, không có runtime Python trong container nào hiện tại.
- **Không có khái niệm "3 tiến trình đọc chung"** được thiết kế — tài liệu không đề cập container nào giữ bản file "chuẩn", làm sao `admin`/`bot`/`worker` luôn thấy đúng cùng một trạng thái cùng lúc.

## 3. So sánh từng khía cạnh

| Khía cạnh | Hiện tại (Postgres) | Đề xuất v2 (file-per-answer) |
|---|---|---|
| **Lịch sử & rollback** | Có sẵn, theo từng phiên bản, không giới hạn số bước lùi (`kb_document_versions`) | Phải dựa vào lịch sử Git — cần thêm cơ chế container gọi `git commit` đúng lúc, đúng tác giả, xử lý xung đột merge |
| **3 tiến trình đọc cùng lúc** | An toàn tự nhiên nhờ transaction của Postgres | Cần tự xây: khoá file, đồng bộ giữa các container, tránh đọc file đang ghi dở |
| **2 người duyệt cho nội dung bảo mật** | Có sẵn (`pending_changes`, chỉ owner mới đề xuất luật `SECURITY_RULE`) | Không thấy cơ chế tương đương trong bộ đề xuất — phải tự thiết kế lại |
| **Publish có transaction (thành công hết hoặc không gì cả)** | Có, DB đảm bảo | Ghi nhiều file cùng lúc trên đĩa không có transaction thật; publish nửa chừng bị lỗi có thể để lại trạng thái file không nhất quán |
| **Kiểm tra cấu trúc trước publish** | TypeScript, cùng ngôn ngữ với toàn bộ dự án, đã có 6 bước kiểm tra + test | Python (`check_content.py`) — phải viết lại bằng TypeScript từ đầu để dùng được trong dự án này, hoặc chạy Python song song (thêm một runtime mới cần cài, vá lỗ hổng, cập nhật) |
| **Tìm kiếm ngữ nghĩa** | Một model embedding, có dự phòng khi lỗi | Giả định **hai** model (Gemini + bge-m3) chạy song song + bộ rerank riêng — hạ tầng hoàn toàn mới, thêm chi phí vận hành và một điểm có thể lỗi |
| **Admin Web** | Đã xây xong: danh sách, sửa, publish, quét xung đột, nạp nội dung mới, kéo-thả file — đều thao tác qua API vào DB | Phải viết lại toàn bộ các màn hình này để đọc/ghi file thay vì gọi API DB — về cơ bản là làm lại Admin Web |
| **Kiểm thử tự động đang có** | 366 test đang chạy qua CI, kiểm đúng hành vi hiện tại | Không tương thích trực tiếp — phần lớn test giả định gọi hàm/route hiện có, phải viết lại theo kiến trúc file |
| **Người không biết code sửa nội dung** | Qua Admin Web, không đụng Git bao giờ | Nếu publish nghĩa là ghi file + Git, admin cuối cùng vẫn thao tác qua Admin Web (không tự chạy Git) — nghĩa là Admin Web phải tự động hoá toàn bộ thao tác Git thay họ, thêm một lớp phức tạp ẩn |
| **Độ trưởng thành** | Đang chạy production thật, đã qua nhiều vòng sửa lỗi thật (đã ghi trong lịch sử làm việc) | Chưa từng chạy — là bản thiết kế trên giấy, 35 bước trong `CODE-MIGRATION.md` đều đánh dấu `[NEEDS MAPPING]` (tức là: "vị trí thật trong code chưa xác định, cần tự tìm") |

## 4. Chi phí thực hiện nếu chọn chuyển hẳn

Dựa trên chính 35 bước trong `CODE-MIGRATION.md`:

- **Không phải "đổi định dạng file"** — là viết lại: bộ nạp nội dung, router (thêm chế độ xếp hạng mới), toàn bộ Admin Web (danh sách/sửa/publish/quét xung đột/nạp nội dung mới), bộ chạy test hồi quy, và hạ tầng embedding (thêm model thứ hai + rerank).
- **Cần "song song vận hành cả hai bản"** trong lúc chuyển (bước 13, 16, 19: so sánh v1/v2 phải khớp gần như tuyệt đối) — nghĩa là vừa giữ hệ thống cũ chạy thật, vừa xây hệ thống mới, vừa liên tục đối chiếu kết quả — tốn thời gian kỹ sư đáng kể, tính bằng tuần chứ không phải ngày.
- **Rủi ro production:** đổi cả nơi lưu sự thật của một bot đang phục vụ khách thật là loại thay đổi rủi ro cao nhất có thể làm với một hệ thống đang chạy.
- **Chưa kể chi phí vận hành thêm:** một dịch vụ rerank mới, một cơ sở dữ liệu vector thứ hai, khả năng cần cài Python trong container.

## 5. Lợi ích thật sự của bộ đề xuất v2 — và cách đạt được KHÔNG cần đổi kiến trúc

Đây là phần quan trọng: hầu hết điều bạn thấy hấp dẫn trong bộ file v2 **không đến từ việc file-per-answer**, mà đến từ **nội dung** và **quy trình** — cả hai đều lấy ra dùng được ngay trong hệ thống hiện tại:

| Bạn thích điều gì ở bộ v2 | Vì sao có được, và cách có nó mà không đổi kiến trúc |
|---|---|
| Câu trả lời gom theo chủ đề (`answers/wallet/`, `answers/kyc/`...) | Chỉ là cách **hiển thị**. Field `group`/`topic` đã có sẵn trên mỗi template hiện tại — chỉ cần đổi Admin Web hiển thị gộp nhóm theo field này (đã có trong kế hoạch [docs/KE_HOACH_THIET_KE_LAI_KHO_NOI_DUNG.md](docs/KE_HOACH_THIET_KE_LAI_KHO_NOI_DUNG.md)) |
| Phát hiện xung đột thật (R01–R05 trong `REVIEW.md`) | Đến từ **việc có ai/máy nào đó đọc kỹ nội dung và so sánh** — hệ thống hiện tại đã có đúng cơ chế này (`syncConflictsAfterPublish`, "Câu trả lời dễ bị nhầm"). Sửa 5 xung đột đó thẳng vào file hiện tại là xong, không cần đổi kho |
| Nạp nội dung mới biết tự "cập nhật" thay vì luôn "tạo mới" | Là logic của SKILL `intake-draft`, không phụ thuộc định dạng lưu trữ. Nâng cấp SKILL hiện tại (`content/skills/intake-draft/SKILL.md`) theo đúng luật create/update/duplicate của bản v3 là dùng được ngay |
| Xoá/ngừng dùng một template | Là một trường trạng thái (`status: retired`) + một nút trên Admin Web — làm được trong DB hiện tại, không cần file riêng |
| Mỗi câu trả lời dễ đọc hơn (không lẫn 25 template trong 1 file) | Người dùng cuối **không đọc file .md trực tiếp bao giờ** — họ dùng Admin Web. Vấn đề thật là màn hình Admin Web đang hiển thị như bảng kỹ thuật, không phải vấn đề của file vật lý. Sửa giao diện là đủ |

## 6. Khi nào NÊN cân nhắc lại việc chuyển kiến trúc

Không phải "không bao giờ" — chỉ là "chưa phải lúc này, và chưa có lý do đủ mạnh". Nên cân nhắc thật sự nếu:

- Nhiều admin cần **sửa cùng lúc, ngoại tuyến, không qua Admin Web** (ví dụ cần review nội dung bằng Pull Request trên GitHub trước khi merge) — đây là tình huống Git-based thật sự có lợi thế.
- Chất lượng tìm kiếm ngữ nghĩa hiện tại đã được đo và xác nhận là **không đủ tốt** — lúc đó thêm rerank/model thứ hai mới có cơ sở, và nên làm **độc lập** với việc đổi định dạng lưu trữ.
- Đội ngũ kỹ thuật có thời gian dành riêng vài tuần để làm và kiểm thử di trú mà không ảnh hưởng vận hành hằng ngày.

## 7. Đề xuất bước tiếp theo

Thay vì di trú kiến trúc, làm theo đúng nhánh "chỉ lấy phần nội dung tốt" đã nêu, ưu tiên theo thứ tự rủi ro thấp → cao:

1. Sửa 5 xung đột nội dung thật (R01–R05) vào `content/templates/*.md`/`content/knowledge/*.md` hiện có.
2. Thêm trạng thái ngừng dùng/xoá cho template (khoảng trống thật, độc lập với mọi quyết định kiến trúc).
3. Nâng cấp SKILL `intake-draft` theo hướng create/update/duplicate.
4. Đổi tên & gom nhóm hiển thị theo `docs/KE_HOACH_THIET_KE_LAI_KHO_NOI_DUNG.md` (giai đoạn 1–4, không có gì đổi kiến trúc).

Mỗi việc trên làm và kiểm chứng độc lập, không có việc nào bắt bạn phải "chọn hết một lần".
