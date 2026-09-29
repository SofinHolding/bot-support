-- Gộp / nhập lại qua Telegram bằng force-reply (trang Notion "Hướng dẫn xử lý xung đột dữ liệu" mục 5): bot hỏi lại
-- ("Nhập nội dung đúng"), admin trả lời đúng tin đó, bot khớp bằng prompt_message_id rồi gửi bản xem trước + nút Xác nhận/Huỷ.
CREATE TABLE vault_merge_prompts (
  id                  bigserial PRIMARY KEY,
  conflict_id         bigint NOT NULL REFERENCES ingest_conflicts(id) ON DELETE CASCADE,
  chat_id             bigint NOT NULL,
  admin_id            bigint NOT NULL,
  prompt_message_id   bigint NOT NULL,
  preview_message_id  bigint,
  status              text NOT NULL DEFAULT 'awaiting_text' CHECK (status IN ('awaiting_text', 'awaiting_confirm', 'done', 'cancelled')),
  draft_note          jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- Khớp tin admin trả lời với đúng tin bot vừa hỏi (mỗi chat + message chỉ một prompt).
CREATE UNIQUE INDEX vault_merge_prompts_prompt_idx ON vault_merge_prompts (chat_id, prompt_message_id);
