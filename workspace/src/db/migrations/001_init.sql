-- Schema ban đầu. Chạy được trên PostgreSQL 15+ có pgvector và trên PGlite (dùng cho test).

CREATE EXTENSION IF NOT EXISTS vector;

-- ===== Người dùng & quyền =====================================================
CREATE TABLE users (
  telegram_id  bigint PRIMARY KEY,
  name         text,
  username     text,
  language     text,
  flags        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- security_alerted, ...
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  seen_count   int NOT NULL DEFAULT 0
);

CREATE TABLE admins (
  telegram_id  bigint PRIMARY KEY,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  name         text,
  added_at     timestamptz NOT NULL DEFAULT now()
);

-- Chống spam / off-topic (thay memory/antispam/{uid}.json)
CREATE TABLE antispam (
  user_id        bigint PRIMARY KEY,
  offtopic_count int NOT NULL DEFAULT 0,
  blocked_until  timestamptz,
  last_seen      timestamptz NOT NULL DEFAULT now()
);

-- ===== Hội thoại =============================================================
CREATE TABLE episodes (
  id                       bigserial PRIMARY KEY,
  user_id                  bigint NOT NULL REFERENCES users(telegram_id),
  parent_episode_id        bigint REFERENCES episodes(id),
  issue                    text,
  topic_group              text,
  status                   text NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'dormant', 'resolved', 'escalated', 'security_alerted')),
  summary                  jsonb,
  summary_version          int NOT NULL DEFAULT 0,
  summary_upto_message_id  bigint,
  last_template_id         text,
  last_bot_action          text,
  opened_at                timestamptz NOT NULL DEFAULT now(),
  last_activity_at         timestamptz NOT NULL DEFAULT now(),
  closed_at                timestamptz
);
CREATE INDEX episodes_user_activity ON episodes (user_id, last_activity_at DESC);
CREATE INDEX episodes_status_activity ON episodes (status, last_activity_at);

CREATE TABLE messages (
  id                    bigserial PRIMARY KEY,
  episode_id            bigint REFERENCES episodes(id),
  user_id               bigint NOT NULL,
  direction             text NOT NULL CHECK (direction IN ('in', 'out')),
  text                  text,                 -- ĐÃ che dữ liệu nhạy cảm
  image_ref             text,
  image_type            text,
  language              text,
  tier                  smallint,
  template_id           text,
  telegram_message_id   bigint,
  latency_ms            int,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_episode ON messages (episode_id, id);
CREATE INDEX messages_user_time ON messages (user_id, created_at DESC);
CREATE INDEX messages_created ON messages (created_at);

-- Nguồn sự thật cho trạng thái nghiệp vụ: do CODE ghi, không do LLM.
CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL,
  episode_id  bigint REFERENCES episodes(id),
  type        text NOT NULL,     -- template_sent, image_received, ticket_created, antispam_warning, antispam_block, antispam_unblock, security_alert...
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_episode ON events (episode_id, id);
CREATE INDEX events_user_type ON events (user_id, type, at DESC);

-- Vì sao bot trả lời như vậy (hiển thị trên Admin Web)
CREATE TABLE decisions (
  id          bigserial PRIMARY KEY,
  message_id  bigint REFERENCES messages(id),
  episode_id  bigint REFERENCES episodes(id),
  user_id     bigint NOT NULL,
  kind        text NOT NULL,     -- TEMPLATE | ESCALATE | GROUNDED | SECURITY | BLOCKED | OFFTOPIC | IGNORE
  tier        smallint,
  template_id text,
  via         text,
  reason      text,
  candidates  jsonb,
  gates       jsonb,
  notes       jsonb,
  kb_version  int,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_created ON decisions (created_at);
CREATE INDEX decisions_kind_created ON decisions (kind, created_at);
CREATE INDEX decisions_template ON decisions (template_id, created_at);

-- Idempotency cho webhook Telegram
CREATE TABLE inbound_updates (
  telegram_update_id bigint PRIMARY KEY,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  status             text NOT NULL DEFAULT 'received'
);

CREATE TABLE tickets (
  id                 bigserial PRIMARY KEY,
  episode_id         bigint REFERENCES episodes(id),
  user_id            bigint NOT NULL,
  category           text,
  error_code         text,
  pic                text,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed')),
  reason             text,
  required_info      jsonb,
  source_template_id text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_status ON tickets (status, created_at DESC);
CREATE INDEX tickets_user ON tickets (user_id, created_at DESC);

-- Hộp thư đi: retry khi Telegram lỗi, dead-letter khi quá số lần
CREATE TABLE outbox (
  id          bigserial PRIMARY KEY,
  chat_id     bigint NOT NULL,
  text        text NOT NULL,
  dedupe_key  text UNIQUE,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'dead')),
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  next_at     timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX outbox_due ON outbox (status, next_at);

-- Mỗi lời gọi LLM (tính token, chi phí, độ trễ)
CREATE TABLE llm_calls (
  id            bigserial PRIMARY KEY,
  message_id    bigint,
  user_id       bigint,
  purpose       text NOT NULL,      -- vision | classify | grounded | translate | summarize | embed
  provider      text,
  model         text,
  input_tokens  int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cache_read    int NOT NULL DEFAULT 0,
  cache_write   int NOT NULL DEFAULT 0,
  cost          numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms    int,
  ok            boolean NOT NULL DEFAULT true,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_created ON llm_calls (created_at);
CREATE INDEX llm_calls_user_created ON llm_calls (user_id, created_at);

CREATE TABLE usage_daily (
  day           date PRIMARY KEY,           -- theo giờ Asia/Bangkok, như báo cáo cũ
  requests      int NOT NULL DEFAULT 0,
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read    bigint NOT NULL DEFAULT 0,
  cache_write   bigint NOT NULL DEFAULT 0,
  total_tokens  bigint NOT NULL DEFAULT 0,
  cost          numeric(14, 6) NOT NULL DEFAULT 0,
  unique_users  int NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ===== Kho tri thức ==========================================================
CREATE TABLE kb_documents (
  slug          text PRIMARY KEY,
  title         text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('templates', 'knowledge')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kb_document_versions (
  id                        bigserial PRIMARY KEY,
  slug                      text NOT NULL REFERENCES kb_documents(slug),
  version                   int NOT NULL,
  source_md                 text NOT NULL,
  status                    text NOT NULL CHECK (status IN ('draft', 'pending_approval', 'published', 'archived', 'rejected')),
  requires_second_approval  boolean NOT NULL DEFAULT false,
  author                    text,
  approved_by               text,
  report                    jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  published_at              timestamptz,
  UNIQUE (slug, version)
);
CREATE UNIQUE INDEX kb_one_published ON kb_document_versions (slug) WHERE status = 'published';

-- Template đã parse của mỗi phiên bản tài liệu (definition = Template dạng JSON)
CREATE TABLE templates (
  id          text NOT NULL,
  version_id  bigint NOT NULL REFERENCES kb_document_versions(id) ON DELETE CASCADE,
  doc_slug    text NOT NULL,
  definition  jsonb NOT NULL,
  PRIMARY KEY (id, version_id)
);

-- Bản dịch dịch một lần rồi lưu; gắn source_hash để biết khi bản gốc đổi
CREATE TABLE template_translations (
  template_id  text NOT NULL,
  lang         text NOT NULL,
  text         text NOT NULL,
  source_hash  text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  origin       text NOT NULL DEFAULT 'llm' CHECK (origin IN ('llm', 'human')),
  approved_by  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, lang)
);

CREATE TABLE kb_chunks (
  id                 bigserial PRIMARY KEY,
  version_id         bigint NOT NULL REFERENCES kb_document_versions(id) ON DELETE CASCADE,
  doc_slug           text NOT NULL,
  chunk_index        int NOT NULL,
  chunk_hash         text NOT NULL,
  heading            text NOT NULL,
  text               text NOT NULL,
  url                text,
  search_text        text NOT NULL,                 -- đã bỏ dấu, dùng cho tìm kiếm từ khoá
  tsv                tsvector NOT NULL,
  embedding          vector,
  embedding_model    text,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX kb_chunks_version ON kb_chunks (version_id);
CREATE INDEX kb_chunks_tsv ON kb_chunks USING gin (tsv);

CREATE TABLE embedding_cache (
  hash      text NOT NULL,
  embedder  text NOT NULL,
  vector    jsonb NOT NULL,
  PRIMARY KEY (hash, embedder)
);

CREATE TABLE eval_cases (
  id                    bigserial PRIMARY KEY,
  question              text NOT NULL,
  expected_template_id  text,           -- NULL = kỳ vọng ESCALATE
  image_type            text,
  lang                  text,
  source                text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ===== Cấu hình, quản trị, kiểm toán ========================================
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE protected_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- Thay đổi cần người thứ hai duyệt (cấu hình được bảo vệ, template SECURITY_RULE)
CREATE TABLE pending_changes (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('protected_setting', 'kb_publish', 'admin_change')),
  payload      jsonb NOT NULL,
  proposed_by  bigint NOT NULL,
  proposed_at  timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by   bigint,
  decided_at   timestamptz
);

CREATE TABLE audit_log (
  id      bigserial PRIMARY KEY,
  actor   text NOT NULL,
  action  text NOT NULL,
  entity  text,
  before  jsonb,
  after   jsonb,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_at ON audit_log (at DESC);

CREATE TABLE admin_login_codes (
  telegram_id bigint NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_login_codes_tg ON admin_login_codes (telegram_id, created_at DESC);

CREATE TABLE admin_sessions (
  token_hash   text PRIMARY KEY,
  telegram_id  bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen    timestamptz NOT NULL DEFAULT now()
);

-- ===== Việc nền ==============================================================
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at        timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'dead')),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 5,
  locked_at     timestamptz,
  last_error    text,
  dedupe_key    text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX jobs_due ON jobs (status, run_at);

CREATE TABLE cron_state (
  name         text PRIMARY KEY,
  last_run_at  timestamptz,
  last_status  text,
  last_error   text,
  last_result  jsonb
);

CREATE TABLE weekly_stats (
  week_start           date PRIMARY KEY,           -- thứ Hai, giờ Asia/Bangkok
  total_conversations  int NOT NULL,
  top_issues           jsonb NOT NULL,
  new_questions        int NOT NULL,
  unresolved           int NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE broadcasts (
  id          bigserial PRIMARY KEY,
  created_by  bigint NOT NULL,
  text        text NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'done', 'cancelled')),
  total       int NOT NULL DEFAULT 0,
  sent        int NOT NULL DEFAULT 0,
  failed      int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
