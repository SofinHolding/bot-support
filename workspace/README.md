# InterLink Support Bot v2

Bot hỗ trợ khách hàng InterLink trên Telegram, xây lại từ hệ thống OpenClaw cũ theo [docs/de_xuat_kien_truc_moi.md](docs/de_xuat_kien_truc_moi.md).

- **Trả lời nguyên văn** từ nội dung đã duyệt (mục hỏi đáp và tài liệu tham khảo). AI hiểu câu hỏi rồi **chọn** trong danh sách ứng viên, không tự viết câu trả lời; câu khớp chắc chắn bằng cụm nhiều từ/luật đi đường nhanh, có AI xác nhận. Kiến trúc kho nội dung: [docs/KIEN_TRUC_KIEN_THUC.md](docs/KIEN_TRUC_KIEN_THUC.md).
- **Cổng quyết định** bằng code: bảo mật, `requires/excludes`, ngữ cảnh, `response_mode`, kiểm tra đầu ra. Luật không nằm trong prompt.
- **Admin Web**: xem lịch sử theo từng vấn đề, ticket, dashboard/usage; **người quản lý nhập "mục hỏi đáp" bằng form** (nhiều cách hỏi, nhiều bước, khai báo mục dễ lẫn, thử hỏi bot ngay trên form), tài liệu tham khảo bằng `.md` (Draft → 6 bước kiểm tra → Publish, rollback), không cần lập trình viên.
- Toàn bộ dữ liệu ở **PostgreSQL + pgvector** thay cho ~20.000 file JSON.
- Ràng buộc của hệ thống cũ được truy vết đầy đủ ở [docs/RANG_BUOC.md](docs/RANG_BUOC.md).
- Hướng dẫn dùng Admin Web cho người vận hành (không cần biết code): [docs/HUONG_DAN_ADMIN_WEB.md](docs/HUONG_DAN_ADMIN_WEB.md).

## Kiến trúc

```mermaid
flowchart LR
    U["Telegram"] --> BOT["Bot Service<br/>webhook · gom tin · pipeline"]
    BOT --> PG[("PostgreSQL + pgvector")]
    BOT -.->|"tầng 2-3"| LLM["LLM (Anthropic + dự phòng)"]
    ADM["Admin Web (SPA) + API"] --> PG
    WK["Worker<br/>cron · hàng đợi · tóm tắt · dọn dẹp"] --> PG
    WK -.-> TG2["Telegram (cảnh báo owner)"]
```

Ba khối chạy từ cùng một image (`dist/bot.js`, `dist/admin.js`, `dist/worker.js`). Hàng đợi việc nền nằm trong Postgres (`jobs`, `FOR UPDATE SKIP LOCKED`), không cần Redis.

```
src/
  core/     luật quyết định thuần (không I/O): sanitize (FP-0), antispam, language, router, gate, follow-up, templates
  bot/      pipeline xử lý tin, Telegram, gom tin, episode, resolver (dịch một lần)
  kb/       kho tri thức: parse, kiểm tra, publish, rollback, eval, seed
  llm/      gateway LLM (9router, OpenAI-compatible) cấu hình được từ Admin Web + Anthropic dự phòng tuỳ chọn, circuit breaker, embedding
  db/       migration SQL, repository (pg và PGlite dùng chung một bộ SQL)
  admin/    Admin API (Fastify) + web tĩnh (src/admin/web)
  worker/   lịch, job, runner
content/    templates/*.md (nội dung được duyệt) · knowledge/*.md · config/predicates.yml · eval/
legacy/     luật cũ (AGENTS.md, skills) — nguồn đối chiếu cho `npm run parity`
docs/       mô tả hệ thống, kiến trúc, ma trận ràng buộc
tests/      test tự động (Postgres thật bằng PGlite, gồm cả đường driver `pg`)
```

## Chạy thử nhanh (một tiến trình, không cần Docker)

```bash
npm install
cp .env.example .env        # điền TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_IDS, OWNER_TELEGRAM_ID
                            # DATABASE_URL=pglite:./data/pgdata, TELEGRAM_MODE=polling
npm run seed                # nạp template, tri thức, predicate, admin, bộ câu hỏi mẫu (idempotent)
npm run dev:bot             # nhận tin Telegram (polling)
npm run dev:admin           # http://localhost:3001
npm run dev:worker
```

> PGlite là Postgres nhúng, **chỉ một tiến trình mở được một thư mục dữ liệu**. Muốn chạy cả ba khối cùng lúc hãy dùng Postgres thật (Docker Compose bên dưới hoặc `DATABASE_URL=postgres://...`).

## Triển khai (Docker Compose)

```bash
cp .env.example .env        # điền đủ; TELEGRAM_MODE=webhook, TELEGRAM_WEBHOOK_SECRET, PUBLIC_BOT_URL, COOKIE_SECURE=true, TRUST_PROXY=true
docker compose up -d --build
```

Đặt `bot` (cổng 3000) và `admin` (cổng 3001) sau reverse proxy HTTPS. Không publish cổng Postgres.

**Đăng nhập Admin Web:** mở trang quản trị → nhập Telegram ID → bot gửi mã 6 số vào chính chat Telegram của bạn (hết hạn 5 phút) → nhập mã. Không có mật khẩu để lộ. Vai trò: `owner` (Anh Phi) · `admin` · `viewer` (chỉ xem, ID khách bị che).

## Thêm / sửa nội dung không cần lập trình viên

Trong Admin Web → **Kho tri thức**: tải hoặc soạn file `.md` → **Kiểm tra** → **Publish**. Bot dùng ngay, không khởi động lại.

Định dạng template (một file có thể chứa nhiều template, ngăn cách bằng `<!-- next -->`):

```markdown
---
id: withdraw-question
group: Withdraw
response_mode: EXACT_TEMPLATE        # EXACT_TEMPLATE | GROUNDED_GENERATION | SECURITY_RULE
priority: 880                        # cao hơn = ưu tiên khi trùng
match:
  keywords: [withdraw, rút tiền]     # cụm từ (bỏ dấu, khớp theo ranh giới từ)
  examples: ["how do I take my tokens out"]
  excludes: [completed_level_1]      # predicate/điều kiện loại trừ (content/config/predicates.yml)
follow_up: { negative: ESCALATE, thanks: you-are-welcome }
sets_context: { issue: withdraw availability, status: pending }
---
<!-- answer:en -->
Câu trả lời nguyên văn gửi cho khách.
<!-- answer:vi -->
(tuỳ chọn) bản tiếng Việt đã duyệt
```

Sáu bước kiểm tra trước khi Publish: cấu trúc · quét an toàn (secret, script, URL lạ) · trùng/mâu thuẫn · bản dịch · **hồi quy** (so với bộ câu hỏi mẫu) · **replay** (14 ngày tin nhắn thật). Bản có `SECURITY_RULE` chỉ `owner` đề xuất và cần **người thứ hai duyệt**.

Tài liệu tri thức (whitepaper...) dùng `response_mode: GROUNDED_GENERATION`, xem `content/knowledge/`.

### Hướng dẫn AI làm việc

Kho tri thức → tab **Hướng dẫn AI làm việc**: một tài liệu duy nhất (slug `agent-guide`, bản mặc định ở `content/guide/agent-guide.md`) cho AI biết bối cảnh, nhiệm vụ, cách giao tiếp, mục tiêu, giới hạn và quy trình. Bắt buộc đủ 6 mục `## 1.` … `## 6.`; mỗi việc của AI chỉ nhận mục liên quan (phân loại: 1, 2, 5 · tri thức: 1, 3, 5 · tóm tắt: 1, 4 · dịch: 3). Admin soạn và đề xuất, **một người khác phải duyệt** thì mới có hiệu lực (không cần khởi động lại). Tài liệu này là bối cảnh: nó không đổi được luật do code cưỡng chế, và bước Kiểm tra chặn câu cho phép điều hệ thống cấm (dự đoán giá, lộ công thức HCS, xin seed/mật khẩu, dùng kiến thức chung, bỏ qua luật).

## Lệnh hữu ích

| Lệnh | Việc |
|---|---|
| `npm test` | Chạy toàn bộ test (Postgres thật bằng PGlite, kênh Telegram và LLM giả) |
| `npm run typecheck` | Kiểm tra kiểu |
| `npm run parity` | Đối chiếu nguyên văn mọi câu trả lời cố định với `legacy/` |
| `npm run eval` | Độ chính xác tầng 0–1 trên bộ câu hỏi mẫu (không tốn token) |
| `npm run eval:live -- [tệp.jsonl] [--mode=hybrid]` | Eval **qua LLM và embedding thật** (cấu hình trong `.env`), báo cáo đúng/sai theo nhánh FAST PATH / AI-RAG, theo ngôn ngữ, độ trễ, token. DB tạm, không gửi tin cho ai. Mặc định chạy `content/eval/handwritten.jsonl` |
| `npm run check:live` | 13 tình huống đa ngôn ngữ qua LLM thật, in từng bước quyết định |
| `npm run bench:embedding` | Đo embedding model đang chạy trên câu hỏi 12 ngôn ngữ (cần service `embedding` đang chạy) |
| `npm run build` | Đóng gói vào `dist/` |
| `npm run migrate` | Áp dụng migration SQL |

## Không có LLM thì sao?

Bot vẫn chạy: FP-0, chống spam, mọi template khớp từ khoá/rule/ảnh (cần vision để đọc ảnh), follow-up. Câu không khớp được chuyển người thật (FP-12 + ticket). Có gateway LLM (9router: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL_FAST`, `LLM_MODEL_STRONG` trong `.env`, hoặc nhập trong Admin Web → Cấu hình → Mô hình LLM) thì bật thêm phân loại câu diễn đạt tự nhiên, đọc ảnh, dịch template, tóm tắt cuộn.

## LLM và embedding

- **LLM** đi qua 9router. Giá trị trong `.env` chỉ là mặc định; admin đổi `LLM_MODEL_FAST`/`LLM_MODEL_STRONG` (chọn từ danh sách model 9router đang cung cấp, có nút Thử) trên web, owner đổi URL và khoá API (khoá được mã hoá bằng `SECRETS_KEY`, không hiển thị lại). Bot/admin/worker đọc lại cấu hình từ DB mỗi ~10 giây nên không cần khởi động lại.
- **Embedding**: người vận hành **chọn đúng một model** trong Admin Web → Cấu hình → Embedding — **API ngoài** tương thích OpenAI (vd `https://platform.beeknoee.com/v1`, model `gemini-embedding-001`; owner đặt URL và khoá mã hoá bằng `SECRETS_KEY`, admin đổi model/số chiều, có nút Thử) hoặc **cục bộ** `BAAI/bge-m3` trong service `embedding` của docker-compose (`EMBEDDING_URL`/`EMBEDDING_MODEL` trong `.env`). Kho tri thức và câu hỏi của khách luôn dùng cùng model đã chọn; vector của hai model không so sánh được nên kho phân vùng vector theo model (bảng `kb_chunk_embeddings`) và job `reindex-embeddings` chỉ đánh chỉ mục cho model đang chọn (mỗi 10 phút, hoặc bấm "Đánh chỉ mục lại"). **Không có dự phòng ngầm**: API ngoài lỗi hẳn thì hệ thống tự chuyển hẳn sang cục bộ, đánh chỉ mục lại toàn bộ nội dung đã publish, **khoá** lựa chọn API và hiện cảnh báo đỏ; admin kiểm tra rồi bấm "Thử API & mở khoá" mới chọn lại được API. Đổi model nên chạy `npm run bench:embedding` để hiệu chỉnh ngưỡng `router.semantic_*`.

## Cần biết trước khi chuyển kênh

Xem mục 6 của [docs/RANG_BUOC.md](docs/RANG_BUOC.md): những gì **chưa** được kiểm chứng (độ trễ/độ chính xác trên traffic thật, LLM/embedding/Telegram thật, Docker Compose). Bộ câu hỏi mẫu hiện có 215 câu là bộ khởi điểm; nên bổ sung ~300 câu thật từ transcript cũ rồi chạy giai đoạn shadow.
