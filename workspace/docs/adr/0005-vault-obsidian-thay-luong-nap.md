# ADR 0005 — Nạp tri thức qua vault Obsidian thay trợ lý "Nạp nội dung mới"

Ngày: 2026-09-28 · Trạng thái: chấp nhận

Nguồn: trang Notion "Xây dựng bộ nhớ LLM" (và hai trang con "Hướng dẫn vector dataset", "Hướng dẫn xử lý xung đột dữ liệu
(Telegram admin)"), skill `raw-data/obsidian-knowledge-ingest.skill`.

## Quyết định

- **"Thêm nội dung" trên Admin Web = tải tệp.** Tệp gốc lưu vào `raw-data/` (`RAW_DATA_DIR`), worker chuyển thành note atomic
  trong vault Obsidian `knowledge/` (`VAULT_DIR`): `notes/<category>/`, `_pending/`, `_archive/`, `_meta/index.json`,
  `_jobs/index-queue.jsonl`, `_notifications/`.
- **Skill của model trong hệ thống** là hai SKILL chỉ trả JSON:
  - `knowledge-ingest`: soạn note;
  - `knowledge-conflict`: so cặp theo ý nghĩa.

  Skill gốc viết cho agent có quyền đọc/ghi file, nên phần ghi file, gán id, trạng thái, `ingested_at`, chỉ mục, hàng đợi và
  thông báo chuyển hết sang code (`src/vault/`).
- **Mọi mâu thuẫn đều chặn** (owner chốt 2026-09-28), kể cả loại B1 trong skill gốc (bản mới khác bản cũ, khác mốc thời gian;
  skill gốc cho dùng tạm `provisional`):
  - note mới vào `_pending/` (`awaiting_approval`), bản cũ vẫn phục vụ khách cho tới khi admin chọn;
  - cặp AI không so được bị coi là mâu thuẫn;
  - chủ đề đang có xung đột mở thì note mới cùng chủ đề gộp vào xung đột đó.

  Giữ đúng bất biến 5.
- **Quyết định xung đột áp dụng bằng code** (job `vault-decide`), không dùng LLM:
  - Admin Web và Telegram dùng chung bảng `ingest_conflicts`;
  - người bấm đầu tiên thắng;
  - "Gộp": AI soạn note để admin xem trước rồi mới ghi;
  - trên Telegram, nút Gộp chuyển sang Admin Web.
- **Một nơi ghi vault là worker.** Admin chỉ lưu tệp thô và xếp job. Bot không đọc file mà đọc bảng `vault_notes`,
  `vault_chunks`, `vault_chunk_vectors` (migration 011).

  Điều này giữ kết luận chính của `docs/DANH_GIA_CHUYEN_KIEN_TRUC_FILE_PER_ANSWER.md` (không để ba tiến trình cùng ghi file,
  Postgres vẫn là nơi bot đọc). Vault là nơi soạn/duyệt tri thức mới, không thay kho đã publish cũ.
- **Tìm kiếm khi trả lời:**
  - vault và tài liệu cũ (`kb_chunks`) cùng chạy, gộp bằng RRF (`CompositeKnowledge`);
  - chunk vault có id `v:<note_id>#<n>`;
  - luồng trả lời không đổi: select-answer / verify-answer chọn, khách nhận nguyên văn thân note (dịch trung thành).

## Chỗ khác với thiết kế Notion, và lý do

| Notion | Làm thế này | Lý do |
|---|---|---|
| Nhánh chữ bằng SQLite FTS5 (`fts.db`) | `tsvector` trong bảng `vault_chunks` | Notion để ngỏ việc này. Cùng DB và transaction; ba container không phải chia sẻ file SQLite |
| Bảng riêng cho mỗi collection (`chunks_gem001_d3072_v1`, kiểu `vector(3072)`) | Một bảng vector có cột `model` (tên model gồm cả số chiều) | Khớp cơ chế sẵn có: API embed lỗi thì tự chuyển sang model cục bộ, và vector hai model không bao giờ trộn. `_meta/embed-config.json` ghi model đang dùng. Đổi model thì embed bù, không ghi đè |
| Chỉ mục HNSW trên `halfvec(3072)` | Chưa tạo | Vài nghìn chunk thì quét tuần tự vẫn nhanh và chính xác (đúng khuyến nghị của Notion). Tạo khi truy vấn chậm |
| `task_type` luôn gửi | Ba hàm theo vai trò (`src/vault/embed-roles.ts`, có test chặn import chéo). Chỉ gửi `task_type` khi setting `embedding.task_type = true` | Gateway tương thích OpenAI đang dùng không nhận tham số này |
| Script Python | TypeScript trong worker (`vault-ingest`, `vault-index`, `vault-decide`, `vault-conflict-notify`) | Dự án không có runtime Python |
| Rerank | Chưa có | Notion chưa chốt. select-answer đã chọn trong vài ứng viên |
| Bản sao file gốc trong `_raw-sources/` | Giữ tệp gốc ở `raw-data/<ngày>_<tên>` | Theo yêu cầu owner: tệp tải lên nằm ở `raw-data/` |
| Gộp qua Telegram bằng force-reply | Nút Gộp chuyển sang Admin Web | Cần xem trước bản AI soạn; nội dung dài không vừa một tin |

## Hệ quả

- Tham số lúc đầu:
  - chunk tối đa 800 token, tối thiểu 100 token;
  - ước lượng 1 token ≈ 3 ký tự;
  - semantic breakpoint cắt ở 20% điểm tương đồng thấp nhất.

  Cần chỉnh sau khi thử dữ liệu thật và bộ 20-30 câu hỏi mẫu (Notion mục 8).
- Trợ lý "Nạp nội dung mới" cũ vẫn còn cho nút **Sửa nội dung** của nội dung đã publish. API tạo nội dung mới không có target
  (`POST /api/kb/intake`) chưa bị gỡ: giao diện không còn gọi nó. Gỡ hẳn và dọn test cũ là việc riêng.
- Chạy với LLM/embedding thật (gemini) tốn phí. Phải hỏi owner trước (bất biến 6).
