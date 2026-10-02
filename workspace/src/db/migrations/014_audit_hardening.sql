-- Cost telemetry must distinguish a real/estimated zero from an unknown price.
ALTER TABLE llm_calls
  ADD COLUMN IF NOT EXISTS cost_status text NOT NULL DEFAULT 'unknown'
  CHECK (cost_status IN ('actual','estimated','unknown'));

-- Unknown provider pricing is not a monetary zero. Keep NULL in the raw call so
-- downstream reports cannot silently add an unknown amount as $0.
ALTER TABLE llm_calls
  ALTER COLUMN cost DROP NOT NULL,
  ALTER COLUMN cost DROP DEFAULT;

-- Failed machine translations are remembered so the hourly prewarm job does not
-- spend three LLM calls on the same known-bad template/language pair forever.
CREATE TABLE IF NOT EXISTS translation_failures (
  template_id text NOT NULL,
  lang text NOT NULL,
  source_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_translation_failures_next
  ON translation_failures(next_attempt_at);
