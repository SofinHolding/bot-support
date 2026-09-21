# MA TRẬN TRUY VẾT RÀNG BUỘC — Hệ thống cũ → hệ thống mới

Mục đích: chứng minh mọi ràng buộc bắt buộc của hệ thống OpenClaw cũ (`legacy/AGENTS.md`, `legacy/skills/*`, `legacy/HEARTBEAT.md`, `legacy/SOUL.md`, `legacy/memory/support-cases-training.md`) và các phát hiện của [SYSTEM_ARCHITECTURE_REPORT.md](SYSTEM_ARCHITECTURE_REPORT.md) đều có chỗ thực hiện trong mã nguồn mới, có test kiểm chứng, hoặc được ghi rõ là thay đổi có chủ ý.

**Cách kiểm chứng tự động**
- `npm run parity`: mọi câu trả lời cố định trong `legacy/` (62 câu) phải có mặt **nguyên văn từng ký tự** trong `content/templates/`, và mọi từ khoá khớp phải còn được phủ. Ngoại lệ có chủ ý được liệt kê kèm lý do trong `src/cli/parity.ts`. Cùng kiểm tra này chạy trong `tests/parity.test.ts`.
- `npm test`: 143 test (lõi quyết định, DB, end-to-end qua Postgres thật bằng PGlite, KB, worker, Admin API, và một bộ chạy qua **driver `pg` production** vào máy chủ giao thức Postgres do PGlite mở ra).

Cột "Kiểm chứng" ghi file test; tên test trong ngoặc là đoạn mô tả để tìm nhanh.

---

## 1. `AGENTS.md`

### 1.1 Nguyên tắc tốc độ, đọc file, đường dẫn

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| Reply < 15 s cho 80% case, FAST-PATH < 5 s | Tầng 0–1 không gọi LLM (`src/core/router.ts`). SLO khởi điểm trong đề xuất kiến trúc mục 8.2; **đo thật ở giai đoạn shadow** (chưa đo được ở đây) | `core.test.ts`: các FP khớp không cần LLM |
| Đọc song song, tối thiểu, không retry, không đọc lại | Không còn khái niệm "đọc file" trong lượt xử lý: nội dung nạp sẵn trong bộ nhớ (`LiveContent`), trạng thái là một truy vấn DB | — |
| Không dùng chain-of-thought / lời dẫn trong output | LLM chỉ trả JSON theo schema (`src/llm/client.ts`); câu gửi khách luôn là template nguyên văn hoặc trích nguyên văn | `pipeline.test.ts` (mọi câu so bằng `toBe`) |
| Quy tắc đường dẫn (không absolute, không đọc npm...) | Không áp dụng: không còn agent có tool đọc file | — |

### 1.2 Phân quyền

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| 5 Telegram ID admin có toàn quyền | Bảng `admins`, seed từ `ADMIN_TELEGRAM_IDS` / `OWNER_TELEGRAM_ID` (`src/kb/seed.ts`). Đủ 5 ID lấy nguyên từ `legacy/AGENTS.md` khi tạo `.env` cục bộ. Không còn ghi cứng ở 3 nơi | `admin.test.ts` (phân quyền) |
| User thường: không `exec`, `process`, `web_search`, `cron`, không đọc config/credential | Bot **không có tool nào** (không có agent loop); phân quyền là code, không phải văn bản prompt | `pipeline.test.ts` (user thường gõ /contexts) |
| Admin ghi nhận vào owner Anh Phi cho cảnh báo | `OWNER_TELEGRAM_ID` | `pipeline.test.ts` (FP-0 báo owner), `worker.test.ts` |

### 1.3 Admin Console

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| `/contexts`, `/usage` (và cách nói tự nhiên) chỉ cho admin | Admin gõ lệnh này trong Telegram nhận đường dẫn tới trang web (`admin-console-moved`); chức năng nằm trên Admin Web | `pipeline.test.ts` (lệnh /contexts, /usage chỉ trỏ tới trang web) |
| User thường gõ `/contexts` → luồng thường, **không lộ console** | Xử lý như tin thường (kết quả: FP-12) | như trên |
| `/contexts`: danh sách, `pending`, `resolved`, `search`, `<user_id>`, phân trang | `GET /api/episodes` (status, q, phân trang) + `GET /api/episodes/:id` + `GET /api/users/:id` | `admin.test.ts` (lịch sử hội thoại) |
| `/usage`: tổng quan, theo ngày, theo giờ (giờ VN), top user, range, export md/csv | `GET /api/usage` + `/api/usage/export`, gom theo ngày **Asia/Bangkok** | `admin.test.ts` (usage), `worker.test.ts` (usage) |
| Không auto-exec aggregator; cron làm mới mỗi giờ | Worker `usage-aggregate` hàng giờ `:05` UTC (đúng lịch cũ) | `worker.test.ts` (lịch) |
| Không log hội thoại admin, không cập nhật antispam/contexts cho admin | Admin bỏ qua mọi ghi nhận hội thoại/antispam/episode (usage LLM vẫn tính) | `pipeline.test.ts` (admin không bị ghi hội thoại) |
| Không HTML thô, ≤ 4096 ký tự | Web dựng DOM bằng `textContent`; giới hạn 4096 áp ở cổng kiểm tra đầu ra | `kb.test.ts` (quét an toàn), `core.test.ts` (checkOutput) |

### 1.4 FP-0 — lộ private key / seed phrase

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| Kiểm tra TRƯỚC mọi rule khác, kể cả chào và chặn spam | `handleKeyLeak` chạy ngay sau khi nhận tin (`src/bot/pipeline.ts`) | `pipeline.test.ts` (ưu tiên hơn cả trạng thái bị chặn) |
| Pattern A: `/wallet 0x…`, `/wallet` + 12/24 từ, `wallet 0x` + hex ≥ 40, import/connect wallet | `detectKeyLeak` (`src/core/sanitize.ts`) | `core.test.ts` (pattern A) |
| Pattern B: `0x` + 40/64 hex độc lập, WIF `5J/5K/5H` | như trên. `0x`+40 hex chỉ tính khi **cả tin nhắn** là chuỗi đó (địa chỉ ví công khai trong câu hỏi bình thường không bị báo nhầm) | `core.test.ts` (pattern B, không báo nhầm) |
| Pattern C: 12/24 từ tiếng Anh thường, ≥ 10 từ BIP39 liên tiếp | Dùng danh sách BIP39 thật. Quy tắc "đúng 12/24 từ 3–8 chữ" chỉ nhận khi dãy chiếm cả tin nhắn và ≥ 50% từ thuộc BIP39, tránh báo nhầm câu thường | `core.test.ts` (pattern C) |
| Trả NGUYÊN VĂN câu cảnh báo, 1 tin | Template `fp-0-security-alert` (`content/templates/system.md`) | `pipeline.test.ts` (`toBe(tplOf(...))`) |
| KHÔNG chép key/seed vào reply | Câu trả lời cố định, không nhúng nội dung khách | như trên |
| KHÔNG ghi key vào context; ghi `security-alert-key-leak`; `status: security-alerted`; `last_matched_section: fast/FP-0` | Episode `issue=security-alert-key-leak`, `status=security_alerted`, `last_bot_action=fast/FP-0` | `pipeline.test.ts` (KHÔNG lưu key) — kiểm tra không bản sao nào ở `messages/events/decisions/episodes` |
| KHÔNG log tin gốc; chỉ `[REDACTED - key leak warning sent]` | Đúng chuỗi đó | như trên |
| Báo Anh Phi qua DM, nội dung theo mẫu, không kèm key, không retry vòng lặp | Template `fp-0-owner-notice` (nguyên văn), lỗi chỉ ghi log | `pipeline.test.ts` (owner nhận; owner lỗi vẫn tiếp tục) |

### 1.5 FAST-PATH FP-1 … FP-13

| Mục | Thực hiện mới | Kiểm chứng |
|---|---|---|
| Thứ tự hit đầu tiên dừng | `priority` sinh theo thứ tự FP trong `AGENTS.md` (`900 − 10·i`); FP-5b = 990 | `core.test.ts` (FAST-PATH) |
| Câu trả lời nguyên văn (15 FP + FP-0) | `content/templates/fast-path.md`, `system.md` | `parity.test.ts` |
| FP-1 chào/sticker/emoji/`/start`/tin quá ngắn | `match.exact` + luật `≤ 2 ký tự` + sticker/emoji. Chỉ khớp khi **cả tin** là lời chào để "hi, how to withdraw" được trả lời câu hỏi | `core.test.ts` (FP-1), `pipeline.test.ts` (chào) |
| FP-2, 3, 4, 7, 8, 9, 10, 11 | Từ khoá gốc, khớp theo ranh giới từ, bỏ dấu tiếng Việt; thêm cho phép xen ≤ 2 từ ("delete **my** account") và khớp chặt luôn thắng khớp lỏng | `core.test.ts` |
| FP-5b: Case A (chữ: đã nhận email **và** app vẫn chờ) | `rules: [mentions_kyc_email_received, still_waiting]` | `core.test.ts` (FP-5b bằng chữ) |
| FP-5b: Case B (ảnh email / màn hình queue, mọi ngôn ngữ), B3 (2 ảnh → 1 reply) | Vision phân loại `kyc_email` / `kyc_queue_screen`; `combineVision` gộp nhiều ảnh | `core.test.ts`, `pipeline.test.ts` (2 ảnh trong cùng lượt chỉ trả một reply) |
| FP-5b HIGHEST PRIORITY OVERRIDE: bỏ qua context cũ và caption ("still wait", "Nooo") | `overrides_context: true`; router bỏ qua follow-up khi có ảnh KYC | `core.test.ts` (luôn thắng ngữ cảnh cũ), `pipeline.test.ts` |
| FP-6 KHÔNG khớp nếu đã nhắc email KYC hoặc thuộc FP-6b | `excludes` (`mentions_kyc_email_received`, `completed_level_1`, `wants_speed_up`, `mentions_duration_with_kyc`) | `core.test.ts` (FP-6 KHÔNG khớp khi…) |
| FP-6b Case A/B/C (level 1, thời gian chờ, tăng tốc) | Từ khoá + rule (KYC + "20 days/2 tháng…") | `core.test.ts` (FP-6b) |
| FP-11b Campaign 10M | Rule + "Do you not own this NFT" | `core.test.ts` (FP-11b) |
| FP-12 escalate: ví, faucet, swap, mining, login, game, ảnh báo lỗi | 9 trigger `esc-*` + ảnh `error_dialog`, dùng chung câu FP-12, gắn mã lỗi/PIC | `core.test.ts` (FP-12), `pipeline.test.ts` (ticket) |
| FP-13 off-topic theo bảng anti-spam | Xem 1.9 | `pipeline.test.ts` (chống spam) |

### 1.6 Luồng xử lý

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| Thứ tự: antispam → FAST-PATH → SKILL → ESCALATE | Pipeline: FP-0 → antispam → router (tầng 0/1 = FAST-PATH + SKILL) → tầng 2 → ESCALATE; mọi ứng viên qua **Cổng quyết định** (`src/core/gate.ts`) | `core.test.ts`, `pipeline.test.ts` |
| Không khớp → ESCALATE (FP-12) | Không khớp / mơ hồ → FP-12 + ticket (không tự đoán) | `core.test.ts` (câu lạ → ESCALATE) |
| "Phân vân → default FOLLOW-UP (ESCALATE)" | LLM chỉ được chọn trong danh mục cho phép; mơ hồ → ESCALATE | `core.test.ts` (LLM chỉ được chọn template trong danh sách) |

### 1.7 Ngôn ngữ

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| Nhận diện theo tin **hiện tại**: vi/en/zh/ko/ja/ru/ar | `detectLanguage` (`src/core/language.ts`), bằng code, không tốn token | `core.test.ts` (ngôn ngữ) |
| Khác ngôn ngữ đã lưu → dùng ngôn ngữ mới và cập nhật; tin quá ngắn dùng ngôn ngữ đã lưu, mặc định `en` | `resolveLanguage` | như trên |
| Khách yêu cầu rõ ("can you speak Vietnamese?", "请用中文") | `explicitLanguageRequest` | như trên |
| Dịch template, KHÔNG dịch URL/tên sản phẩm (Interlink, ITLG, ITL, HCS, HHP, KYC)/handle | Token bảo vệ + kiểm tra sau dịch (`src/core/translate.ts`); dịch **một lần** rồi lưu chờ duyệt (`ResponseResolver`) | `pipeline.test.ts` (dịch MỘT lần, lưu chờ duyệt) |
| Dịch lỗi/không xử lý được → gửi bản gốc | Gửi tiếng Anh | `pipeline.test.ts` (dịch lỗi) |

### 1.8 Lời chào, follow-up, tự đóng case

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| Lời chào: nguyên văn `May I help you`; có case dở → mẫu returning-user; KHÔNG tự sáng tác, KHÔNG "Welcome back" | Template `fp-1-greeting`, `greeting-returning` (`{ISSUE}` thay bằng issue của episode đang dở) | `pipeline.test.ts` (chào), `core.test.ts` |
| Follow-up ưu tiên hơn auto-close; ngắn + phủ định, cùng case cũ, cung cấp thông tin bot vừa xin | `detectStrongFollowUp` (tin ≤ 8 từ) + `info_provided` cho template có xin thông tin (swap, S04) | `core.test.ts` (follow-up) |
| "not burn" sau FP-4 → ESCALATE; đổi email + "không còn email cũ"; OTP + "not receive" → ESCALATE; KYC: thêm ảnh → gửi lại, hỏi tiếp → ESCALATE, cảm ơn → "You're welcome" | `follow_up` khai báo trong từng template | `core.test.ts`, `pipeline.test.ts` (chuỗi FP-5b; burn → ticket M02) |
| Không có rule follow-up → ESCALATE | Mặc định `negative`/`not_receive` → ESCALATE | `core.test.ts` |
| Auto-close chỉ khi đổi chủ đề hẳn ("new question", "vấn đề khác") | Predicate `topic_change` bỏ qua follow-up; router chuyển nhóm → episode mới, **không** nạp ngữ cảnh cũ | `core.test.ts` (đổi chủ đề) |
| Kết thúc lượt: pending → ghi context; resolved → chỉ giữ `language` | Episode `open`/`resolved`; `language` nằm ở `users`, không bao giờ bị xoá | `worker.test.ts` (ngôn ngữ được giữ vĩnh viễn) |

### 1.9 Anti-spam

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| 7 bậc: 1–2 cảnh báo; 3=1 phút; 4=10 phút; 5=30 phút; 6=1 giờ; 7+=24 giờ | `src/core/antispam.ts` | `core.test.ts` (bậc thang), `pipeline.test.ts` (chuỗi cảnh báo → chặn) |
| 7 câu cảnh báo nguyên văn | `content/templates/system.md` (`antispam-1…7plus`) | `parity.test.ts` |
| Ghi `offtopic_count`, `blocked_until`, `last_seen` | Bảng `antispam` | `pipeline.test.ts` |
| Bị chặn → từ chối và dừng | **Im lặng** trong thời gian chặn (khách đã được báo thời gian chặn); xem mục 5 | `pipeline.test.ts` |
| Ghi log sự kiện spam/chặn/tự mở chặn | `events`: `antispam_warning`, `antispam_block`, `antispam_unblock` | `pipeline.test.ts` |
| Off-topic phát hiện thế nào | Tầng 2 phân loại `offtopic`; ảnh không liên quan InterLink | `core.test.ts` (off-topic) |
| Chống đốt token | Hạn mức token theo khách/ngày (`limits.tokens_per_user_day`), anti-spam chạy **trước** mọi lời gọi LLM | `pipeline.ts` (thiết kế) |

### 1.10 Reply, lỗi, prompt injection, logging, bộ nhớ, nhóm

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| Copy nguyên văn, không rewrite/thêm bước | `EXACT_TEMPLATE` không bao giờ qua LLM sinh câu (cổng 4 `response_mode`) | `core.test.ts`, `pipeline.test.ts` |
| Không hiển thị lỗi kỹ thuật (429, timeout, quota); gửi câu "high traffic" nguyên văn | LLM lỗi → `high-traffic`; lỗi bất ngờ → cũng `high-traffic`, không stack trace | `pipeline.test.ts` (độ bền) |
| Từ chối "ignore previous instructions"; không lộ AGENTS.md/config | Không còn prompt chứa luật để bị lộ; LLM tầng 2 chỉ trả `template_id` trong danh sách; nội dung khách/KB nằm trong thẻ dữ liệu không thực thi; câu sinh qua bộ lọc | `core.test.ts` (LLM chỉ được chọn…) |
| Log hội thoại append-only; không log admin; không log key; không ghi ID/mật khẩu/seed | `messages` (đã che ID/số dài/email/mật khẩu), `decisions`, `events` | `pipeline.test.ts` (riêng tư) |
| Không tạo file `memory/YYYY-MM-DD*.md`; không ghi transcript ngoài vị trí quy định | Toàn bộ dữ liệu ở Postgres; không còn file | — |
| Group chat: chỉ trả lời khi được nhắc; còn lại im lặng | `isMention` + bỏ qua | `pipeline.test.ts` (nhóm) |
| Heartbeat: `HEARTBEAT_OK` | Không còn heartbeat qua LLM; worker chạy job trực tiếp | `worker.test.ts` |

---

## 2. Các skill

### `interlink-support`

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| 34 câu trả lời của SKILL nguyên văn (ITLG & Token, Account, KYC, Wallet, Group Mining, OTP & Referral, Game, Whitepaper, HCS) | `content/templates/*.md` | `parity.test.ts` |
| Từ khoá theo từng mục | `match.keywords` | `parity.test.ts` |
| S04 "forgot login ID" **khác** FP-8 "forgot ID" | `excludes` cho FP-8 + rule cho S04 | `core.test.ts` (S04) |
| Câu chung về InterLink → link whitepaper; câu cụ thể về $ITL/$ITLG/tokenomics/mining/FAQ → tra whitepaper, trích nguyên văn kèm link | Tầng 3 chế độ `extractive` (trích nguyên văn chunk + link), tri thức trong `content/knowledge/` | `core.test.ts`, `kb.test.ts` (tài liệu tri thức) |
| KHÔNG dự đoán giá / ROI / lợi nhuận; KHÔNG dùng FAQ cho when-list/convert/withdraw | Bộ lọc đầu ra chặn dự đoán giá/ROI/công thức HCS trong câu sinh; FP-2/FP-3 khớp trước | `core.test.ts` (câu sinh bị chặn) |
| HCS: KHÔNG public công thức | Template `hcs-formula` nguyên văn; bộ lọc chặn công thức HCS | `parity.test.ts` |
| HCS không cộng ở App → ESCALATE (PIC Quang) | Trigger `esc-hcs-app` | `content/templates/fast-path.md` |
| Câu hỏi tri thức chỉ từ nguồn đã huấn luyện, KHÔNG từ kiến thức chung (SOUL.md) | Tầng 3 chỉ trả từ chunk truy xuất; không đủ liên quan → ESCALATE | `core.test.ts` (tri thức không đủ liên quan) |

### `image-reader`

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| OCR thật; không deflect "ảnh không rõ" khi ảnh rõ | Vision trả JSON có `readable`; chỉ `readable=false` mới trả câu yêu cầu ảnh rõ hơn | `pipeline.test.ts` (ảnh) |
| Ảnh KYC email / màn hình queue mọi ngôn ngữ → FP-5b, không escalate lượt đầu | Prompt vision + `image_types` | `core.test.ts` |
| Ảnh lỗi trong app → FP-12 | `esc-app-error-image` | `pipeline.test.ts` |
| Ảnh sticker/meme không liên quan → off-topic | `screen_type: unrelated` → OFFTOPIC | `core.test.ts` |
| KHÔNG mô tả lại ảnh, KHÔNG lặp lại lỗi trong ảnh, KHÔNG hỏi thêm khi ảnh rõ | Chỉ gửi template | `pipeline.test.ts` |
| Ảnh có seed/key → cảnh báo che thông tin rồi xử lý phần còn lại | `image-cover-secret` gửi trước; **ảnh không được lưu** | `pipeline.test.ts` (ảnh có seed/key) |

### `conversation-logger`

| Ràng buộc cũ | Thực hiện mới |
|---|---|
| Ghi mọi hội thoại, phân loại, mã lỗi, ngôn ngữ, trạng thái, tóm tắt | `episodes` (nhóm chủ đề, trạng thái), `messages`, `decisions`, `tickets` (mã lỗi/PIC), tóm tắt cuộn |
| Đánh dấu `⚠️ CÂU HỎI MỚI` cho câu chưa có trong skill | `decisions.notes.new_question`; hiện ở dashboard "Câu chưa khớp" |
| Không ghi Interlink ID, mật khẩu, seedphrase | `maskSensitive` trước khi lưu |
| Ghi log spam / mở chặn | `events` |
| Log hội thoại từng bị ngừng ghi (báo cáo #13) | Ghi vào DB ngay trong luồng xử lý, không phụ thuộc LLM |

### `whitepaper-sync`

| Ràng buộc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| Đồng bộ 7 trang whitepaper | `WHITEPAPER_PAGES` (`src/worker/jobs.ts`) | `worker.test.ts` |
| Chỉ lấy nội dung MỚI/ĐÃ THAY ĐỔI, không ghi đè toàn bộ | So đoạn với tài liệu hiện hành; tạo **bản Draft** (không sửa bản đang chạy) | `worker.test.ts` (chỉ lấy đoạn mới) |
| Thay đổi lớn → báo admin | Luôn báo owner khi tạo Draft | như trên |
| "Last synced" > 2 ngày → báo admin | Job `whitepaper-health` | `worker.test.ts` (health) |
| Trích nguồn, không dự đoán giá | Tầng 3 kèm link; bộ lọc | `core.test.ts` |

### `app-memory-anhphiai`

Sản phẩm ngoài InterLink, `AGENTS.md` không nhắc tới. **Không đưa vào hệ thống mới** (vẫn còn trong lịch sử git nếu cần).

---

## 3. `HEARTBEAT.md` và cron cũ

| Việc cũ | Thực hiện mới | Kiểm chứng |
|---|---|---|
| Thống kê tuần (thứ Hai): tổng hội thoại, top 3 chủ đề, câu hỏi mới ⚠️, case chưa xong; nhiều câu mới → báo Anh Phi | Job `weekly-stats` (thứ Hai 00:05 Asia/Bangkok) → bảng `weekly_stats`; báo owner khi câu hỏi mới ≥ `alerts.new_questions_threshold` (mặc định 5; ngưỡng cũ chỉ ghi "nhiều") | `worker.test.ts` |
| Xoá antispam `last_seen` > 30 ngày | Cùng job, `antispam.stale_days = 30` | `worker.test.ts` |
| Xoá context bỏ dở > 7 ngày (trừ file chỉ có `language`) | `maintenance`: episode im lặng → `dormant`; `dormant` > 7 ngày → tự đóng. **Không xoá** lịch sử; `language` ở bảng `users` | `worker.test.ts` |
| Kiểm tra whitepaper "Last synced" hàng ngày | `whitepaper-health` 09:00 Asia/Bangkok | `worker.test.ts` |
| Cron `usage-aggregator-daily` `5 * * * *` UTC | `usage-aggregate` hàng giờ `:05` UTC, chạy thẳng, không qua LLM | `worker.test.ts` (lịch, usage) |
| Cron `daily-escalate-threshold-alert` 23:59 Asia/Bangkok, > 100 thì nhắn admin | `escalation-alert` (đếm bằng SQL, không để LLM tự viết script) | `worker.test.ts` (chỉ báo khi > 100) |
| Cron `whitepaper-weekly-sync` (lỗi 7 lần liên tiếp không ai biết) | `whitepaper-sync` hàng ngày 03:00 Asia/Bangkok; lỗi → retry backoff → dead-letter hiện trên dashboard; `whitepaper-health` báo owner | `worker.test.ts` |
| Broadcast (script thủ công, gửi mọi ID trong `memory/antispam/`) | Admin Web (owner) → tạo nháp → gõ lại đúng số người nhận → gửi theo lô; bỏ qua người đang bị chặn | `admin.test.ts` (broadcast) |

---

## 4. Các phát hiện trong `SYSTEM_ARCHITECTURE_REPORT.md`

| # | Vấn đề | Xử lý | Kiểm chứng |
|---|---|---|---|
| 1 | DM mở, agent có `exec`/`write`, sandbox tắt, phân quyền bằng prompt | DM vẫn mở (bot hỗ trợ công khai) nhưng **không có tool nào để bị lợi dụng**; phân quyền bằng code | `pipeline.test.ts`, `admin.test.ts` |
| 2 | 9router bind `0.0.0.0` + tunnel công khai giữ 5 OAuth | Không còn 9router/cloudflared; gọi API chính thức bằng khoá trong biến môi trường; DB không publish cổng | `docker-compose.yml` |
| 3 | Dữ liệu cá nhân trong git | `.gitignore` chặn `.env`, `data/`; dữ liệu khách nằm ở Postgres | `.gitignore` |
| 4 | Retention không khớp cấu hình (ảnh > 30 ngày còn 8.884 file) | Job `retention` xoá ảnh quá hạn (`retention.media_days`); ảnh có seed/key không được lưu | `worker.test.ts` (lưu giữ ảnh) |
| 5 | Một máy, không supervisor | Docker Compose: `restart: unless-stopped`, healthcheck | `docker-compose.yml` (chưa chạy thử — xem mục 6) |
| 6 | Phụ thuộc một đường LLM/quota | Provider dự phòng + circuit breaker; hết LLM → template thuần vẫn chạy; LLM lỗi → "high traffic" | `pipeline.test.ts`, `src/llm/chain.ts` |
| 7 | Cron lỗi kéo dài, delivery queue đầy (1.083 tin) | Retry backoff, dead-letter, `outbox` gửi lại | `worker.test.ts` (outbox, hàng đợi job) |
| 8 | `MEMORY.md` 97K ký tự bị cắt khi nạp | Bỏ khỏi prompt hoàn toàn; thống kê ở bảng | — |
| 9 | Drift phiên bản / model không khớp | Model cấu hình bằng biến môi trường, một nguồn | `.env.example` |
| 10 | ~37 script dùng một lần chồng chất, hard-code ngày | Xoá; việc nền là job có test | `worker.test.ts` |
| 11 | Broadcast không kiểm soát | Xem mục 3 | `admin.test.ts` |
| 12 | Secret ở file thường | Secret chỉ ở biến môi trường; `.env` bị git bỏ qua | `.gitignore` |
| 13 | Log hội thoại gần như ngừng | Ghi trong luồng xử lý | `pipeline.test.ts` |
| 14 | Danh sách admin trùng ở nhiều nơi | Một nguồn: bảng `admins` | `admin.test.ts` |

---

## 5. Các chỗ luật cũ mơ hồ hoặc mâu thuẫn, và cách tôi chọn

Mục này để người vận hành xác nhận. Mỗi dòng là một quyết định, không phải sơ suất.

| Vấn đề | Quyết định |
|---|---|
| "Bị chặn → từ chối + dừng": gửi lại câu chặn hay im lặng? | **Im lặng**, vì khách đã được báo thời gian chặn ở lần vi phạm |
| FP-1 nói sticker → "May I help you", còn `image-reader` nói sticker/meme → off-topic | Sticker/emoji **trong Telegram** → FP-1; **ảnh** meme/không liên quan InterLink → off-topic |
| FP-3 (`convert ITLG` → theo dõi mạng xã hội) và SKILL "ITLG → ITL conversion" (câu khác) trùng từ khoá | Theo `AGENTS.md`: FAST-PATH khớp trước, nên FP-3 thắng; câu của SKILL vẫn còn cho cách nói tiếng Việt |
| FP-12 liệt kê `OTP not receive` "(sau warning đầu)" | Chỉ escalate sau khi đã gửi cảnh báo OTP (`follow_up.not_receive`), không khớp trực tiếp |
| `support-cases-training.md`: "luôn English ở tin đầu" ↔ `AGENTS.md`: tự nhận diện | Theo `AGENTS.md` (luật cốt lõi, khớp với hành vi thực tế) |
| `SOUL.md`: "phải đọc cả 3 file trước mọi câu hỏi" ↔ `AGENTS.md`: FAST-PATH không đọc skill | Theo `AGENTS.md`. Ý của `SOUL.md` ("không trả lời từ kiến thức chung") được **cưỡng chế bằng code** thay vì bằng lời nhắc |
| `support-cases-training.md`: "acknowledge issue first" ↔ `AGENTS.md`: "không filler" | Theo `AGENTS.md`: chỉ gửi template |
| Đồng bộ whitepaper: skill mô tả hàng ngày, cron thật hàng tuần | **Hàng ngày** 03:00 Asia/Bangkok, vì kiểm tra sức khoẻ yêu cầu độ trễ ≤ 2 ngày |
| Video/voice/tài liệu không kèm chữ | Chuyển người thật (ví dụ khách quay màn hình lỗi theo S04) |
| "Cùng keyword case cũ = follow-up" | Chỉ tin ngắn (≤ 8 từ) thuộc loại phủ định/cảm ơn/không nhận được/đã cung cấp thông tin mới là follow-up. Hỏi lại cùng chủ đề → định tuyến bình thường (trả lại đúng template) |
| "nhiều câu hỏi mới" chưa có con số | Mặc định 5/tuần, chỉnh được trên Admin Web |
| Ngôn ngữ tiếng Việt: không có template tiếng Việt cho InterLink | Dịch một lần bằng LLM, lưu **chờ duyệt**; admin có thể sửa/duyệt hoặc viết `<!-- answer:vi -->` |
| `contexts/*.json` xoá sau 7 ngày | Đổi thành tự đóng episode, **giữ lịch sử** (yêu cầu Admin xem lịch sử) |

---

## 6. Những gì CHƯA được kiểm chứng

- **Độ trễ thật (SLO)**, tỉ lệ không-LLM thật, độ chính xác trên **traffic thật**: cần giai đoạn shadow. Bộ `eval_cases` hiện có (215 câu) do tôi sinh từ từ khoá và viết tay; bộ ~300 câu thật từ transcript của máy cũ **chưa có** vì transcript không nằm trong repo này.
- **Gọi LLM thật** (Anthropic/OpenAI-compatible) và **embedding thật**: test dùng LLM giả và embedding cục bộ. Cần chạy với khoá thật trước khi chuyển kênh.
- **Telegram thật** (webhook, polling, tải ảnh): test dùng kênh giả; `src/bot/telegram.ts` chưa chạy với Bot API thật.
- **Máy chủ PostgreSQL thật và Docker Compose** chưa được chạy (máy phát triển không có Docker daemon đang chạy). SQL đã được kiểm chứng trên PGlite (PostgreSQL thật + pgvector), kể cả qua driver `pg` (`tests/pg-driver.test.ts`); chưa kiểm chứng bằng mạng, pool nhiều kết nối, hay phiên bản Postgres cụ thể.
- **Giao diện web**: được kiểm tra bằng smoke test trên máy chủ thật, chưa kiểm tra bằng trình duyệt thật ở nhiều kích thước màn hình.
