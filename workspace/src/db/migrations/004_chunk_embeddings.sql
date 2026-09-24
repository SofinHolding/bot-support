-- Mỗi đoạn tri thức có thể có vector của NHIỀU model (embedding ngoài là chính, embedding cục bộ là dự phòng).
-- Vector của hai model không so sánh được: tìm kiếm luôn dùng bộ vector của đúng model đã tạo vector câu hỏi.
CREATE TABLE kb_chunk_embeddings (
  chunk_id   bigint NOT NULL REFERENCES kb_chunks(id) ON DELETE CASCADE,
  model      text NOT NULL,
  embedding  vector NOT NULL,
  PRIMARY KEY (chunk_id, model)
);
INSERT INTO kb_chunk_embeddings (chunk_id, model, embedding)
  SELECT id, embedding_model, embedding FROM kb_chunks WHERE embedding IS NOT NULL AND embedding_model IS NOT NULL;
