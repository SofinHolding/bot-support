# TÀI LIỆU BÀN GIAO THIẾT KẾ & HIỆN TRẠNG THỰC TẾ
## InterLink AI Customer Support Chatbot — phục vụ đội lập trình viết mới

**Ngày chốt tài liệu:** 2026-10-02  
**Repository:** `SofinHolding/bot-support`  
**Production baseline trên GitHub main:** `e18a7a1` — `feat: cut over clean knowledge source to ragflow`  
**Nhánh làm việc hiện tại:** `fix/rag-reliability-cost-audit`  
**Lưu ý quan trọng:** nhánh làm việc hiện có nhiều thay đổi candidate chưa commit/push. Tài liệu này tách rõ phần nào đã nằm trên `main`, phần nào chỉ đang ở working tree và chưa được xem là production baseline.

---

# 1. Mục đích tài liệu

Tài liệu này dùng để bàn giao cho một đội lập trình mới có thể:

1. hiểu đúng chatbot đang làm gì trong thực tế;
2. hiểu kiến trúc runtime, database, RAG, LLM, memory, worker và Admin Web hiện tại;
3. biết phần nào đã hoàn thành, phần nào chỉ là legacy, phần nào đang sửa dở;
4. viết lại hệ thống mà không làm mất các invariant đã được kiểm chứng;
5. không lặp lại các quyết định kiến trúc đã từng gây lỗi;
6. biết tiêu chí nghiệm thu trước khi thay thế hệ thống hiện tại.

Đây không phải tài liệu mô tả một kiến trúc lý tưởng chưa tồn tại. Mọi mục “CURRENT” bên dưới được viết theo source/runtime hiện tại. Các mục “TARGET REWRITE” là kiến trúc đề xuất cho bản viết mới.

---

# 2. Business context và phạm vi thật

## 2.1 Mục tiêu sản phẩm

Đây là chatbot hỗ trợ khách hàng InterLink, hiện nhận tin chủ yếu qua Telegram. Bot cần:

- hiểu câu hỏi người dùng;
- trả lời bằng dữ liệu đã được doanh nghiệp cung cấp/duyệt;
- hỗ trợ đa ngôn ngữ;
- giữ ngữ cảnh theo từng khách;
- không tự bịa thông tin khi bằng chứng không đủ;
- chuyển nhân viên khi không đủ dữ liệu hoặc khi rule yêu cầu;
- có Admin Web để quản lý cấu hình, nội dung, vận hành và audit;
- ghi lại usage LLM, quyết định routing, ticket, episode và lỗi để vận hành.

## 2.2 Một doanh nghiệp duy nhất

Hệ thống chỉ phục vụ **một doanh nghiệp**. Knowledge được người quản trị thêm vào để dùng chung cho toàn bộ chatbot.

Do đó:

- không có tenant A / tenant B;
- không cần `tenant_id` trong retrieval;
- không cần ACL knowledge theo doanh nghiệp;
- không cần multi-tenant vector namespace;
- `scope_key=default` hiện tại là phù hợp với business requirement.

Nếu đội viết mới tự thêm multi-tenancy vào phiên bản đầu thì đó là over-engineering.

## 2.3 Knowledge model mong muốn về nghiệp vụ

Người dùng quản trị chỉ cần “thêm dữ liệu”. Hệ thống chịu trách nhiệm:

- xác định knowledge identity;
- versioning;
- chọn bản active;
- tránh duplicate/xung đột;
- index bản active;
- chỉ dùng dữ liệu active để trả lời.

Người vận hành không cần tự chia scope hoặc tự quản vector.

---

# 3. Snapshot trạng thái hiện tại

## 3.1 Production baseline đã push lên main

Commit production baseline:

```text
e18a7a1 feat: cut over clean knowledge source to ragflow
```

Các việc đã hoàn thành và đã nằm trên main:

- thêm Python Knowledge Governance service;
- thêm RAGFlow integration;
- cutover `RETRIEVAL_PROVIDER=python` ở runtime local hiện tại;
- canonical source là XLSX sạch;
- clear vector legacy cũ và đồng bộ lại knowledge production;
- 109 knowledge unit active;
- 109/109 đã sync RAGFlow;
- Postgres là source of truth;
- RAGFlow là derived retrieval index;
- retrieval re-check active state trong Postgres trước khi đưa evidence lên LLM;
- cron tự index Vault/Obsidian cũ đã bị bỏ khỏi production schedule;
- importer sạch cho source XLSX đã được thêm;
- regression suite lúc cutover đã pass.

## 3.2 Working tree hiện tại chưa commit

Tại thời điểm viết tài liệu, branch:

```text
fix/rag-reliability-cost-audit
```

HEAD vẫn là:

```text
e18a7a1
```

nhưng working tree đang có candidate changes cho các finding audit mới, gồm:

- RAG query fusion bằng weighted RRF;
- retrieval pool rộng hơn trước khi fuse;
- golden set natural query 351 cases;
- shared `httpx.AsyncClient` cho RAGFlow;
- connection pool + keep-alive + concurrency gate;
- controlled 502/503 khi RAGFlow lỗi/timeout;
- correlation ID;
- pricing semantics `unknown/estimated/actual` thay vì unknown model = `$0`;
- `LLM_PRICING_JSON` cho operator cấu hình;
- translation failure backoff để tránh lặp call nền vô ích;
- migrations 014/015 cho audit hardening / RAGFlow payload refresh;
- regression tests tương ứng.

Những phần này **chưa được coi là production baseline cho đến khi hoàn thành holdout/stress validation, commit và được phép push/deploy**.

## 3.3 Test state hiện tại của working tree

Đã chạy trong working tree hiện tại:

```text
Node:       44 test files / 534 tests PASS
Python:     27 tests PASS
Ruff:       PASS
TypeScript: PASS
git diff --check: PASS
```

Golden natural-query dataset hiện có:

```text
351 cases
258 dev
93 holdout
351 unique queries
24 no-answer cases
```

Các nhóm case có:

- natural Vietnamese;
- Vietnamese without diacritics;
- typo/slang;
- short query;
- English paraphrase;
- mixed Vietnamese-English;
- hard negative;
- no-answer.

Kết quả holdout cuối cùng của candidate fix phải được lưu riêng trước khi merge; không được ghi số dự kiến vào tài liệu production.

---

# 4. Kiến trúc runtime CURRENT

## 4.1 Thành phần chính

| Thành phần | Công nghệ | Chức năng |
|---|---|---|
| `bot` | Node.js + TypeScript | Telegram ingress, pipeline, routing, memory, reply |
| `admin` | Node.js + TypeScript + Fastify + static web UI | Admin Web, auth, KB legacy/admin operations, config, audit |
| `worker` | Node.js + TypeScript | scheduled jobs, maintenance, translation/prewarm, outbox nghiệp vụ |
| `db` | PostgreSQL 16 + pgvector | source of truth cho conversation, jobs, config, governance, telemetry |
| `knowledge-api` | Python 3.12 + FastAPI | Knowledge Governance API + retrieval API |
| `knowledge-worker` | Python 3.12 | sync active knowledge sang RAGFlow |
| RAGFlow | self-hosted ngoài core compose | semantic index / retrieval engine |
| LLM gateway | OpenAI-compatible gateway, hiện qua `:20128/v1` | proxy tới model aliases `cx/*` |
| Telegram Bot API | external | channel người dùng |
| Embedding legacy service | TEI/BGE-M3 container | còn phục vụ đường legacy, không phải RAGFlow production source |

## 4.2 Network/runtime local hiện tại

Ports chính:

```text
Bot              3000
Admin            3001
Knowledge API    3010
Postgres host    5433 -> container 5432
Legacy embedding 8081 -> container 80
RAGFlow          host 9380 (self-hosted ngoài core compose)
LLM gateway      host 20128/v1
```

## 4.3 High-level flow

```text
Telegram User
    |
    v
Node Bot / BotPipeline
    |
    +--> deterministic security / anti-spam / idempotency
    +--> conversation + episode context
    +--> LLM understand
    +--> fast-path rules/templates nếu đủ chắc chắn
    |
    +--> Python Knowledge API
            |
            +--> exact active match in PostgreSQL
            +--> RAGFlow semantic retrieval
            +--> PostgreSQL active revalidation
    |
    +--> LLM candidate select / grounded answer / verify
    +--> language/translation guard
    +--> Telegram reply
    |
    +--> decisions/events/messages/llm_calls
```

---

# 5. Node application composition

Entry composition nằm trong `src/app.ts` qua `createServices()`.

Service factory khởi tạo:

- DB connection + migrations;
- conversation repository;
- legacy KB repository;
- ops repository;
- Vault repository;
- runtime settings;
- embedding selection;
- LLM gateway config;
- provider chain;
- skills;
- live content;
- Admin/KB service;
- Telegram channel;
- response resolver;
- knowledge provider;
- media store;
- bot pipeline.

`RETRIEVAL_PROVIDER` có ba mode trong code:

```text
legacy
shadow
python
```

Production hiện dùng `python`.

Legacy mode vẫn còn để rollback/migration compatibility, nhưng không nên trở thành kiến trúc lâu dài của bản rewrite.

---

# 6. Message processing pipeline CURRENT

Thứ tự xử lý logic quan trọng trong `src/bot/pipeline.ts` phải được giữ khi viết mới.

## 6.1 Idempotency

Telegram update/message phải được claim trước khi xử lý để tránh gửi trả lời hai lần.

Hệ thống có trạng thái cho lượt đang xử lý, completed và stale/in-progress recovery.

Invariant:

```text
same inbound message -> at most one business reply
```

## 6.2 Group / mention handling

Group chat chỉ xử lý theo rule mention/config. DM là flow chính.

## 6.3 Secret protection trước AI

Private key/seed phrase và secret-like content được kiểm tra deterministic trước normal LLM handling.

Không được đưa raw secret vào LLM/context/history nếu rule chặn đã match.

## 6.4 Admin command path

Admin command được phân nhánh riêng, không đi như một customer message bình thường.

## 6.5 Anti-spam

Có anti-spam state và escalation ladder. Admin không bị customer spam policy chặn.

## 6.6 Image handling

Ảnh được download và phân tích qua LLM/vision path. Nếu vision không dùng được phải fail closed, không tự đoán nội dung ảnh.

## 6.7 Language detection

Code + LLM phối hợp xác định ngôn ngữ. Script-based detection được dùng làm final guard với các script rõ ràng.

## 6.8 Episode/context

Message được gắn vào episode / topic context. Hệ thống không gửi toàn bộ lịch sử vô hạn cho LLM.

## 6.9 Router

Router có hai nhóm đường:

1. deterministic / template fast path khi rule đủ chắc chắn;
2. AI/RAG path khi cần hiểu semantic.

Template match không được gửi thẳng chỉ vì keyword match; answer vẫn có verify layer ở các path quan trọng.

## 6.10 Reply + record

Sau khi gửi reply:

- message;
- event;
- decision;
- ticket nếu escalation;
- LLM usage;
- episode state

được ghi lại phục vụ audit và memory.

---

# 7. Conversation memory CURRENT

## 7.1 Mục tiêu

Memory không phải “đổ toàn bộ chat history vào prompt”. Hệ thống dùng structured bounded context.

Các thành phần gồm:

- `users`;
- `messages`;
- `episodes`;
- events;
- summary/facts;
- recent messages;
- pending clarification;
- last answer/template.

## 7.2 Episode

Một user có thể có nhiều episode/chủ đề. Khi đổi vấn đề, hệ thống có thể mở episode mới mà không phá episode cũ.

Invariant cần giữ:

- context user A không được xuất hiện ở user B;
- chủ đề mới không được ghi đè ticket/episode chưa xong của chủ đề khác;
- follow-up phải dùng đúng context của issue trước đó;
- stale recent messages phải được cắt, nhưng facts/summary quan trọng vẫn có thể được giữ.

## 7.3 Rewrite recommendation

Nếu viết Python-first, giữ model này thay vì dùng “LLM memory” opaque.

Nên có interface rõ:

```python
ConversationContextService.build(user_id, inbound_message) -> ContextPack
```

với `ContextPack` bounded và testable.

---

# 8. LLM architecture CURRENT

## 8.1 Gateway

Provider chính là OpenAI-compatible gateway.

Default model aliases hiện tại:

```text
FAST    cx/gpt-5.6-sol
STRONG  cx/gpt-5.5
```

Gateway config có thể đọc từ DB/Admin mà không cần restart.

Anthropic direct provider chỉ là fallback tùy chọn nếu `ANTHROPIC_API_KEY` được cấu hình.

## 8.2 ProviderChain

`ProviderChain` chịu trách nhiệm:

- provider failover;
- usage telemetry;
- latency;
- circuit/failure behavior;
- optional throttling cho background chain.

## 8.3 LLM purposes

Các purpose thực tế có thể gồm:

- `understand`;
- `select`;
- `verify`;
- `grounded`;
- `translate`;
- `summarize`;
- vision/intake.

## 8.4 AI call budget

Hệ thống có daily token budget theo user dựa trên:

```text
input_tokens + output_tokens
```

Dollar cost không được dùng làm business gate hiện tại.

## 8.5 Prompt caching

Không được giả định production đang dùng prompt cache.

- Anthropic provider có code hỗ trợ `cache_control` và cache token telemetry.
- OpenAI-compatible gateway path production hiện không gửi explicit cache directive.
- live gateway trước đây chỉ trả `prompt_tokens`, `completion_tokens`, `total_tokens`.

Do đó prompt cache telemetry không phải requirement bắt buộc cho rewrite v1 trừ khi gateway mới xác nhận hỗ trợ.

---

# 9. LLM cost telemetry

## 9.1 Trạng thái baseline main

Main baseline có token usage đúng nhưng unknown model alias bị tính dollar cost = `0` do không có pricing mapping.

Đây là observability bug, không phải chatbot correctness bug.

## 9.2 Candidate fix trong working tree

Working tree đang chuyển semantics thành:

```text
actual
estimated
unknown
```

và cho phép operator nhập:

```text
LLM_PRICING_JSON
```

theo USD / 1M token.

Rule đúng cho bản viết mới:

```text
pricing unknown -> cost = N/A / unknown
pricing known from operator contract -> estimated cost
provider returns actual billed cost -> actual cost
```

Không được hard-code giá model internet rồi coi là bill thực của gateway.

---

# 10. Knowledge architecture CURRENT

## 10.1 Canonical source hiện tại

Nguồn production canonical:

```text
raw-data/2026-09-29_V1-nguon-sach.xlsx
```

Sheet:

```text
Noi dung V1
```

Các cột:

```text
Tên
Khách thường hỏi
Nội dung
```

`content/` là bản mirror/config/reference, không được ingest lại như một nguồn production thứ hai nếu nội dung trùng canonical source.

## 10.2 Số liệu production đã cutover

Tại lần cutover đã xác minh:

```text
knowledge units active: 109
RAGFlow synced:         109
open sync outbox:         0
```

## 10.3 Source of truth

**PostgreSQL là source of truth.**

RAGFlow chỉ là:

```text
derived semantic index
```

Không được đảo vai trò này trong bản viết mới.

---

# 11. Knowledge Governance CURRENT

Migration `013_knowledge_governance.sql` tạo các bảng chính:

```text
knowledge_sources
knowledge_units
knowledge_versions
knowledge_conflicts
knowledge_ragflow_sync
knowledge_sync_outbox
```

## 11.1 Knowledge Unit

Một semantic identity của knowledge.

Key chính về nghiệp vụ:

```text
knowledge_key + scope_key
```

Hiện `scope_key=default` do single-enterprise global knowledge.

## 11.2 Knowledge Version

Mỗi lần nội dung thay đổi tạo version.

Statuses hiện tại:

```text
active
superseded
conflicted
duplicate
shadow
rejected
```

DB có invariant chỉ một version active cho cùng unit.

## 11.3 Precedence

Khi có dữ liệu mới, decision không đơn giản là “upload sau thắng”. Logic xét:

1. semantic identity;
2. source priority / authority;
3. effective date;
4. upload timestamp chỉ là fallback;
5. identity confidence thấp -> conflict/fail closed.

## 11.4 Transactional update

Khi version mới thắng:

```text
lock unit
old active -> superseded
enqueue delete old RAGFlow doc
insert new active
enqueue upsert new doc
commit
```

Outbox đã tồn tại; không cần thiết kế lại một queue khác chỉ cho sync knowledge.

## 11.5 Delete/deactivate

Production hiện chưa có business requirement “xóa hẳn một knowledge active mà không có replacement”.

Không cần thêm full deletion lifecycle cho rewrite v1 nếu requirement vẫn như hiện tại.

Nếu sau này cần, chỉ cần thêm trạng thái `retired` và dùng existing outbox delete semantics.

---

# 12. RAGFlow integration CURRENT

## 12.1 Ingestion

Python `knowledge-worker` đọc `knowledge_sync_outbox`.

Với active version:

```text
build retrieval payload
upload document to RAGFlow
add chunk
save ragflow document mapping
mark sync state
```

Với version cũ:

```text
delete RAGFlow document
clear/mark mapping
```

Worker dùng `FOR UPDATE SKIP LOCKED` / retry style để nhiều worker không claim cùng một job.

## 12.2 Retrieval

Python retrieval path gồm:

```text
query
 -> exact active title/customer-phrase matching in PostgreSQL
 -> RAGFlow semantic retrieval
 -> map RAGFlow document -> knowledge version
 -> PostgreSQL re-check status='active'
 -> return RetrievalHit
```

Điểm quan trọng nhất:

> Một document stale còn tồn tại tạm thời trong RAGFlow sau update vẫn không được trở thành evidence nếu PostgreSQL version không còn `active`.

Đây là safety invariant cần giữ.

## 12.3 Consistency model

Hệ thống chấp nhận eventual consistency giữa Postgres và RAGFlow, nhưng chọn:

```text
temporary no-answer > stale answer
```

Nếu active mới chưa sync kịp, có thể tạm không tìm thấy. Không được fallback sang superseded content chỉ để có câu trả lời.

---

# 13. Retrieval architecture và RAG-001

## 13.1 Baseline đã phát hiện

Canonical queries từng đạt:

```text
239 / 239 Top-1
```

nhưng natural paraphrase audit nhỏ trước đó chỉ đạt:

```text
Top-1:    6 / 14
Recall@5: 10 / 14
```

Điều này cho thấy exact/known phrasing tốt nhưng semantic generalization chưa đủ chắc chắn.

## 13.2 Root causes đã trace

Các điểm có vấn đề trong baseline:

- cross-language raw query có thể gây nhiễu khi KB index chủ yếu English-oriented;
- candidate pool 8 là quá sớm ở một số query;
- merge bằng max raw similarity giữa các query rewrite khác nhau là không calibration-safe;
- correct hit có thể nằm rank 9-20 của một rewrite nhưng bị cắt trước selector;
- tiếng Việt không dấu và paraphrase tự nhiên cần query normalization/rewrite tốt hơn.

## 13.3 Candidate fix chưa merge

Working tree đang có:

- `RETRIEVAL_POOL_PER_QUERY = 20`;
- weighted RRF theo within-query rank;
- không so trực tiếp raw cosine score giữa hai query variants;
- query plans dùng `query_kb`, `query_en`, original theo language rule;
- giữ downstream evidence score thật;
- regression tests cho fusion.

## 13.4 Golden evaluation mới

Dataset:

```text
content/eval/rag-natural-golden.jsonl
```

351 câu, chia dev/holdout.

Bản viết mới phải giữ nguyên nguyên tắc:

- không tune holdout trực tiếp;
- canonical regression không được giảm;
- natural holdout Recall@5 mục tiêu >= 95%;
- Top-1 mục tiêu >= 90%;
- no-answer precision/recall báo riêng;
- không tăng false-positive để đổi lấy recall.

---

# 14. RAGFlow reliability và REL-001

## 14.1 Lỗi đã tái hiện trước đó

Sustained concurrency từng tạo nhiều `httpx.ReadTimeout`.

Baseline client tạo `AsyncClient` mới cho mỗi request, thiếu explicit connection-pool lifecycle và timeout error mapping.

## 14.2 Candidate fix chưa merge

Working tree đang có thiết kế:

- một reusable `httpx.AsyncClient`;
- connection pool giới hạn;
- keep-alive pool;
- semaphore giới hạn concurrent upstream calls;
- connect/pool/total timeout budgets;
- cancellation propagation;
- RAGFlow 5xx -> controlled unavailable error;
- network/reset -> controlled unavailable error;
- FastAPI map timeout/unavailable -> HTTP 503;
- protocol/upstream envelope error -> HTTP 502;
- `X-Request-ID` correlation;
- không retry vô hạn;
- không tạo retry storm trong user request.

Default candidate config:

```text
RAGFLOW_TIMEOUT_SECONDS=30
RAGFLOW_CONNECT_TIMEOUT_SECONDS=5
RAGFLOW_POOL_TIMEOUT_SECONDS=5
RAGFLOW_MAX_CONNECTIONS=16
RAGFLOW_MAX_KEEPALIVE_CONNECTIONS=8
RAGFLOW_MAX_CONCURRENCY=8
```

Lưu ý: đây là candidate values, phải stress-test trước merge. Không được coi “tăng timeout” là fix.

---

# 15. Multilingual architecture CURRENT

## 15.1 Input language

Ngôn ngữ được xác định bởi:

- deterministic script detection khi script đặc trưng;
- LLM understand;
- final code guard khi hai kết quả mâu thuẫn rõ ràng.

## 15.2 Retrieval language

LLM understand tạo các search rewrite như:

```text
query_en
query_kb
```

Search rewrite không được làm thay đổi:

- số;
- handle;
- product name;
- factual constraints.

Code có validation để bỏ rewrite đáng ngờ.

## 15.3 Output language

Bot phải trả bằng ngôn ngữ của khách.

Translated output được kiểm lại để giữ:

- URL;
- số;
- handle;
- ý nghĩa bắt buộc.

Nếu bản dịch làm thay đổi dữ liệu quan trọng, không gửi bản dịch đó.

---

# 16. Translation consumption / COST-002

Audit trước phát hiện phần lớn LLM usage nằm ở `translate`.

Không được kết luận “translation thừa” chỉ từ tỷ lệ call.

Luồng thực tế có:

- translate on demand;
- translation cache;
- urgent translation prewarm background;
- validation retry.

Một nguyên nhân chi phí có thể đến từ prewarm các translation thất bại lặp lại định kỳ.

Candidate working-tree fix đang thêm:

- failure fingerprint theo source + validation revision;
- backoff cho cặp translation lỗi;
- clear failure khi bản dịch sau đó thành công;
- không gọi lại cùng lỗi ba lần mỗi giờ vô hạn.

Khi viết mới, giữ nguyên nguyên tắc:

```text
successful translation -> reusable cache
deterministic-invalid translation -> bounded retry/backoff
LLM unavailable -> retry job theo queue policy
```

Không xóa translation layer nếu vẫn cần multilingual quality.

---

# 17. Admin Web CURRENT

Node Admin Server dùng Fastify.

Các nhóm chức năng có trong source hiện tại gồm:

- health;
- authentication/session;
- admin roles;
- settings;
- LLM gateway config;
- embedding config;
- usage/dashboard;
- tickets/episodes/history;
- KB documents/version/publish/rollback;
- “try question”;
- conflict decisions;
- review/audit.

## 17.1 Architectural debt quan trọng

Hiện đang tồn tại **hai knowledge management planes**:

### Plane A — Node legacy/live KB

Admin Web quản lý nhiều endpoint `kb/*`, documents, versions, templates, guide, legacy chunks.

### Plane B — Python Knowledge Governance + RAGFlow

Production retrieval sau cutover dùng Python governance + RAGFlow, với canonical XLSX/importer.

Hai plane này chưa được hợp nhất hoàn toàn.

Đây là điều đội viết mới phải giải quyết rõ ràng.

## 17.2 TARGET REWRITE

Chỉ nên có **một knowledge control plane**:

```text
Admin UI / importer
     |
     v
Knowledge Governance API
     |
     v
Postgres versions/outbox
     |
     v
RAGFlow derived index
```

Không để Admin Web publish vào một legacy index mà chatbot production không đọc.

---

# 18. Security CURRENT

## 18.1 Internal service auth

Python Knowledge API dùng `INTERNAL_SERVICE_TOKEN` Bearer auth cho internal endpoints.

Missing/wrong token trả 401.

## 18.2 Admin auth

Admin API có auth/session/role check. Write operations yêu cầu admin role phù hợp.

## 18.3 Secrets

API keys nhập từ Admin Web có thể được mã hóa với `SECRETS_KEY` qua secret box.

Không hard-code secret vào repository.

## 18.4 Customer secrets

Private key / seed phrase detection được xử lý deterministic và masking trước normal AI path.

## 18.5 Prompt injection

Grounded answering coi document/context là untrusted data. System instruction phải có priority cao hơn document instruction.

Bản viết mới phải có adversarial regression cho:

- user direct injection;
- indirect injection trong retrieved chunk;
- system prompt extraction request;
- malicious URL/instruction trong knowledge.

---

# 19. PostgreSQL data model quan trọng

Không cần bê nguyên toàn bộ schema vào bản viết mới ngay ngày đầu, nhưng các domain sau phải tồn tại.

## 19.1 Conversation domain

```text
users
messages
episodes
events
decisions
tickets
antispam
```

## 19.2 Operations domain

```text
jobs
settings
admins / sessions / audit-related records
llm_calls
usage_daily
outbox/delivery records
```

## 19.3 Knowledge domain

```text
knowledge_sources
knowledge_units
knowledge_versions
knowledge_conflicts
knowledge_ragflow_sync
knowledge_sync_outbox
```

## 19.4 Legacy domain

Repo vẫn còn các bảng legacy KB/Vault/pgvector.

Bản rewrite không cần duy trì chúng vĩnh viễn. Chỉ cần migration/import compatibility cho tới khi dữ liệu cần giữ đã được chuyển xong.

---

# 20. Job/Worker architecture CURRENT

Node worker dùng database-backed jobs và scheduled jobs.

Các pattern quan trọng:

- `FOR UPDATE SKIP LOCKED`;
- retry;
- dead-letter / terminal failure;
- idempotent scheduling;
- jobs tách khỏi request path;
- background LLM work cần throttle để không cạnh tranh với customer traffic.

Python knowledge-worker xử lý RAGFlow sync outbox.

## TARGET REWRITE

Không cần Redis/Kafka ngay nếu throughput hiện tại vẫn phù hợp.

Giữ Postgres queue cho v1:

```text
jobs table
SKIP LOCKED
attempt_count
next_run_at
last_error
dead state
```

Chỉ nâng lên external queue khi có metric chứng minh Postgres queue không đủ.

---

# 21. Observability CURRENT và yêu cầu viết mới

## 21.1 Hiện có

- structured service logs;
- `llm_calls`;
- token usage;
- latency per LLM call;
- decisions;
- events;
- job status;
- knowledge sync state;
- health endpoints.

## 21.2 Rewrite phải bổ sung/chuẩn hóa

Mỗi inbound turn nên có `correlation_id` xuyên suốt:

```text
Telegram inbound
 -> pipeline
 -> LLM calls
 -> retrieval
 -> RAGFlow
 -> final reply
```

Metrics tối thiểu:

- request count/error rate;
- retrieval P50/P95/P99;
- end-to-end P50/P95/P99;
- RAGFlow timeout/network/5xx count;
- LLM calls/turn;
- input/output tokens/turn;
- unknown pricing call count;
- estimated cost/day nếu pricing có cấu hình;
- escalation rate;
- no-answer rate;
- job retry/dead count;
- knowledge sync lag.

---

# 22. Những invariant KHÔNG ĐƯỢC phá khi viết mới

1. **Postgres là source of truth cho knowledge state.**
2. **RAGFlow không được tự quyết bản active.**
3. **Stale RAGFlow hit phải bị loại nếu Postgres không còn active.**
4. **Không evidence đủ -> không bịa.**
5. **Private key/seed không đi qua normal LLM path.**
6. **Conversation A không được leak sang B.**
7. **Update idempotency phải tránh double reply.**
8. **Không dùng unknown cost = $0.**
9. **Không gửi translation làm đổi URL/số/handle.**
10. **Background work không được làm nghẽn customer request.**
11. **No-answer tạm thời an toàn hơn stale-answer.**
12. **Không bỏ active-state revalidation chỉ để giảm một DB query.**

---

# 23. TARGET REWRITE — kiến trúc đề xuất

Vì hướng dự án là dần chuyển JS/TS sang Python, kiến trúc viết mới nên là **Python-first modular monolith + Postgres + RAGFlow**, chưa cần microservices hóa mọi domain.

## 23.1 Runtime target

```text
                    +------------------+
Telegram ---------->| Bot Ingress      |
                    | Python asyncio   |
                    +--------+---------+
                             |
                             v
                    +------------------+
                    | Support Pipeline |
                    +--+----+----+-----+
                       |    |    |
               security|    |    |memory
                       |    |    |
                       | retrieval
                       v    v
                 +-------------+        +----------------+
                 | Knowledge   |------->| RAGFlow        |
                 | Governance  |        | derived index  |
                 +------+------+        +----------------+
                        |
                        v
                   PostgreSQL
                        ^
                        |
                 +------+------+
                 | Admin API   |
                 +-------------+

LLM Gateway <---- LLM Adapter / ProviderChain
Worker      <---- Postgres jobs + knowledge outbox
```

## 23.2 Không chia microservice theo class

Phiên bản đầu có thể chạy thành 3 process từ cùng một codebase:

```text
api/admin
bot
worker
```

Knowledge/RAG có thể là module nội bộ hoặc process riêng nếu cần isolate load, nhưng cùng domain model và database.

## 23.3 Suggested Python project structure

```text
app/
  entrypoints/
    bot.py
    api.py
    worker.py

  domains/
    conversation/
      models.py
      service.py
      repository.py
    support/
      pipeline.py
      router.py
      resolver.py
    knowledge/
      models.py
      governance.py
      repository.py
      retrieval.py
      precedence.py
    security/
      secret_detection.py
      masking.py
      auth.py
    multilingual/
      language.py
      translation.py

  infra/
    postgres/
    ragflow/
    llm/
    telegram/
    logging/

  jobs/
    scheduler.py
    runner.py
    handlers/

  admin/
    routes/
    schemas/

tests/
  unit/
  integration/
  e2e/
  eval/
```

---

# 24. TARGET REWRITE — Interfaces bắt buộc

## 24.1 KnowledgePort

```python
class KnowledgePort(Protocol):
    async def search(self, query: str, k: int, language: str | None = None) -> list[RetrievalHit]: ...
    async def by_ids(self, ids: list[str]) -> list[RetrievalHit]: ...
```

Router không được gọi RAGFlow SDK trực tiếp.

## 24.2 LLMPort

```python
class LLMPort(Protocol):
    async def understand(...): ...
    async def select(...): ...
    async def verify(...): ...
    async def grounded(...): ...
    async def translate(...): ...
```

## 24.3 ChannelPort

```python
class ChannelPort(Protocol):
    async def send(...): ...
    async def download_image(...): ...
```

## 24.4 JobQueuePort

Không cần external MQ abstraction quá phức tạp, nhưng job runner không nên chứa SQL rải rác khắp business code.

---

# 25. TARGET REWRITE — Retrieval flow chuẩn

Đề xuất flow:

```text
1. normalize user query
2. understand / contextualize nếu cần
3. build bounded query variants
4. exact known-phrase branch
5. semantic retrieval per variant
6. weighted rank fusion
7. active-state revalidation
8. evidence gate
9. candidate selector nếu ambiguous
10. one grounded final answer
```

Không nên mặc định thêm cross-encoder/reranker external ngay.

Chỉ thêm nếu golden holdout chứng minh weighted retrieval + selector vẫn không đủ.

---

# 26. TARGET REWRITE — Evidence Gate

Trước khi gọi final answer model, nên tạo một structured decision:

```json
{
  "answerable": true,
  "evidence_ids": ["..."],
  "conflict": false,
  "missing": [],
  "confidence": 0.0
}
```

Nếu:

```text
answerable=false
```

thì bot phải:

- nói không đủ thông tin; hoặc
- escalate theo policy;

không gọi model theo prompt kiểu “hãy cố trả lời”.

---

# 27. TARGET REWRITE — Giảm LLM calls

Hiện flow có thể gọi nhiều bước LLM.

Target hợp lý:

### Câu rõ ràng

```text
retrieval
 -> evidence gate
 -> 1 final strong LLM
```

### Câu mơ hồ/follow-up

```text
1 fast contextualizer
 -> retrieval
 -> 1 final strong LLM
```

Verify/select chỉ dùng khi rule/evidence thực sự yêu cầu, không biến mọi request thành chuỗi 4-5 LLM calls.

---

# 28. API contracts nên chuẩn hóa trong bản rewrite

## 28.1 Retrieval

```http
POST /internal/retrieval/search
Authorization: Bearer <internal token>
```

```json
{
  "query": "...",
  "k": 8,
  "language": "vi",
  "request_id": "..."
}
```

Response:

```json
[
  {
    "id": "version-id",
    "knowledge_key": "support.xxx",
    "title": "...",
    "content": "...",
    "score": 0.83,
    "language": "en",
    "source_ref": "..."
  }
]
```

## 28.2 Knowledge ingest

Admin/import path phải đi qua cùng một governance service.

Không để một endpoint ghi legacy KB và một endpoint khác ghi production RAG store.

## 28.3 Health

Tách:

```text
/health/live
/health/ready
```

Readiness cần kiểm tra DB và cấu hình tối thiểu; không nhất thiết ping LLM provider mỗi request health.

---

# 29. Migration strategy cho đội viết mới

Không big-bang replace production.

## Phase A — Behavior parity

Viết lại các pure/deterministic module trước:

- language guards;
- masking/secret detection;
- precedence;
- evidence models;
- query fusion;
- pricing semantics.

Chạy cùng golden tests.

## Phase B — Knowledge/RAG parity

Python rewrite dùng cùng:

- Postgres governance tables;
- RAGFlow dataset hoặc một dataset shadow;
- 351-case golden set;
- canonical regression.

## Phase C — Conversation/memory parity

Port episodes/context building và chạy existing memory scenarios.

## Phase D — Bot shadow

Cùng inbound message nhưng service mới chỉ ghi quyết định/reply candidate, không gửi Telegram.

So sánh:

- routing;
- evidence;
- reply facts;
- escalation;
- latency;
- LLM calls/tokens.

## Phase E — Controlled cutover

Chuyển một ingress path sang implementation mới, giữ khả năng rollback.

Không migrate bằng cách cùng lúc thay DB schema + RAG store + LLM gateway + Telegram ingress.

---

# 30. Test strategy bắt buộc cho bản rewrite

## 30.1 Unit

- precedence;
- secret detection;
- language detection;
- translation validation;
- pricing;
- RRF/fusion;
- state transitions.

## 30.2 Integration

- Postgres migrations;
- SKIP LOCKED jobs;
- knowledge version update;
- sync outbox;
- RAGFlow error mapping;
- LLM usage recording;
- Admin auth.

## 30.3 Golden RAG

Phải có tối thiểu:

- canonical known queries;
- natural VI;
- VI no-diacritics;
- typo/slang;
- EN paraphrases;
- mixed language;
- multi-constraint;
- hard negatives;
- no-answer.

## 30.4 Adversarial

- direct prompt injection;
- indirect document injection;
- false premise;
- no evidence;
- malicious retrieved instruction;
- secret disclosure request.

## 30.5 Reliability

- connect timeout;
- read timeout;
- connection reset;
- RAGFlow 5xx;
- retry exhaustion;
- cancellation;
- recovery;
- concurrency sustained load;
- DB slow/failure simulation.

---

# 31. Acceptance criteria trước khi thay production

## Functional

- full regression pass;
- không double reply;
- memory scenarios pass;
- language guard pass;
- secret guard pass.

## Knowledge

- canonical regression không thấp hơn baseline;
- natural holdout Recall@5 >= 95%;
- natural holdout Top-1 >= 90%;
- no-answer metrics báo riêng;
- active/synced consistency không lỗi;
- stale RAGFlow document không bao giờ vào final evidence.

## Reliability

- RAGFlow timeout trả controlled error;
- không stack trace ra customer;
- sustained test không có unhandled exception;
- recovery sau upstream outage phải test được.

## LLM/Cost

- token accounting đúng;
- unknown pricing hiển thị unknown/N/A;
- no hidden fallback model;
- call count và token/turn có baseline trước/sau.

## Security

- internal endpoints auth;
- admin authorization;
- secret masking;
- prompt injection regression;
- no secrets trong tracked files/logs.

---

# 32. Những thứ KHÔNG nên làm khi viết mới

1. Không thêm multi-tenancy khi business không cần.
2. Không đổi RAGFlow chỉ vì natural-query score chưa đủ.
3. Không thêm GraphRAG nếu chưa có evidence cần graph traversal.
4. Không thêm Redis/Kafka chỉ vì “production architecture thường có”.
5. Không để RAGFlow làm source of truth.
6. Không bỏ Postgres active revalidation.
7. Không hard-code model price chưa xác minh.
8. Không gọi mọi step bằng strong LLM.
9. Không nhét full chat history vào prompt.
10. Không tự retry LLM/RAG vô hạn.
11. Không dùng timeout lớn hơn như cách duy nhất để “fix timeout”.
12. Không duy trì hai knowledge control plane sau khi rewrite hoàn thành.

---

# 33. Việc đã làm theo dòng thời gian kỹ thuật

## Giai đoạn 1 — legacy/OpenClaw audit và kiến trúc lại

- audit hệ thống cũ;
- đưa deterministic security/business logic ra khỏi prompt-only behavior;
- chuyển storage sang PostgreSQL;
- thêm migrations, repositories, jobs, Admin Web;
- tạo Node bot pipeline có test.

## Giai đoạn 2 — Vault/structured knowledge

- xây document/chunk/version flow;
- conflict detection;
- pgvector/FTS retrieval;
- approval/publish/rollback;
- evaluation tooling.

## Giai đoạn 3 — Python Knowledge Governance + RAGFlow

Commit:

```text
527b9cf feat: add python knowledge governance and ragflow migration
```

Đã thêm:

- FastAPI knowledge service;
- governance schema;
- source precedence;
- RAGFlow client;
- sync worker;
- Node `KnowledgePort` bridge;
- legacy/shadow/python modes;
- Python tests.

## Giai đoạn 4 — cutover sạch source production

Commit:

```text
e18a7a1 feat: cut over clean knowledge source to ragflow
```

Đã làm:

- chọn XLSX 2026-09-29 làm canonical;
- xác minh 109 units;
- backup trước reset;
- clear legacy vector/index cần thiết;
- import 109 active governance versions;
- sync 109/109 sang RAGFlow;
- chuyển retrieval production sang Python;
- thêm exact known customer phrase matching;
- bỏ cron Vault auto-index cũ;
- canonical eval 239/239 tại thời điểm cutover;
- health/regression pass;
- push main.

## Giai đoạn 5 — specialized AI audit

Đã kiểm tra:

- knowledge freshness;
- hallucination negative tests;
- conversation isolation;
- direct/indirect prompt injection;
- multilingual consistency;
- retrieval latency;
- LLM usage/cost telemetry.

Phát hiện chính:

- natural semantic retrieval yếu hơn canonical set;
- RAGFlow có ReadTimeout khi sustained concurrency;
- cost unknown đang hiển thị `$0`;
- translation chiếm tỷ lệ lớn LLM usage cần trace.

## Giai đoạn 6 — candidate hardening hiện tại

Đang ở working tree, chưa merge:

- natural golden set 351;
- query-plan + RRF fusion;
- wider candidate pool;
- pooled RAGFlow client + concurrency gate;
- controlled retrieval errors;
- cost unknown semantics/pricing config;
- translation failure backoff;
- regression tests và migrations liên quan.

---

# 34. Danh sách file/module lập trình viên mới nên đọc trước

Theo thứ tự:

```text
src/app.ts
src/bot/pipeline.ts
src/core/router.ts
src/bot/resolver.ts
src/bot/episodes.ts
src/llm/client.ts
src/llm/chain.ts
src/kb/python-knowledge.ts
python_app/interlink_support/api.py
python_app/interlink_support/knowledge/service.py
python_app/interlink_support/knowledge/repository.py
python_app/interlink_support/ragflow/knowledge.py
python_app/interlink_support/ragflow/client.py
python_app/interlink_support/ragflow/sync.py
src/db/migrations/013_knowledge_governance.sql
docker-compose.yml
content/eval/rag-natural-golden.jsonl
```

Sau đó mới đọc legacy Vault/KB để hiểu migration compatibility, không dùng legacy làm thiết kế target.

---

# 35. Checklist bàn giao cho đội viết mới

Đội nhận bàn giao phải xác nhận đã hiểu:

- [ ] single enterprise / global knowledge;
- [ ] Postgres source of truth;
- [ ] RAGFlow derived index;
- [ ] active revalidation;
- [ ] XLSX source hiện tại;
- [ ] 109 active units hiện tại;
- [ ] version/outbox model;
- [ ] bounded conversation memory;
- [ ] secret detection trước AI;
- [ ] LLM provider gateway + optional fallback;
- [ ] multilingual/translation guards;
- [ ] natural-query golden set;
- [ ] RAG timeout finding;
- [ ] cost telemetry finding;
- [ ] current two knowledge planes là debt cần hợp nhất;
- [ ] working-tree candidate fixes chưa phải production baseline;
- [ ] không push/deploy candidate changes nếu chưa qua holdout/stress/full regression.

---

# 36. Kết luận kiến trúc

Phần đáng giữ nhất của hệ thống hiện tại không phải là framework Node/Python cụ thể, mà là các boundary và invariant đã được hình thành qua audit:

```text
deterministic safety
    -> bounded conversation context
    -> explicit retrieval interface
    -> Postgres-governed knowledge state
    -> RAGFlow as disposable derived index
    -> evidence-aware LLM answer
    -> multilingual output guard
    -> auditable decision/usage/job records
```

Bản viết mới nên đơn giản hóa bằng Python-first modular architecture và hợp nhất knowledge management, nhưng không được bỏ các lớp bảo vệ ở trên.

Mục tiêu của rewrite không phải “đổi ngôn ngữ lập trình”. Mục tiêu là có một codebase dễ hiểu hơn, một knowledge control plane duy nhất, retrieval có eval thật, failure có semantics rõ, và mọi hành vi quan trọng đều có regression test.

