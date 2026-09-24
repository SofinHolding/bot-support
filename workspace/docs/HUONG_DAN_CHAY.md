# Hướng dẫn chạy dự án sau khi điền API key

Áp dụng cho bản dùng **9router** làm LLM và **bge-m3** làm embedding (xem mục 12 của [de_xuat_kien_truc_moi.md](de_xuat_kien_truc_moi.md)). Mọi lệnh chạy trong thư mục `workspace/`.

## 0. Cần có

| Thứ | Kiểm tra |
|---|---|
| Docker Desktop đang chạy | `docker info` |
| 9router đang chạy trên máy này, cổng 20128 | `curl http://localhost:20128/v1/models` trả về danh sách model |
| Telegram bot token, ID admin, ID owner | Đã điền trong `.env` (`TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_IDS`, `OWNER_TELEGRAM_ID`) |

## 1. Điền API key

Lấy API key trong dashboard 9router, rồi chọn **một** trong hai cách:

**Cách A — trong `.env`** (khuyến nghị cho lần chạy đầu):

```
LLM_API_KEY=sk-...                       # key của 9router
LLM_MODEL_FAST=cx/gpt-5.4-mini           # đổi được sau trên web
LLM_MODEL_STRONG=cx/gpt-5.5
```

**Cách B — trên web** (sau khi hệ thống chạy, bước 3): Cấu hình → Mô hình LLM → ô "Khoá API" → Lưu kết nối. Chỉ tài khoản `owner` làm được. Khoá được mã hoá bằng `SECRETS_KEY` trong `.env`, không hiển thị lại. Khoá nhập trên web **ghi đè** khoá trong `.env`.

Đừng đổi `SECRETS_KEY` sau khi đã lưu khoá từ web, nếu không khoá đã lưu mất hiệu lực (hệ thống sẽ quay về `LLM_API_KEY`).

## 2. Khởi động

```bash
docker compose up -d --build
```

Lần đầu sẽ build ảnh, áp dụng migration và khởi động 5 service: `db`, `embedding`, `bot`, `admin`, `worker`. Service `embedding` dùng volume `embedding-models` (đã có model bge-m3, ~2,1 GB). Nếu volume bị xoá, lần đầu nó tự tải lại ~2,3 GB và mất vài phút mới khoẻ.

Kiểm tra:

```bash
docker compose ps
```

Cả `db`, `embedding`, `bot`, `admin` phải hiện `healthy`. Có thể thử nhanh:

```bash
curl http://localhost:3001/healthz
curl http://localhost:3000/healthz
```

Sau này sửa `.env` thì chạy lại `docker compose up -d` để container nhận giá trị mới (chỉ restart thì không đủ).

## 3. Đăng nhập Admin Web và thử LLM

1. Mở `http://localhost:3001` (hoặc `PUBLIC_ADMIN_URL` nếu đã đặt sau HTTPS).
2. Nhập Telegram ID của admin/owner. Mã 6 số được bot gửi qua Telegram; nhập mã để vào.
3. Vào **Cấu hình → Mô hình LLM**:
   - Phải thấy thông báo "LLM đã sẵn sàng".
   - Bấm **Thử** ở cả `LLM_MODEL_FAST` và `LLM_MODEL_STRONG`. Thành công sẽ báo model và số ms phản hồi.
   - Muốn đổi model: chọn từ gợi ý (lấy từ 9router) hoặc gõ tên, bấm **Lưu**. Bot dùng model mới sau khoảng 10 giây.

## 4. Thử bot

Nhắn cho bot trên Telegram, ví dụ:

| Tin nhắn | Kỳ vọng |
|---|---|
| `how to login` | Trả template ngay, không tốn token LLM |
| `mình muốn thay email tài khoản` | Khớp template đổi email |
| Một câu diễn đạt lạ về KYC bằng tiếng Nhật/Hàn | Đi xuống tầng 2 (LLM) hoặc tầng embedding, trả template đúng hoặc chuyển người thật |

Xem log và vết quyết định:

```bash
docker compose logs -f bot
```

Trên Admin Web, mục Hội thoại cho thấy mỗi câu trả lời đi qua tầng nào và vì sao. Mục Dashboard có token và chi phí.

## 5. Kiểm tra embedding (tuỳ chọn)

Cần Node ≥ 22 và đã `npm install` trong `workspace/`:

```bash
npm run bench:embedding
```

Kết quả tham chiếu trên bge-m3: top-1 khoảng 78,6%, top-5 khoảng 95,2%. Thấp hơn nhiều nghĩa là service `embedding` chưa nạp đúng model.

## 6. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Nút Thử báo `401 ... Missing API key` | Chưa điền hoặc sai `LLM_API_KEY` | Điền key (bước 1), `docker compose up -d` |
| Nút Thử báo `404 ... model not found` | Tên model không có trong 9router | Chọn lại từ danh sách gợi ý |
| Nút Thử báo `400` nhắc `max_tokens` hoặc `response_format` | Model/backend không nhận tham số bot gửi | Thử model khác; gửi nguyên thông báo lỗi để xử lý tiếp |
| Nút Thử báo `connection error` | Container không gọi được 9router | Chạy lệnh kiểm tra bên dưới; nếu 9router chỉ bind `127.0.0.1` trên Linux thì cho nó bind `0.0.0.0` |
| Thông báo "Chưa cấu hình đủ" | Thiếu URL gateway hoặc một trong hai model | Điền đủ `LLM_BASE_URL`, `LLM_MODEL_FAST`, `LLM_MODEL_STRONG` |
| "Chưa lưu được khoá từ web" | Thiếu `SECRETS_KEY` (≥ 32 ký tự) | Đặt trong `.env` rồi `docker compose up -d` |
| Bot trả "high traffic" | Mọi provider LLM lỗi | Xem `docker compose logs bot`, bảng `llm_calls` trên Admin Web |
| Khách nhắn câu diễn đạt lạ mà bot luôn chuyển người thật | Embedding chưa chạy hoặc LLM chưa cấu hình | `docker compose ps` xem `embedding`; kiểm tra bước 3 |

Kiểm tra container gọi được 9router:

```bash
docker compose exec admin node -e "fetch('http://host.docker.internal:20128/v1/models').then(r=>console.log('9router status', r.status)).catch(e=>console.log('lỗi', e.message))"
```

Kiểm tra embedding trả vector:

```bash
docker compose exec embedding curl -s localhost:80/v1/embeddings -H "content-type: application/json" -d '{"model":"bge-m3","input":["xin chào"]}'
```

## 7. Dừng và dọn

| Việc | Lệnh |
|---|---|
| Dừng nhưng giữ dữ liệu | `docker compose stop` |
| Dừng riêng embedding | `docker compose stop embedding` |
| Gỡ container, giữ dữ liệu và model | `docker compose down` |
| Gỡ cả dữ liệu (xoá DB, ảnh, model) | `docker compose down -v` — **không thể hoàn tác** |

## 8. Chạy ngoài Docker (dev)

Website admin và API là **cùng một tiến trình** (`src/admin`, Fastify vừa phục vụ giao diện vừa trả `/api/*`). Bot (`src/bot`) và worker (`src/worker`) là hai tiến trình riêng, dùng chung code và chung một database. Vì vậy chỉ cần chạy `dev:admin` là có cả giao diện lẫn API.

`tsx` không tự đọc `.env`, nên các lệnh `dev:*` đã được nối với `--env-file`: đọc `.env` rồi `.env.local` (`.env.local` thắng). `.env` viết cho container (`embedding:80`, `host.docker.internal`, database không mở cổng), còn `.env.local` ghi đè cho chạy ngoài Docker:

```
DATABASE_URL=postgres://support:support@localhost:5433/support   # db của compose, mở trên 127.0.0.1:5433
LLM_BASE_URL=http://localhost:20128/v1
EMBEDDING_URL=http://localhost:8081/v1
COOKIE_SECURE=false
TRUST_PROXY=false
TELEGRAM_MODE=polling
```

Chạy website admin để sửa giao diện:

```bash
docker compose up -d db            # database (cổng 127.0.0.1:5433)
npm run dev:admin                  # http://localhost:3001, tự nạp lại khi sửa code
```

Cần thêm tìm kiếm ngữ nghĩa thì chạy `docker compose up -d embedding`. Chạy bot ngoài Docker: `npm run dev:bot` (nhớ dừng container `bot` trước, vì một bot token chỉ nhận tin ở một nơi khi dùng polling).

Nếu báo `EADDRINUSE ... 3001`: cổng đang bị chiếm, thường do container `admin` hoặc một cửa sổ `dev:admin` khác. Dừng nó, hoặc đổi cổng: `ADMIN_PORT=3012 npm run dev:admin`.
