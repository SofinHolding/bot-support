-- Xung đột nội dung ĐÃ PUBLISH: chốt lại tại thời điểm Publish (người dùng thấy cảnh báo ở bước 3 nhưng vẫn chọn đưa lên).
-- Không phải kết quả của "Quét chồng lấn toàn kho" (đó là phiên tạm thời, không lưu); bảng này là để hiển thị dấu hiệu
-- xung đột NGAY trên danh sách Tài liệu, không cần bấm quét thủ công. Mỗi lần một tài liệu (a_doc hoặc b_doc) publish lại,
-- toàn bộ dòng cũ liên quan tới tài liệu đó chuyển 'resolved' rồi ghi lại bộ hiện tại (xem KbRepo.syncConflicts).
CREATE TABLE kb_conflicts (
  id          bigserial PRIMARY KEY,
  pair_key    text NOT NULL,
  a_kind      text NOT NULL,
  a_id        text NOT NULL,
  a_doc       text NOT NULL,
  a_title     text NOT NULL,
  b_kind      text NOT NULL,
  b_id        text NOT NULL,
  b_doc       text NOT NULL,
  b_title     text NOT NULL,
  score       double precision NOT NULL,
  signals     jsonb NOT NULL,
  -- {"templateId","phrase"}: có thể GỠ MÁY MÓC một từ khoá/câu mẫu cụ thể khỏi một template để hết xung đột này (xem
  -- kb/overlap.ts narrowTemplateMatch). Không có với xung đột giữa hai đoạn tri thức (văn xuôi, không tự sửa được).
  narrow      jsonb,
  verdict     text,
  reason      text,
  suggestion  text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX kb_conflicts_a_doc_open_idx ON kb_conflicts (a_doc) WHERE status = 'open';
CREATE INDEX kb_conflicts_b_doc_open_idx ON kb_conflicts (b_doc) WHERE status = 'open';
CREATE INDEX kb_conflicts_pair_open_idx ON kb_conflicts (pair_key) WHERE status = 'open';
