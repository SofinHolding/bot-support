-- Loại tài liệu thứ ba trong Kho tri thức: 'guide' = "Hướng dẫn AI làm việc" (bối cảnh, nhiệm vụ, giới hạn... gửi cho AI).
ALTER TABLE kb_documents DROP CONSTRAINT IF EXISTS kb_documents_kind_check;
ALTER TABLE kb_documents ADD CONSTRAINT kb_documents_kind_check CHECK (kind IN ('templates', 'knowledge', 'guide'));
