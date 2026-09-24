-- Lịch sử theo TỪNG PHẦN của nội dung (src/kb/content-history.ts): mỗi lần một phiên bản được áp dụng (publish / rollback),
-- chỉ những phần thật sự đổi (cách khách hỏi, trả lời bước N, điều kiện, nội dung đoạn tài liệu...) được ghi mốc thời gian
-- mới kèm giá trị trước/sau; phần không đổi giữ mốc cũ. Lần đầu (dữ liệu V1) mọi phần được ghi là "created".
CREATE TABLE kb_content_history (
  id            bigserial PRIMARY KEY,
  unit_key      text NOT NULL,            -- "item:<id>" | "chunk:<tài liệu>#<tiêu đề>"
  unit_title    text NOT NULL,
  part          text NOT NULL,            -- tên phần, viết cho người đọc
  change        text NOT NULL CHECK (change IN ('created', 'updated', 'removed')),
  before_value  text,
  after_value   text,
  doc_slug      text NOT NULL,
  version       integer NOT NULL,         -- phiên bản của tài liệu làm thay đổi phần này
  changed_by    text,
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kb_content_history_unit ON kb_content_history (unit_key, part, changed_at DESC);
CREATE INDEX kb_content_history_doc ON kb_content_history (doc_slug);
