-- Nhận xét của AI (SKILL review-overlap) cho một cặp nội dung, gắn với NỘI DUNG lúc kiểm tra (hash của cả hai bên).
-- Ghi lúc thêm / sửa nội dung. Luật chặn publish (KbService.reviewGate) đọc bảng này: cặp AI kết luận trùng lặp / xung đột /
-- mâu thuẫn / có thể thay thế thì bản nháp không publish được cho tới khi người duyệt xử lý (kb_pair_decisions) hoặc sửa nội
-- dung và AI kiểm tra lại. Cùng nội dung thì dùng lại nhận xét cũ, không gọi AI lại.
CREATE TABLE kb_pair_reviews (
  id           bigserial PRIMARY KEY,
  a_key        text NOT NULL,            -- "item:<id>" | "chunk:<tài liệu>#<tiêu đề>" (a_key <= b_key)
  a_hash       text NOT NULL,
  a_title      text NOT NULL,
  b_key        text NOT NULL,
  b_hash       text NOT NULL,
  b_title      text NOT NULL,
  verdict      text NOT NULL,
  reason       text,
  suggestion   text,
  reviewed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (a_key, a_hash, b_key, b_hash)
);
CREATE INDEX kb_pair_reviews_a ON kb_pair_reviews (a_key);
CREATE INDEX kb_pair_reviews_b ON kb_pair_reviews (b_key);
