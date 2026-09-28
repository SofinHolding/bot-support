-- Vault Obsidian thay luồng "Nạp nội dung mới" (docs/adr/0005). File trong vault là nơi soạn/duyệt; bảng dưới đây là bản
-- để bot/admin đọc (một nơi ghi là worker). Chỉ mục chữ dùng tsvector của Postgres thay cho SQLite FTS5 (cùng DB, có transaction).

-- Mỗi lần admin tải một file lên Admin Web.
CREATE TABLE ingest_batches (
  id           bigserial PRIMARY KEY,
  file_name    text NOT NULL,
  raw_path     text NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  report       jsonb,
  error        text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

-- Bản sao của _meta/index.json kèm thân note (bot đọc thân note gốc để trả lời, không đọc file).
CREATE TABLE vault_notes (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  category      text NOT NULL,
  version_group text NOT NULL,
  status        text NOT NULL,
  lang_source   text NOT NULL,
  ingested_at   timestamptz NOT NULL,
  path          text NOT NULL,
  content_hash  text NOT NULL,
  meta          jsonb NOT NULL,
  body          text NOT NULL,
  batch_id      bigint REFERENCES ingest_batches(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_notes_group_idx ON vault_notes (version_group, status);

-- Chunk của note đang dùng được: chunk_id = <note_id>#<số thứ tự>, dùng chung cho nhánh chữ và nhánh vector.
CREATE TABLE vault_chunks (
  chunk_id      text PRIMARY KEY,
  note_id       text NOT NULL,
  seq           int NOT NULL,
  status        text NOT NULL,
  category      text NOT NULL,
  version_group text NOT NULL,
  path          text NOT NULL,
  lang_source   text NOT NULL,
  ingested_at   timestamptz NOT NULL,
  heading       text NOT NULL DEFAULT '',
  text          text NOT NULL,
  embed_input   text NOT NULL,
  embed_hash    text NOT NULL,
  search_text   text NOT NULL,
  tsv           tsvector NOT NULL
);
CREATE INDEX vault_chunks_note_idx ON vault_chunks (note_id);
CREATE INDEX vault_chunks_status_idx ON vault_chunks (status, category);
CREATE INDEX vault_chunks_tsv_idx ON vault_chunks USING gin (tsv);

-- Vector theo model (định danh gồm cả số chiều): vector của hai model không so sánh được, không bao giờ trộn.
-- embed_hash: hash của nội dung đã embed — trùng thì không gọi API lại.
CREATE TABLE vault_chunk_vectors (
  chunk_id    text NOT NULL REFERENCES vault_chunks(chunk_id) ON DELETE CASCADE,
  model       text NOT NULL,
  embed_hash  text NOT NULL,
  embedding   vector NOT NULL,
  PRIMARY KEY (chunk_id, model)
);

-- Xung đột phát hiện khi nạp (trang Notion "Hướng dẫn xử lý xung đột dữ liệu" mục 8). Admin Web và Telegram cùng đọc bảng này.
CREATE TABLE ingest_conflicts (
  id                 bigserial PRIMARY KEY,
  type               text NOT NULL CHECK (type IN ('in_file', 'tie', 'version')),
  priority           text NOT NULL DEFAULT 'block' CHECK (priority IN ('block', 'low')),
  version_group      text NOT NULL,
  candidates         jsonb NOT NULL,
  active_note_id     text,
  reasons            jsonb NOT NULL DEFAULT '[]'::jsonb,
  batch_id           bigint REFERENCES ingest_batches(id) ON DELETE SET NULL,
  notification_file  text,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent', 'deciding', 'resolved')),
  telegram_messages  jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision           text,
  decision_payload   jsonb,
  decided_by         text,
  decided_at         timestamptz,
  remind_count       int NOT NULL DEFAULT 0,
  last_notified_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
-- Một chủ đề chỉ có một xung đột đang mở: xung đột mới cùng chủ đề gộp vào, không gửi tin thứ hai.
CREATE UNIQUE INDEX ingest_conflicts_open_group ON ingest_conflicts (version_group) WHERE status IN ('open', 'sent', 'deciding');
CREATE INDEX ingest_conflicts_status_idx ON ingest_conflicts (status, created_at);
