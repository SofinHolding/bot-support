-- Bí mật do Admin Web nhập (vd khoá API của gateway LLM). Giá trị luôn được mã hoá ở tầng ứng dụng (AES-256-GCM); DB không chứa bản rõ.
CREATE TABLE secrets (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
