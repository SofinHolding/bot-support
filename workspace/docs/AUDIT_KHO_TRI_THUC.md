# Audit kho tri thức và dataset — InterLink Support Bot

Ngày: 2026-09-24 · Phạm vi: đọc mã nguồn, chạy truy vấn **chỉ đọc** trên DB đang chạy (Docker, cổng 5433), chạy test. Không sửa code, không đổi schema, không đổi dữ liệu trong lần audit này.

Nhãn: **[C]** CONFIRMED (có bằng chứng trực tiếp) · **[P]** PARTIALLY CONFIRMED · **[I]** INFERRED · **[U]** UNKNOWN · **[R]** RISK · **[Đ]** RECOMMENDATION

> **Tình trạng công việc dở trước khi audit** (cần biết để đọc báo cáo cho đúng): working tree có thay đổi **chưa commit, chưa deploy**:
> `src/kb/routing-check.ts` (mới), sửa `src/kb/service.ts`, `src/kb/overlap.ts`, `src/admin/server.ts`, `src/admin/web/app.js`, `content/skills/review-overlap/SKILL.md`, cùng test.
> Đây là phương pháp "hỏi thử bot" để lọc xung đột (xem R1). Production (container đang chạy) **chưa có** thay đổi này. Bộ test: 376 test; mọi file đều đạt, trừ `tests/pg-driver.test.ts` lỗi khi chạy cả bộ nhưng đạt 7/7 khi chạy riêng (nghi phụ thuộc thời gian/tài nguyên, chưa điều tra).
> Mọi mô tả "hiện tại" dưới đây là code **đã deploy**, trừ chỗ ghi rõ "(chưa deploy)".

---

## 1. Tóm tắt

**Dự án làm gì [C]:** bot hỗ trợ khách hàng InterLink trên Telegram. Backend TypeScript/Node (Fastify) chia 3 tiến trình `bot`, `admin`, `worker` (`docker-compose.yml`). Postgres + pgvector là nơi lưu mọi thứ. Admin Web (JS thuần, `src/admin/web/app.js`) dùng để quản trị nội dung.

**Mô hình dataset [C]:** không phải "RAG thuần". Có 3 loại tài liệu (`kb_documents.kind`):

| Loại | Số lượng (DB đang chạy) | Bot dùng thế nào |
|---|---|---|
| `templates`: câu trả lời đã duyệt, có cấu trúc (từ khoá, luật, câu ví dụ, ticket) | 11 tài liệu, 71 template | Gửi **nguyên văn**, AI chỉ được **chọn**, không được viết |
| `knowledge`: tài liệu Markdown, cắt theo tiêu đề thành chunk | 3 tài liệu, 57 chunk | RAG: tìm chunk, AI viết câu trả lời có trích dẫn (`tier3_mode: generative`) |
| `guide`: "Hướng dẫn AI làm việc" | 1 | Đưa vào prompt theo mục |

**Năm vấn đề quan trọng nhất:**

1. **[C] Phát hiện xung đột dựa trên độ giống chữ nên nhiễu nặng.** Đo trên kho thật với bge-m3: 320 cặp template bị cờ, chỉ **1** cặp làm bot trả lời nhầm thật. 40 dòng xung đột "đang mở" trong `kb_conflicts` được ghi theo cách này. Có sẵn cơ chế lọc (chưa deploy).
2. **[C] Không có định danh thực thể.** Không có trường nào mô tả "hành động / đối tượng / màn hình / phạm vi / thời điểm hiệu lực". Hai mục na ná nhau như *Forgot ID* và *Forgot Login ID* chỉ được tách bằng luật viết tay (`excludes`, `rules` + predicate). Không có chỗ lưu quyết định "hai mục này KHÁC nhau" để máy quét khỏi hỏi lại.
3. **[C] Tệp tải lên bị mất nguồn gốc.** Trợ lý "Nạp nội dung mới" trích chữ trong bộ nhớ, đưa cho LLM dựng lại thành các trường, rồi chỉ lưu Markdown **do LLM sinh ra**. Văn bản gốc, tên tệp, trang/sheet, và vị trí từng ý trong tệp gốc đều không được lưu. Không có bước nào kiểm tra LLM có tự thêm thông tin không có trong tệp hay không.
4. **[C] Cấu hình ngôn ngữ kho sai với dữ liệu.** `router.knowledge_lang` mặc định `"vi"` và DB không ghi đè giá trị này, trong khi cả 3 tài liệu tri thức đều viết tiếng Anh. Hệ quả: câu hỏi tiếng Anh của khách bị dịch sang tiếng Việt để đi tìm trong tài liệu tiếng Anh. Tốn thêm một lời gọi LLM và mất tín hiệu từ khoá. Mức ảnh hưởng thật chưa đo.
5. **[C] Chưa có số đo chất lượng truy xuất tri thức.** Bộ câu kiểm tra (215 câu) chỉ đo việc **chọn template** ở tầng luật, không đo RAG. Bảng `messages` và `decisions` trong DB này đang trống, nên không có dữ liệu truy vấn thật để đánh giá.

**Chưa đủ thông tin [U]:** phân bố câu hỏi thật của khách; tỉ lệ ngôn ngữ; `Forgot ID` và `Forgot Login ID` có phải hai nút/luồng khác nhau trong app hay không; chính sách có thời hạn hiệu lực hay phạm vi đối tượng hay không.

---

## 2. Bản đồ kiến trúc hiện tại

| Thành phần | File | Trách nhiệm | Được gọi bởi | Trạng thái |
|---|---|---|---|---|
| Cấu hình, khởi tạo | `src/app.ts` (`createServices`), `src/config.ts` | Dựng DB, embedder, LLM, LiveContent, KbService | `src/bot/main.ts`, `src/admin/main.ts`, `src/worker/main.ts` | [C] |
| Schema | `src/db/migrations/001–005*.sql` | Bảng KB, hội thoại, ticket, xung đột | `src/db/migrate-cli.ts` | [C] |
| Seed | `src/kb/seed.ts` | Nạp `content/` vào DB **một lần** (`publishBundle`) | `createServices` | [C] `content/` được `COPY` vào image (`Dockerfile:17`), không phải nơi lưu sự thật |
| Upload tệp | `POST /api/kb/intake/extract` (`src/admin/server.ts`) + `src/kb/doc-extract.ts` | Trích chữ .txt/.md/.pdf/.doc/.docx/.xlsx trong bộ nhớ | Admin Web | [C] không lưu tệp |
| Cấu trúc hoá bằng LLM | `POST /api/kb/intake`, `LlmClient.draftIntake` (`src/llm/client.ts`, `IntakeDraftSchema` dòng 33), SKILL `content/skills/intake-draft` | LLM trả về trường có cấu trúc, code dựng Markdown (`src/kb/intake.ts`) | Admin Web | [C] |
| Draft và kiểm tra | `KbService.createDraft` / `validateSource` (`src/kb/service.ts`) | 6 bước: cấu trúc, an toàn, trùng/mâu thuẫn, bản dịch, hồi quy, replay | Admin Web | [C] |
| Chunking | `parseKnowledgeDoc` (`src/core/knowledge.ts`) | Cắt theo `##`/`###`, tối đa 1800 ký tự (`:41`), bỏ mục < 20 ký tự (`:128`) | `KbService.parse` | [C] |
| Embedding | `SelectedEmbedder` (`src/llm/embedder.ts`), `EmbeddingConfig` | Chọn bge-m3 (TEI, service `embedding`) hoặc API ngoài; tự chuyển về cục bộ khi API lỗi | `activate`, `LiveContent`, tìm kiếm | [C] DB có vector của **cả hai** model (57 bge-m3 + 57 gemini) |
| Publish / index | `KbService.publish` → `activate` (`service.ts:512`, `:588`) | Transaction: kích hoạt phiên bản, thay `templates`/`kb_chunks`, dọn phiên bản archived | Admin Web | [C] |
| Chỉ mục template | `LiveContent` (`src/kb/live-content.ts`) → `TemplateIndex` (`src/core/template-index.ts`) | Nạp template + vector câu ví dụ vào **bộ nhớ** | bot, admin | [C] |
| Truy xuất tri thức | `PgKnowledge.search` (`src/kb/knowledge-search.ts`) + `KbRepo.searchChunks` (`src/db/repo-kb.ts:222`) | tsvector `simple` + pgvector cosine, mỗi bên top 20, gộp điểm `0.6·phủ từ + 0.4·cos` (khác ngôn ngữ: chỉ cos) | router | [C] **không có** reranker, **không có** RRF |
| Định tuyến câu hỏi | `routeHybrid` → `routeLlmFirst` (`src/core/router.ts:374`, `:403`), `route()` tầng 0-1, `decide()` (`src/core/gate.ts`) | Hiểu (LLM) → FAST PATH (luật/từ khoá phủ ≥ 50%, `:353`) + LLM xác nhận → hoặc AI chọn trong ≤ 8 template + ≤ 4 chunk (`:383-384`) → viết câu trả lời có trích dẫn | `src/bot/pipeline.ts` | [C] chế độ mặc định `hybrid` |
| Trả lời và dịch | `ResponseResolver` (`src/bot/resolver.ts`) | Nguyên văn / bản dịch đã lưu / dịch máy qua kiểm tra | pipeline | [C] |
| Bộ nhớ hội thoại | `EpisodeManager.contextPack` (`src/bot/episodes.ts:70`), SKILL `summarize-episode` | Vụ việc (episode), tóm tắt cuộn mỗi 6 tin, sự kiện, dữ kiện khách nêu, 400 ký tự/tin gần nhất | router, pipeline | [C] |
| Chồng lấn / xung đột | `src/kb/overlap.ts`, bảng `kb_conflicts` (migration 005), SKILL `review-overlap` | Tìm cặp giống chữ; AI mô tả 5 cặp đầu sau publish | `validateSource`, `syncConflictsAfterPublish`, `/api/kb/overlap` | [C] (xem R1) |
| Hỏi thử bot | `src/kb/routing-check.ts` | Lọc cặp giống chữ thành cặp bot nhầm thật | — | **chưa deploy** |
| Đánh giá | `src/kb/eval.ts`, bảng `eval_cases`, `src/cli/eval.ts` | Router tầng 0-1 trên 215 câu | bước 5 lúc publish | [C] |
| Duyệt hai người | bảng `pending_changes`, `needsSecondApproval` | SECURITY_RULE, guide, cấu hình bảo vệ | publish | [C] |
| Multi-tenant | — | Không có | — | [C] không có cột tenant/org nào trong `src/` |

**Luồng nạp dữ liệu thực tế [C]:**
Upload → trích chữ trong bộ nhớ (`doc-extract.ts`) → **LLM dựng trường** (`draftIntake`) → code render Markdown (`intake.ts`) → `createDraft` (lưu `kb_document_versions.source_md`, status `draft`) → 6 bước kiểm tra → admin sửa → Publish → `activate` (parse lại → chunk → embed, dùng cache theo hash → transaction) → `LiveContent.rebuild()` → `syncConflictsAfterPublish`.
Không có bước "Cleaning" riêng. Không có "metadata generation" ngoài `lang`/`url`/`heading`.

**Luồng hỏi đáp thực tế [C]:**
Tin nhắn → che dữ liệu nhạy cảm, chống spam, kiểm tra lộ seed/key (pipeline) → LLM `understand` (ngôn ngữ, ý định, `query_en`, `query_kb`) → FAST PATH (luật, hoặc từ khoá phủ ≥ 50% câu) + LLM `verify` → nếu không qua: tìm template (từ khoá + vector câu ví dụ) và chunk (hybrid) → LLM `select` (chỉ được chọn mã có trong danh sách) → template: gửi nguyên văn / chunk: LLM `grounded` viết có trích dẫn → kiểm tra đầu ra (URL whitelist, độ dài, ngôn ngữ) → dịch nếu cần → gửi.
Không có reranker. Không có metadata filter theo phạm vi. Không có câu hỏi làm rõ (`episode.ask_when_unclear: false`, `settings.ts:52`).

---

## 3. Mô hình dataset hiện tại

**Đơn vị lưu trữ [C]:**
- **Nguồn sự thật** là `kb_document_versions.source_md`: Markdown của **cả một tài liệu**, theo phiên bản. Một tài liệu template chứa nhiều template, ví dụ `templates-fast-path` chứa 25 template.
- Dữ liệu **dẫn xuất**, dựng lại được từ `source_md`:
  - `templates` (id, version_id, doc_slug, `definition jsonb`);
  - `kb_chunks` (heading, text, url, search_text, tsv, `metadata {lang}`);
  - `kb_chunk_embeddings` (chunk_id, model, vector);
  - `embedding_cache` (hash, embedder, vector);
  - vector câu ví dụ template (trong bộ nhớ + cache).

| Câu hỏi | Trả lời | Bằng chứng |
|---|---|---|
| ID ổn định? | Template: có (`id` do người viết đặt). Chunk: **không** (`kb_chunks.id` bigserial, sinh lại mỗi lần publish; `chunk_hash` ổn định theo nội dung) | migration 001, `replaceChunks` xoá rồi chèn lại |
| Chunk ↔ tài liệu? | Có: `version_id`, `doc_slug` | [C] |
| Vị trí nguồn? | Chỉ có `heading` (đường dẫn `A › B`) và `chunk_index`. Không có trang, sheet, ô, dòng, offset | [C] |
| Metadata? | `lang` (thường trống, DB đang chạy ghi `?`), `url`, `source_url`/`section_links` trong frontmatter. Không có tenant, domain, entity, scope, effective date | [C] |
| Draft / review / published? | Có: `draft`, `pending_approval`, `published`, `archived`, `rejected`. Mỗi slug chỉ có 1 bản published (unique index) | migration 001:193, 202 |
| Upload mới thì sao? | Tạo **phiên bản mới** của một slug (slug mới = tài liệu mới). Publish thì bản cũ chuyển `archived`, chunk và vector của bản archived bị dọn (`clearArchivedContent`) | `service.ts:627` |
| Mâu thuẫn với dữ liệu cũ? | Chỉ **cảnh báo** (bước 3) và ghi `kb_conflicts`, không chặn, không ghi đè. Bước 5 **chặn** nếu câu kiểm tra đang đúng thành sai | `validateSource` |
| Lấy lại nội dung gốc từ chunk? | Lấy được Markdown của tài liệu (đã chuẩn hoá). **Không** lấy được tệp người dùng tải lên | [C] |
| Truy từ câu trả lời về nguồn? | Có ở mức chunk và tài liệu: `sources[{chunkId, docSlug, heading, url}]` trong outcome `GROUNDED` (`router.ts` nhánh tier 3). Template: `templateId` | [C] |

**Điểm mạnh [C]:**
- Phiên bản hoá chặt chẽ, có rollback.
- Dữ liệu dẫn xuất dựng lại được, đổi model embedding không cần nạp lại dữ liệu (`reindexChunks`).
- Vector được gắn đúng model.
- AI bị giới hạn ở việc chọn trong danh sách.
- Có 6 bước kiểm tra trước publish, có duyệt hai người cho nội dung bảo mật.

**Điểm yếu:** xem mục 4.

---

## 4. Rủi ro và vấn đề

| ID | Vấn đề | Bằng chứng | Tác động | Mức | Cách tái hiện |
|---|---|---|---|---|---|
| R1 | Xung đột báo theo độ giống chữ, nhiễu 320:1 | [C] đo: `scripts/_probe-confusion.ts`; `kb_conflicts`: 40 dòng open | Người dùng không biết cặp nào cần sửa, bỏ qua cả cặp thật | **High**: chặn đúng mục tiêu "người không rành kỹ thuật tự quản lý" | Mở Template → Quét chồng lấn |
| R2 | Không định danh thực thể, không lưu quyết định "khác nhau" | [C] `Template` (`src/domain/types.ts:39`) không có scope/action/object; predicates.yml:91 ghi chú tay "S04 khác FP-8" | Gộp nhầm (cả người lẫn AI). Lần hợp nhất trước mình đã **đề xuất gộp** Forgot ID vào Forgot Login ID, trái với ghi chú này | **High** | Xem `.staging/hop-nhat/` |
| R3 | Mất nguồn gốc tệp tải lên | [C] `server.ts` `/api/kb/intake`: chỉ lưu `md` do LLM sinh; audit chỉ ghi version/kind/số khung | Không kiểm lại được "tệp gốc nói gì", không phát hiện LLM thêm/bớt | **High** | Upload một PDF rồi tìm văn bản gốc: không có |
| R4 | LLM có thể thêm thông tin không có trong tệp | [C] chỉ có luật trong prompt (SKILL intake-draft R6) và zod kiểm **hình dạng** (`client.ts:33`) | Thông tin sai lọt vào bản nháp; người duyệt khó phát hiện vì không có văn bản gốc để so | **High** (kết hợp R3) | Upload đoạn không có số liệu, xem bản nháp có số liệu không |
| R5 | `knowledge_lang = vi`, tài liệu tiếng Anh | [C] `settings.ts:45`; bảng `settings` không có khoá `router.*`; 3 tài liệu tiếng Anh | Câu hỏi bị dịch sang tiếng Việt để tìm tài liệu tiếng Anh; thêm 1 lời gọi LLM; điểm từ khoá bị mất | **Medium** (có đỡ bằng điểm cos khi khác ngôn ngữ; chưa đo) | Hỏi tiếng Anh về tokenomics, xem trace `translate-query` |
| R6 | Chưa đo chất lượng RAG | [C] `eval.ts` chỉ router tầng 0-1; `messages`/`decisions` = 0 | Không biết recall của 57 chunk, không có căn cứ khi đổi model/ngưỡng | **Medium** | — |
| R7 | Mất ngữ cảnh khi chunk | [C] `knowledge.ts:132` chỉ ghép **tiêu đề lá** vào `text`; mục dài > 1800 ký tự bị tách theo đoạn văn | Điều kiện ở đoạn trước hoặc ở tiêu đề cha có thể rơi mất | **Medium** (57 chunk, trung bình 400–570 ký tự: ít chunk bị tách) | Chunk có heading `A › B`: `text` chỉ có `B` |
| R8 | Excel làm phẳng thành dòng `a \| b \| c`, tiêu đề cột chỉ ở dòng đầu | [C] `doc-extract.ts:62-64` | Sau khi LLM dựng lại, không chắc giữ đúng cột/giá trị | **Medium** | Upload bảng giá nhiều cột |
| R9 | PDF scan / ảnh: không OCR | [C] pdf-parse chỉ trích lớp chữ | Báo "không trích được nội dung" (đúng hành vi an toàn) | **Low** | Upload PDF scan |
| R10 | Câu hỏi mơ hồ: không hỏi lại khách | [C] `ask_when_unclear: false`; router: AI chọn 1 hoặc chuyển nhân viên | Chọn nhầm giữa hai mục gần nhau, hoặc chuyển nhân viên thừa | **Medium** | "How do I recover my ID?" |
| R11 | Publish nhiều tài liệu không nguyên tử | [C] `publish-all` gọi `publish` tuần tự (`server.ts`) | Gộp chéo tài liệu (thêm ở A, xoá ở B) có thể dừng giữa chừng, để lại trùng tạm thời | **Medium** | Publish-all khi tài liệu thứ 2 lỗi bước 5 (đã thấy trong test) |
| R12 | Không có thời điểm hiệu lực / phạm vi | [C] không có trường | Chính sách đổi theo thời gian (giờ trả thưởng, campaign) chỉ ghi đè; không phân biệt "cũ vs mới" với "mâu thuẫn" | **Medium**; mức thật phụ thuộc nghiệp vụ [U] | — |
| R13 | ID chunk không ổn định | [C] `replaceChunks` xoá/chèn | `kb_conflicts` trỏ chunk id cũ sau publish lại; khung xung đột dùng `${slug}#i` cho bản nháp nhưng id số cho bản live | **Low** | — |
| R14 | Chi phí LLM mỗi tin | [C] `understand` + `verify` hoặc `select` + (`grounded`) + (`translate-query` do R5) + dịch câu trả lời | 2–4 lời gọi mỗi tin | **Low–Medium**: chưa có số liệu lưu lượng | Xem bảng `llm_calls` khi có traffic |
| R15 | Rò dữ liệu giữa khách hàng / tổ chức | [C] không có multi-tenant, một thương hiệu | Không áp dụng | — | — |

---

## 5. Kịch bản lỗi dữ liệu

| Kịch bản | Code hiện tại xử lý thế nào | Đã xảy ra thật hay mới là rủi ro | Test |
|---|---|---|---|
| **Trùng nguyên văn** | Tài liệu tri thức: cặp chunk khác tài liệu giống ≥ 0.85 được gợi ý "tạo PHIÊN BẢN MỚI" (`overlap.ts`, `UPDATE_HINT_MIN`). Template: `validateBundle` chặn trùng **id**; từ khoá trùng mà câu trả lời khác thì cảnh báo | Thật: `esc-weekly-reward` và `weekly-reward-schedule` cùng tình huống | Nạp 2 lần cùng một tài liệu, bước 3 phải báo |
| **Giống nhưng khác** (Forgot ID / Forgot Login ID) | Luật tay: `fp-8` có `excludes: login id`, `forgot-login-id` có `rules` (mentions_forgot + mentions_login_id) | Thật và đang **đúng** nhờ luật tay; hỏi thử không thấy nhầm. Rủi ro nằm ở việc gộp nhầm khi hợp nhất nội dung | Nhóm C, mục 9 |
| **Mâu thuẫn** | Chỉ AI (`review-overlap`) đọc 5 cặp điểm cao sau publish; không có so sánh cấu trúc số/ngày | Thật: R04 trong bộ v2 (burn: template và tài liệu nói khác nhau) | Nhóm E |
| **Khác phạm vi** | Không có trường phạm vi | Chưa thấy trong dữ liệu hiện tại [U] | Nhóm D |
| **Mất ngữ cảnh** | Tiêu đề lá + tách theo đoạn văn | Rủi ro (R7) | Nhóm F |
| **Câu hỏi mơ hồ** | AI chọn trong danh sách, hoặc chuyển nhân viên | Rủi ro (R10) | Nhóm G |
| **Khác ngôn ngữ** | `understand` sinh `query_en` + `query_kb`; tìm bằng cả câu gốc lẫn câu đã dịch; khác ngôn ngữ thì chấm bằng cos. bge-m3 đa ngữ | Có cơ chế; R5 làm lệch; chưa có benchmark | Nhóm H |
| **Xung đột phiên bản** | Mỗi slug 1 bản published; rollback | Ổn | Nhóm I |
| **Đọc tệp lỗi** | Báo lỗi rõ, không tạo bản nháp khi trích rỗng (`doc-extract.ts`) | Ổn; nhưng trích **một phần** thì không cảnh báo | Nhóm J |
| **Quyền truy cập** | Không multi-tenant; phân quyền viewer/admin/owner ở API | Không áp dụng | — |

---

## 6. Đề xuất kiến trúc dataset

**So sánh phương án** (theo quy mô thật: 71 template, 57 chunk, một thương hiệu):

| | A. Giữ nguyên + vá | B. Tài liệu + mục có ngữ cảnh + "thẻ nhận diện" nhẹ | C. Entity + Claim | D. Knowledge Graph | E. Canonical + Index + Review |
|---|---|---|---|---|---|
| Hợp với code hiện có | Rất hợp | Hợp: mở rộng `definition jsonb`, thêm 2 bảng nhỏ | Phải thêm lớp trích xuất bằng LLM + bảng mới | Không hợp: không có nhu cầu truy vấn quan hệ | Hệ thống **đã** gần như là E (source_md → chỉ mục dẫn xuất → review 6 bước) |
| Giải quyết R1–R4 | R1 (hỏi thử) | R1–R4, R7 | R1–R4, mâu thuẫn tốt hơn | Như C, thêm độ phức tạp | Như B nếu thêm phần thiếu |
| Độ phức tạp / bảo trì | Thấp | Trung bình | Cao (claim sai do LLM trích) | Rất cao | — |
| Tốn token | Không | Gần như không | Tăng (trích claim lúc nạp) | Tăng | — |
| Rollback | Dễ | Dễ (trường tuỳ chọn) | Khó hơn | Khó | — |

**[Đ] Khuyến nghị: B trên nền E hiện có.** Không làm Knowledge Graph hay Claim đầy đủ ở quy mô này, vì chưa có vấn đề nào cần tới chúng mà B không giải được.

**Các phần cần thêm, kèm lý do:**

1. **`kb_sources`** (mới), để giải R3 và R4.

   | Trường | Kiểu | Bắt buộc | Mô tả / nguồn |
   |---|---|---|---|
   | `id` | bigserial | ✔ | |
   | `sha256` | text | ✔ | Hash tệp; phát hiện upload trùng |
   | `filename`, `mime`, `bytes` | text/int | ✔ | Từ upload |
   | `extracted_text` | text | ✔ | Đầu ra của `doc-extract.ts`, trước khi qua LLM |
   | `segments` | jsonb | | `[{sheet?, page?, heading?, start, end}]` nếu parser biết |
   | `uploaded_by`, `created_at` | | ✔ | |

   Thêm cột `kb_document_versions.source_id` (tuỳ chọn, FK): bản nháp sinh từ upload trỏ về nguồn của nó. Dữ liệu cũ để null, không cần migrate. Có lưu **tệp nhị phân** hay chỉ lưu văn bản trích ra thì tuỳ câu hỏi Q3.

2. **Kiểm tra bám nguồn cho đầu ra của intake** (code, không phải LLM). Mọi số, URL, ngày giờ, @handle và cụm trong ngoặc kép (tên nút) xuất hiện trong bản nháp đều phải xuất hiện trong `extracted_text`. Dùng lại được các hàm sẵn có `translationProblems` và `urlHosts` (`src/core/translate.ts`, `src/core/gate.ts`). Cụm nào không có trong nguồn thì hiện cảnh báo đỏ trên bản nháp. Giải R4.

3. **Trường tuỳ chọn trong `Template.definition`** (jsonb, không đổi schema bảng, parser bỏ qua nếu trống), để giải R2 và R12:

   | Trường | Ví dụ | Dùng cho |
   |---|---|---|
   | `title` | "Quên ID đăng nhập" | Tên hiển thị cho người đọc (hiện đang dùng tạm `sets_context.issue`) |
   | `target` | `{ screen: "Login", button: "Forgot Login ID" }` | Phân biệt hai mục na ná nhau bằng dữ kiện, không bằng độ giống |
   | `audience` | `["kyc_level_1_done"]` | Phạm vi áp dụng (chỉ khi nghiệp vụ cần, Q4) |
   | `effective_from` | `2026-09-01` | Chính sách có thời hạn (Q4) |

4. **`kb_pair_decisions`** (mới), lưu quyết định của người dùng để máy quét không hỏi lại:

   | Trường | Kiểu | Mô tả |
   |---|---|---|
   | `a_ref`, `b_ref` | text | `template:<id>` / `chunk:<doc>#<heading>` |
   | `a_hash`, `b_hash` | text | sha1 nội dung lúc quyết định; nội dung đổi thì quyết định mất hiệu lực |
   | `decision` | text | `distinct` / `same_merged` / `conflict_resolved` / `keep_both_scoped` |
   | `reason` | text | Bắt buộc |
   | `decided_by`, `decided_at` | | |

5. **Chunk mang đủ đường dẫn tiêu đề** (`A › B` thay vì chỉ `B`), để giải R7. Bảng Excel: lặp dòng tiêu đề cột ở mỗi đoạn, để giải R8. Cần chunk lại và embed lại 57 chunk; không đụng nguồn sự thật.

6. **Sửa cấu hình** `router.knowledge_lang = en` (thay đổi cấu hình, không phải code), để giải R5. Cần đo trước và sau (Nhóm H).

**Nguồn sự thật và dẫn xuất [C/Đ]:**
- Nguồn sự thật: `source_md` theo phiên bản, cộng `kb_sources` (mới).
- Dẫn xuất: `templates`, `kb_chunks`, vector, `kb_conflicts`, kết quả hỏi thử.
- Đổi model embedding: chỉ cần embed lại (đã có `reindexChunks`). Đổi cách cắt chunk: chỉ cần publish lại từ `source_md`, không sửa dữ liệu gốc.

---

## 7. Pipeline xử lý đề xuất

| Bước | Loại | Đầu vào → đầu ra | Ghi chú |
|---|---|---|---|
| 1. Upload + trích chữ | Deterministic | tệp → `extracted_text` | Hiện có; **thêm** lưu `kb_sources`, cảnh báo khi trích ít bất thường (ví dụ PDF nhiều trang mà ra < 200 ký tự) |
| 2. Chống upload trùng | Deterministic | sha256 | Mới, rẻ |
| 3. Dựng trường có cấu trúc | **LLM** (intake-draft) | văn bản → trường | Hiện có. Nâng lên v3: `create` / `update` / `duplicate` (ý hay từ bộ đề xuất v2) |
| 4. Kiểm tra bám nguồn | Deterministic | trường ↔ `extracted_text` | Mới (mục 6.2) |
| 5. Tìm ứng viên liên quan | Embedding + từ khoá | bản nháp → cặp giống chữ | Hiện có (`overlap.ts`) |
| 6. Hỏi thử bot | Deterministic (router thật, tầng 0-1) | cặp → chỗ nhầm thật / mơ hồ | Đã viết, chưa deploy |
| 7. So sánh dữ kiện | Rule-based | số, ngày, URL, tên nút giữa hai bên | Mới, rẻ; phát hiện "hai bên ghi khác giá trị" |
| 8. Phân xử nội dung | **LLM** (review-overlap) | chỉ cặp đã qua bước 6 hoặc 7 | Hiện có. Thu hẹp đầu vào để giảm token |
| 9. Duyệt | **Người** | khung vấn đề | Hiện có (trợ lý Nạp nội dung mới); lưu quyết định vào `kb_pair_decisions` |
| 10. Kiểm tra hồi quy + replay | Deterministic | eval + tin thật | Hiện có |
| 11. Publish → chunk → embed → index | Deterministic | | Hiện có; publish nhiều tài liệu nên gom vào **một** transaction (đã có `publishBundle`) |

---

## 8. Chính sách phân giải thực thể và xung đột

| Kết luận | Điều kiện | Hành động | Tự publish? |
|---|---|---|---|
| EXACT_DUPLICATE | sha256 tệp trùng, hoặc chunk hash trùng, hoặc câu trả lời giống hệt sau chuẩn hoá | Không tạo mới; trỏ tới mục có sẵn | Không cần |
| SAME_ENTITY_DIFFERENT_WORDING | Hỏi thử: câu của mục mới về **mục cũ** (hoặc ngược lại) **và** bước 7 không thấy giá trị khác **và** AI `duplicate` | Đề xuất `update` mục cũ (thêm câu ví dụ) thay vì tạo mới | Người duyệt |
| SIMILAR_BUT_DISTINCT | Giống chữ, hỏi thử **không** nhầm, `target` khác nhau (nếu có) | Không hiện cho người dùng; ghi 1 dòng tổng | Có |
| RELATED_ENTITY | Cùng `group`/chủ đề, không nhầm | Không làm gì | Có |
| POTENTIAL_CONFLICT | Bước 7 thấy giá trị khác (số, ngày, tên nút) **hoặc** AI `conflict` | Hiện cả hai bản, chỉ đúng giá trị khác nhau | **Không**: bắt buộc người chọn |
| DIFFERENT_SCOPE | `audience` khác nhau | Giữ cả hai | Có |
| DIFFERENT_VERSION | Cùng mục, `effective_from` mới hơn | Đề xuất cập nhật mục cũ | Người duyệt |
| ROUTING_CONFUSION / AMBIGUOUS | Hỏi thử: nhầm, hoặc mơ hồ ngang hàng | Hiện câu cụ thể + cách sửa | Không nên |
| INSUFFICIENT_INFORMATION | Không có `target`, AI `unsure`, và hai mục có câu trả lời khác nhau | Hỏi người dùng (ví dụ "app có 2 nút riêng không?"); **không gộp** | Không |

**Quy tắc cứng [Đ]:**
- Độ giống chữ **không bao giờ** tự đủ để gộp.
- Gộp chỉ xảy ra khi người duyệt chấp nhận.
- Quyết định "khác nhau" được lưu kèm hash để không bị hỏi lại, trừ khi nội dung đổi.

---

## 9. Bộ dữ liệu kiểm thử (domain InterLink)

Mỗi nhóm chạy tự động bằng vitest và `makeWorld` (như `tests/kb.test.ts`). Riêng nhóm H cần model thật (bge-m3) nên chạy bằng script riêng, không đưa vào CI.

| Nhóm | Đầu vào | Kỳ vọng | Điều kiện trượt |
|---|---|---|---|
| A. Trùng nguyên văn | Nạp lại `ambassador-program` dưới slug khác | Gợi ý "PHIÊN BẢN MỚI"; không tạo chunk trùng khi người dùng chọn cập nhật | Hai bản cùng publish mà không cảnh báo |
| B. Diễn đạt khác | "Khách hỏi rút ITLG khi nào" dưới dạng mục mới | intake v3 trả `update` trỏ `fp-2-withdraw` | Tạo template mới trùng |
| C. Giống nhưng khác | Mục mới "Forgot ID" khi đã có "Forgot Login ID" | Không gộp; hỏi thử: mỗi câu về đúng mục; nếu thiếu `target` thì INSUFFICIENT_INFORMATION | Tự gộp, hoặc một bên giành câu của bên kia |
| D. Khác phạm vi | Hai bản "thời gian KYC" cho người đã xong level 1 và người chưa | Giữ cả hai, không báo mâu thuẫn | Báo POTENTIAL_CONFLICT |
| E. Mâu thuẫn | Nạp "Weekly reward paid at 5AM UTC" khi đang là 3AM | Bước 7 bắt "3AM ≠ 5AM", không cho tự publish | Âm thầm ghi đè |
| F. Mất ngữ cảnh | Tài liệu có `## Premium` › `### Rút tiền` "chỉ áp dụng…" | Chunk mang "Premium › Rút tiền" | Câu trả lời thiếu điều kiện |
| G. Câu hỏi mơ hồ | "How do I recover my ID?" | Chọn đúng nếu đủ căn cứ; hai ứng viên ngang nhau thì chuyển nhân viên hoặc hỏi lại (theo Q5) | Chọn bừa một mục |
| H. Khác ngôn ngữ | 30 câu hỏi vi/zh/ko về 57 chunk tiếng Anh, có đáp án chunk đúng | Recall@4 được đo với `knowledge_lang = vi` và `= en` | Không có số đo |
| I. Cập nhật tăng dần | Publish bản mới của `whitepaper-data` (đang có v2 nháp chưa publish) | Bản cũ archived, rollback được, vector không lẫn | Mất chunk, hoặc lẫn phiên bản |
| J. Đọc tệp lỗi | PDF scan, xlsx rỗng, docx hỏng | Báo lỗi rõ, không tạo bản nháp | Tạo bản nháp rỗng hoặc thiếu mà không báo |

---

## 10. Chỉ số đo

| Mức | Chỉ số |
|---|---|
| **Cần ngay** | Độ chính xác chọn template (đã có, 209/215 ở tầng 0-1); số chỗ nhầm thật từ hỏi thử (mục tiêu 0); Recall@4 chunk với bộ H; tỉ lệ bản nháp intake có cụm không bám nguồn; số lời gọi LLM mỗi tin (`llm_calls`) |
| Giai đoạn sau | Groundedness câu trả lời RAG (LLM chấm trên mẫu), tỉ lệ chuyển nhân viên, tỉ lệ đồng ý giữa người duyệt và kết luận của máy |
| Chưa cần ở quy mô này | nDCG, độ trễ nạp dữ liệu, chi phí lưu trữ |

---

## 11. Kế hoạch triển khai

| Phương án | Nội dung | Thay đổi code | Giải được | Rủi ro |
|---|---|---|---|---|
| **A. Tối thiểu** | Deploy hỏi thử (đã viết) + tính lại `kb_conflicts`; sửa `knowledge_lang` sau khi đo nhóm H | Nhỏ (đã xong phần lớn) | R1, R5 | Thấp; rollback bằng redeploy bản cũ |
| **B. Cân bằng (khuyến nghị)** | A + `kb_sources` + kiểm tra bám nguồn + `kb_pair_decisions` + trường tuỳ chọn `title`/`target` + chunk giữ đường dẫn tiêu đề + intake v3 + publish-all một transaction | Trung bình; 2 bảng mới, 1 cột null được | R1–R5, R7, R8, R11 | Thấp–trung bình; mọi trường mới đều tuỳ chọn, dữ liệu cũ không phải migrate; cần chunk + embed lại 57 chunk |
| C. Đầy đủ | B + trích claim bằng LLM cho mọi tài liệu + `effective_from`/`audience` bắt buộc | Lớn | Thêm phần mâu thuẫn theo thời gian / phạm vi | Chỉ đáng làm nếu Q4 trả lời "có nhiều chính sách theo thời gian / đối tượng" |

**Thứ tự:**
- **Phase 0:** đo baseline nhóm H, chốt bộ test A–J, trả lời mục 12.
- **Phase 1:** phương án A.
- **Phase 2:** `kb_sources`, kiểm tra bám nguồn, `kb_pair_decisions`, intake v3.
- **Phase 3:** chunk giữ ngữ cảnh, sửa bảng Excel, publish nhiều tài liệu nguyên tử.
- **Phase 4:** chỉ khi số đo cho thấy cần mới cân nhắc reranker hoặc câu hỏi làm rõ.

**Không đề xuất [Đ]:**
- Knowledge Graph.
- Đổi model embedding.
- Thêm reranker khi chưa có số đo nhóm H.

---

## 12. Câu hỏi cần bạn quyết (code không trả lời được)

| # | Câu hỏi | Vì sao quan trọng | Ảnh hưởng tới | Lựa chọn |
|---|---|---|---|---|
| Q1 | Trong app có **hai** nút/luồng riêng "Forgot ID" và "Forgot Login ID" không? | Cấu hình cũ ghi chú là khác nhau, nhưng câu trả lời hiện tại mô tả hai tên nút khác nhau cho cùng việc | Gộp hay không (bản đề xuất gộp của mình phải sửa theo) | Hai luồng riêng → giữ riêng, thêm `target` / Một luồng → gộp |
| Q2 | Tài liệu tri thức sẽ viết bằng ngôn ngữ nào về sau (chỉ tiếng Anh, hay có cả tiếng Việt)? | Quyết định `knowledge_lang` và việc dịch câu hỏi | R5, nhóm H | en / vi / trộn (khi đó cần lưu `lang` mỗi tài liệu) |
| Q3 | Có được lưu **tệp gốc** người dùng tải lên không (dung lượng, dữ liệu nhạy cảm)? | Quyết định lưu nhị phân hay chỉ lưu văn bản trích ra | `kb_sources` | Chỉ văn bản trích (khuyến nghị) / cả tệp |
| Q4 | Có chính sách **theo thời gian** hoặc **theo đối tượng** không (campaign có hạn, tier ambassador, level KYC)? | Có thì cần `effective_from`/`audience`; không thì bỏ, giữ đơn giản | Phương án B hay C | — |
| Q5 | Khi câu hỏi mơ hồ, bot được **hỏi lại khách** hay phải chuyển nhân viên? | Hiện tắt hỏi lại (`ask_when_unclear: false`) | R10, nhóm G | Hỏi lại tối đa 1 lần / chuyển nhân viên |

---

## Tự kiểm

- [x] Đã đọc module thật, không chỉ README.
- [x] Đã xác định luồng nạp dữ liệu và luồng hỏi đáp thật (mục 2).
- [x] Đã xác định schema, DB, vector (mục 3).
- [x] Đã tách sự thật và giả thuyết bằng nhãn.
- [x] Đã xét: trùng, giống-nhưng-khác, mâu thuẫn, phiên bản, phạm vi, mất ngữ cảnh, đa ngôn ngữ, token, nguồn gốc, vòng đời (mục 4–5).
- [x] Đã đề xuất bộ test (mục 9) và các phương án có đánh đổi (mục 6, 11).
- [x] Không sửa source code trong lần audit này. Phần hỏi thử viết **trước** khi có yêu cầu audit, đang để nguyên, chưa commit.
- [x] Đã liệt kê thông tin còn thiếu (mục 1, 12).
