# Python + Knowledge Governance + RAGFlow migration

## Mục tiêu

Migration này không thực hiện big-bang rewrite. Python nhận quyền sở hữu **Knowledge Governance + retrieval** trước,
trong khi Node/TypeScript tiếp tục giữ Telegram, security, idempotency, episode, conversation state, LLM gateway và
output guard cho tới khi từng khối có parity test.

Nguyên tắc:

- PostgreSQL là source of truth.
- RAGFlow là derived search index; có thể xoá/rebuild.
- Mỗi `knowledge_key + scope_key` chỉ có tối đa một `active` version.
- Version cũ được giữ `superseded`, không overwrite/delete.
- RAGFlow hit luôn được revalidate với PostgreSQL trước khi trở thành evidence.
- Dữ liệu upload mới được xử lý tự động theo precedence, không bắt người dùng duyệt mỗi lần.

## Precedence tự động

Thứ tự quyết định:

1. Identity confidence thấp hơn ngưỡng -> `conflicted` (fail closed).
2. Content hash giống active -> `duplicate`.
3. Source priority cao hơn -> supersede.
4. Source priority thấp hơn -> `shadow`, không thay active.
5. Cùng priority: `effective_from` mới hơn thắng; cũ hơn không thắng.
6. Nếu không có effective date để phân biệt: upload mới hơn thắng (controlled latest-wins).
7. Vẫn không phân biệt được -> `conflicted`.

Ví dụ `forgot ID`: bản cũ “contact support” và bản mới “self recovery” cùng identity/scope, cùng authority, bản mới
có effective/upload time mới hơn -> bản cũ `superseded`, bản mới `active` trong **một DB transaction**.

## Biến môi trường Python

```text
DATABASE_URL=postgres://support:...@db:5432/support
INTERNAL_SERVICE_TOKEN=<random internal token>

KNOWLEDGE_LLM_BASE_URL=http://host.docker.internal:20128/v1
KNOWLEDGE_LLM_API_KEY=...
KNOWLEDGE_LLM_MODEL=<fast structured-output-capable model>
KNOWLEDGE_IDENTITY_MIN_CONFIDENCE=0.78
KNOWLEDGE_DEFAULT_SOURCE_PRIORITY=50

RAGFLOW_ENABLED=true
RAGFLOW_BASE_URL=http://host.docker.internal:9380
RAGFLOW_API_KEY=...
RAGFLOW_DATASET_ID=...
RAGFLOW_RERANK_ID=
RAGFLOW_TIMEOUT_SECONDS=30
RAGFLOW_CONNECT_TIMEOUT_SECONDS=5
RAGFLOW_POOL_TIMEOUT_SECONDS=5
RAGFLOW_MAX_CONNECTIONS=16
RAGFLOW_MAX_KEEPALIVE_CONNECTIONS=8
RAGFLOW_MAX_CONCURRENCY=8
RAGFLOW_SIMILARITY_THRESHOLD=0.2
RAGFLOW_VECTOR_WEIGHT=0.5
RAGFLOW_KEYWORD=false
```

Dataset RAGFlow nên cấu hình embedding bằng gateway OpenAI-compatible hiện có và model
`text-embedding-3-small` (hoặc đúng model ID mà gateway expose, ví dụ `openai/text-embedding-3-small`).
`RAGFLOW_KEYWORD=false` là mặc định cho triển khai embedding-only; bật keyword extraction của RAGFlow sẽ yêu cầu
thêm một default chat model trong RAGFlow.

Client retrieval dùng connection pool/keep-alive dùng lại giữa các request và một semaphore cục bộ để không dồn
vượt `RAGFLOW_MAX_CONCURRENCY` request vào upstream. `RAGFLOW_TIMEOUT_SECONDS` là **total request budget**, không
phải cách che latency bằng cách tăng timeout. Connect/pool timeout có budget riêng. Timeout/network/HTTP 5xx từ
RAGFlow được chuyển thành lỗi tạm thời có kiểm soát (`503` ở Knowledge API) kèm `X-Request-ID`; retrieval không
tự retry để tránh retry storm. Caller có thể retry ở biên request nếu có idempotency/backoff phù hợp.

## Cost telemetry cho gateway alias

Các alias gateway như `cx/...` không có giá đáng tin cậy trong source code thì được ghi `cost_status=unknown` và
`cost=NULL`; báo cáo hiển thị `N/A`, không cộng thành `$0`. Nếu operator có bảng giá đã xác minh, có thể cấu hình:

```text
LLM_PRICING_JSON={"provider/model":{"in":1.0,"out":4.0}}
```

`in`/`out` là USD trên 1 triệu input/output token. Giá cấu hình được đánh dấu `estimated`; chỉ dữ liệu do provider
trả trực tiếp mới nên được gọi là `actual`. Không đưa giá alias chưa xác minh vào repository.

## Nguồn canonical hiện tại

Nguồn production chuẩn là `raw-data/2026-09-29_V1-nguon-sach.xlsx`, sheet `Noi dung V1` với ba cột
`Tên`, `Khách thường hỏi`, `Nội dung`. Thư mục `content/` là bản mirror phục vụ cấu hình/template/audit và không
được ingest lần thứ hai vào Knowledge Governance, tránh tạo hai bản semantic giống nhau trong retrieval.

Import sạch toàn bộ Governance:

```text
interlink-import-clean-source raw-data/2026-09-29_V1-nguon-sach.xlsx --replace
```

Importer tạo một `knowledge_key` ổn định theo `Tên`, giữ các câu trong `Khách thường hỏi` làm retrieval aliases,
và giữ nguyên `Nội dung` làm evidence chính thức. Hai topic khác nhau vẫn là hai knowledge unit riêng ngay cả khi
chúng cố ý dùng chung cùng một câu trả lời/chuyển nhân viên. Với `RAGFLOW_ENABLED=true`, `--replace` xoá dataset
dẫn xuất trên RAGFlow trước rồi mới reset Governance; nếu không xoá được RAGFlow thì lệnh dừng trước khi chạm DB.

## Feature flag Node

```text
KNOWLEDGE_SERVICE_URL=http://knowledge-api:3010
INTERNAL_SERVICE_TOKEN=<same token>

RETRIEVAL_PROVIDER=legacy  # production cũ
RETRIEVAL_PROVIDER=shadow  # production vẫn trả legacy, Python chỉ chạy đối chiếu/log
RETRIEVAL_PROVIDER=python  # cutover sang Python/RAGFlow
```

Không có silent fallback khi chọn `python`. Muốn rollback thì đổi `RETRIEVAL_PROVIDER=legacy` và restart service.

## Rollout

1. Chạy migration 013 và Python unit tests.
2. Deploy RAGFlow riêng, pin release/image cụ thể.
3. Tạo dataset, cấu hình `text-embedding-3-small` + reranker nếu dùng.
4. Bật profile `python-rag`, ingest knowledge vào PostgreSQL và để outbox sync RAGFlow.
5. Đặt Node `RETRIEVAL_PROVIDER=shadow`, thu log/eval Recall@k/MRR/P95.
6. Khi đạt acceptance criteria, chuyển `RETRIEVAL_PROVIDER=python`.
7. Vault/Obsidian không còn được cron tự index sau cutover; dữ liệu cũ chỉ giữ cho audit/migration. Sau một số
   release ổn định có thể retire nốt các handler/file legacy còn lại.

## API nội bộ Python

- `POST /v1/knowledge/upload`: upload TXT/MD/JSON/CSV/PDF/DOCX/XLSX, tự tách atomic knowledge và resolve version.
- `POST /v1/knowledge/units`: internal/test/migration path cho atomic units có sẵn.
- `GET /v1/knowledge/conflicts`: chỉ các case hệ thống không thể resolve an toàn.
- `POST /v1/knowledge/rollback/{version_id}`: rollback append-only, tạo active version mới từ lịch sử.
- `POST /v1/retrieval/search`: adapter RAGFlow + active-version revalidation.
- `POST /v1/retrieval/by-ids`: chỉ trả version vẫn còn active.
