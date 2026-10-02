-- Retrieval index format v2 adds explicit customer phrasings to the derived RAGFlow chunk.
-- Requeue each currently active version once. PostgreSQL remains the source of truth; this only
-- refreshes the disposable derived index and does not alter knowledge content/version history.
INSERT INTO knowledge_sync_outbox (action, version_id, generation, status, attempts, next_attempt_at, last_error, updated_at)
SELECT 'upsert', v.id, v.generation, 'pending', 0, now(), NULL, now()
FROM knowledge_versions v
WHERE v.status='active'
ON CONFLICT (action, version_id, generation) DO UPDATE SET
  status='pending',
  attempts=0,
  next_attempt_at=now(),
  last_error=NULL,
  updated_at=now();
