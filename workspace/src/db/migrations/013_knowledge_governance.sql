-- Knowledge Governance: nguồn sự thật độc lập với Obsidian/Vault và độc lập với retrieval engine.
-- RAGFlow/pgvector chỉ là chỉ mục dẫn xuất; production chỉ được phục vụ knowledge_versions.status='active'.

CREATE SEQUENCE IF NOT EXISTS knowledge_generation_seq;

CREATE TABLE knowledge_sources (
  id               uuid PRIMARY KEY,
  file_name        text NOT NULL,
  source_type      text NOT NULL DEFAULT 'upload',
  source_priority  int NOT NULL DEFAULT 50 CHECK (source_priority BETWEEN 0 AND 1000),
  storage_path     text,
  content_hash     text NOT NULL,
  uploaded_by      text,
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  document_date    timestamptz,
  effective_from   timestamptz,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX knowledge_sources_hash_idx ON knowledge_sources (content_hash);
CREATE INDEX knowledge_sources_uploaded_idx ON knowledge_sources (uploaded_at DESC);

-- knowledge_key là identity ngữ nghĩa, scope_key tách các trường hợp cùng chủ đề nhưng điều kiện áp dụng khác nhau.
CREATE TABLE knowledge_units (
  id             uuid PRIMARY KEY,
  knowledge_key  text NOT NULL,
  scope_key      text NOT NULL DEFAULT 'default',
  subject        text NOT NULL DEFAULT '',
  intent         text NOT NULL DEFAULT '',
  condition_key  text NOT NULL DEFAULT '',
  product        text NOT NULL DEFAULT '',
  platform       text NOT NULL DEFAULT '',
  region         text NOT NULL DEFAULT '',
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_key, scope_key)
);
CREATE INDEX knowledge_units_subject_idx ON knowledge_units (subject, intent);

CREATE TABLE knowledge_versions (
  id                     uuid PRIMARY KEY,
  knowledge_unit_id      uuid NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
  source_id               uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE RESTRICT,
  version_number          int NOT NULL CHECK (version_number > 0),
  status                  text NOT NULL CHECK (status IN ('active','superseded','conflicted','duplicate','shadow','rejected')),
  content                 text NOT NULL,
  canonical_title         text NOT NULL DEFAULT '',
  canonical_summary       text NOT NULL DEFAULT '',
  keywords                text[] NOT NULL DEFAULT ARRAY[]::text[],
  language                text NOT NULL DEFAULT 'en',
  source_priority         int NOT NULL CHECK (source_priority BETWEEN 0 AND 1000),
  effective_from          timestamptz,
  effective_to            timestamptz,
  uploaded_at             timestamptz NOT NULL,
  supersedes_id           uuid REFERENCES knowledge_versions(id) ON DELETE SET NULL,
  content_hash            text NOT NULL,
  identity_confidence     numeric(5,4) NOT NULL DEFAULT 1 CHECK (identity_confidence BETWEEN 0 AND 1),
  resolution_reason       text NOT NULL DEFAULT '',
  resolution_action       text NOT NULL DEFAULT '',
  generation              bigint NOT NULL DEFAULT nextval('knowledge_generation_seq'),
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_unit_id, version_number),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

-- Bất biến cốt lõi: một identity/scope chỉ có tối đa một version ACTIVE tại mọi thời điểm.
CREATE UNIQUE INDEX knowledge_versions_one_active
  ON knowledge_versions (knowledge_unit_id)
  WHERE status = 'active';
CREATE INDEX knowledge_versions_unit_status_idx ON knowledge_versions (knowledge_unit_id, status, version_number DESC);
CREATE INDEX knowledge_versions_generation_idx ON knowledge_versions (generation DESC);
CREATE INDEX knowledge_versions_hash_idx ON knowledge_versions (content_hash);

CREATE TABLE knowledge_conflicts (
  id                    bigserial PRIMARY KEY,
  knowledge_unit_id     uuid NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
  active_version_id     uuid REFERENCES knowledge_versions(id) ON DELETE SET NULL,
  candidate_version_id  uuid NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,
  reason                text NOT NULL,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
  resolution            text,
  resolved_by           text,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX knowledge_conflicts_open_candidate
  ON knowledge_conflicts (candidate_version_id)
  WHERE status = 'open';
CREATE INDEX knowledge_conflicts_open_idx ON knowledge_conflicts (status, created_at);

-- Mapping index dẫn xuất. Nếu RAGFlow mất toàn bộ dữ liệu, bảng này có thể xoá và rebuild từ knowledge_versions ACTIVE.
CREATE TABLE knowledge_ragflow_sync (
  version_id       uuid PRIMARY KEY REFERENCES knowledge_versions(id) ON DELETE CASCADE,
  dataset_id       text NOT NULL,
  document_id      text,
  content_hash     text NOT NULL,
  generation       bigint NOT NULL,
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','synced','delete_pending','error')),
  last_error       text,
  synced_at        timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_ragflow_document_idx ON knowledge_ragflow_sync (document_id) WHERE document_id IS NOT NULL;

-- Transactional outbox để Postgres commit trước, RAGFlow đồng bộ sau mà không làm mất event khi worker chết.
CREATE TABLE knowledge_sync_outbox (
  id                bigserial PRIMARY KEY,
  action            text NOT NULL CHECK (action IN ('upsert','delete')),
  version_id        uuid NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,
  generation        bigint NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  attempts          int NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action, version_id, generation)
);
CREATE INDEX knowledge_sync_outbox_due_idx ON knowledge_sync_outbox (status, next_attempt_at, id);
