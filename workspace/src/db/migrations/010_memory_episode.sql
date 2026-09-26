-- Memory giai đoạn 1 (docs: huong-dan-memory-interlink-bot v3, mục 12).
-- Episode: mã tham chiếu khách nhìn thấy, khoá chủ đề chuẩn hoá (core/items.ts topicKeyOf), điểm neo (tin khách nêu vấn đề),
-- bước gần nhất cho cả template lẫn đoạn tài liệu, số lần hỏi lại trong vụ việc.
ALTER TABLE episodes
  ADD COLUMN ref_code          text,
  ADD COLUMN topic_key         text,
  ADD COLUMN anchor_message_id bigint REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN anchor_query_en   text,
  ADD COLUMN last_ref          text,
  ADD COLUMN clarify_count     int NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX episodes_ref_code_uq ON episodes (ref_code) WHERE ref_code IS NOT NULL;
CREATE INDEX episodes_user_topic_idx ON episodes (user_id, topic_key, last_activity_at DESC);

ALTER TABLE tickets ADD COLUMN episode_ref_code text;
CREATE INDEX tickets_episode_ref_idx ON tickets (episode_ref_code);

-- Hồ sơ khách do code trích (thiết bị, phiên bản app...) và định dạng tin gửi lại (entities của Telegram).
ALTER TABLE users  ADD COLUMN profile  jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE outbox ADD COLUMN entities jsonb;

CREATE INDEX IF NOT EXISTS events_episode_type_idx ON events (episode_id, type, id);

-- Khoá ngoại: xoá episode / tin nhắn cũ theo thời hạn không được vướng dòng tham chiếu (ticket, event bảo mật giữ lâu hơn).
ALTER TABLE messages  DROP CONSTRAINT messages_episode_id_fkey,
  ADD CONSTRAINT messages_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE SET NULL;
ALTER TABLE events    DROP CONSTRAINT events_episode_id_fkey,
  ADD CONSTRAINT events_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE SET NULL;
ALTER TABLE decisions DROP CONSTRAINT decisions_episode_id_fkey,
  ADD CONSTRAINT decisions_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE SET NULL;
ALTER TABLE decisions DROP CONSTRAINT decisions_message_id_fkey,
  ADD CONSTRAINT decisions_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE tickets   DROP CONSTRAINT tickets_episode_id_fkey,
  ADD CONSTRAINT tickets_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE SET NULL;
ALTER TABLE episodes  DROP CONSTRAINT episodes_parent_episode_id_fkey,
  ADD CONSTRAINT episodes_parent_episode_id_fkey FOREIGN KEY (parent_episode_id) REFERENCES episodes(id) ON DELETE SET NULL;
