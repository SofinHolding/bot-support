-- Hệ thống kiến thức mới: "mục hỏi đáp" (kb/items).
-- 1. Loại tài liệu thứ tư: 'items' — mỗi tài liệu là một CHỦ ĐỀ gồm nhiều mục hỏi đáp (YAML, xem src/core/items.ts).
--    Dùng lại nguyên cơ chế phiên bản / publish / hoàn tác của kb_document_versions; khi publish, mục hỏi đáp được dịch sang
--    cấu trúc template đang chạy (bảng templates) nên tìm kiếm, dịch, ticket, kiểm tra hồi quy dùng lại được.
ALTER TABLE kb_documents DROP CONSTRAINT IF EXISTS kb_documents_kind_check;
ALTER TABLE kb_documents ADD CONSTRAINT kb_documents_kind_check CHECK (kind IN ('templates', 'knowledge', 'guide', 'items'));

-- 2. Quyết định của người duyệt về một cặp nội dung bị phát hiện chồng lấn (vd mục hỏi đáp giành câu hỏi của một đoạn tài
--    liệu, hoặc AI thấy hai mục trùng / mâu thuẫn). Quyết định chỉ còn hiệu lực khi NỘI DUNG CẢ HAI BÊN chưa đổi (so hash) —
--    đổi nội dung thì hệ thống hỏi lại, không tự coi là đã xử lý.
CREATE TABLE kb_pair_decisions (
  a_key       text NOT NULL,              -- "item:<id>" | "chunk:<doc>#<heading>" — cặp luôn lưu theo thứ tự a_key < b_key
  b_key       text NOT NULL,
  a_hash      text NOT NULL,
  b_hash      text NOT NULL,
  decision    text NOT NULL CHECK (decision IN ('distinct', 'keep_both', 'merged', 'fixed')),
  note        text,                       -- ngữ cảnh phân biệt / lý do
  decided_by  text NOT NULL,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a_key, b_key)
);

-- 3. Hỏi lại khách khi câu hỏi mơ hồ giữa hai mục đã khai báo là khác nhau: lượt sau chỉ chọn trong các mục này, tối đa 1 lần.
ALTER TABLE episodes ADD COLUMN pending_clarify jsonb;
