# AI_HANDOVER — InterLink Support Bot

Cập nhật: 2026-10-02. Nguồn thiết kế đầy đủ: `docs/HANDOFF_REWRITE_SYSTEM_DESIGN_2026-10-02.md`. File này chỉ ghi trạng thái ĐÃ XÁC MINH và việc tiếp theo. Không chứa secret.

## 1. Tổng quan
Chatbot hỗ trợ khách InterLink (Telegram). Một doanh nghiệp, tri thức dùng chung (`scope_key=default`). AI chỉ chọn/kiểm; khách nhận nguyên văn nội dung đã duyệt (xem `CLAUDE.md`).

## 2. Kiến trúc (đã đối chiếu với container đang chạy)
Telegram → Node bot (`src/bot/pipeline.ts`) → router (`src/core/router.ts`: understand → query plans → RRF → select → verify → dịch) → Python Knowledge API (`:3010`, FastAPI) → exact match Postgres + RAGFlow (`:9380`) → revalidate `status='active'` trong Postgres. Worker Node (jobs), 4 `knowledge-worker` Python (outbox → RAGFlow). LLM qua gateway OpenAI-compatible `:20128/v1`.

## 3. Stack
Node ≥22 + TypeScript + Fastify + Vitest (PGlite); Python 3.12 + FastAPI + httpx; PostgreSQL 16 + pgvector; RAGFlow tự host; Docker compose.

## 4. Branch / commit
`fix/rag-reliability-cost-audit`, HEAD `e18a7a1` (= main). TOÀN BỘ thay đổi bên dưới chưa commit. Container local đang chạy đã chứa phần lớn candidate (migration 014/015 đã áp lúc 03:37Z) nhưng KHÔNG chứa fix `language.ts` (chữ viết bn/ur/te/kn/ps) và 2 fix mới của phiên này.

## 5. Trạng thái tính năng
| Hạng mục | Trạng thái | Bằng chứng |
|---|---|---|
| RAG-001 query plan + weighted RRF + pool 20 | IMPLEMENTED, đo thật (chưa đạt mục tiêu) | mục 10 |
| REL-001 pooled client + gate + 502/503 | VERIFIED COMPLETE (local) | stress 351 req @16: 0 lỗi |
| REL-002 retrieval lỗi → `UNAVAILABLE` (mới) | VERIFIED (test) | `tests/llm-first.test.ts` |
| REL-003 RAGFlow 4xx/non-JSON → 502 (mới) | VERIFIED (test) | `python_tests/test_ragflow_client.py` |
| COST-001 cost unknown ≠ $0 | VERIFIED COMPLETE | `tests/prices.test.ts`; 20,146 call 7 ngày đều `unknown` đúng (chưa cấu hình `LLM_PRICING_JSON`) |
| COST-002 translation backoff | VERIFIED COMPLETE (root cause) | 165 call/giờ = 55 cặp×3 → 0 sau 03:37Z |
| Validator chữ viết bn/ur/te/kn/ps | IMPLEMENTED BUT NOT DEPLOYED | worker đang chạy `Script=Bengali`=0 |
| Hai knowledge plane (Node KB admin vs Python governance) | NOT RESOLVED (nợ kiến trúc) | handoff §17 |

## 6. Đang dở
Deploy candidate + fix mới; cấu hình `LLM_PRICING_JSON`; commit.

## 7. Bug đã biết
- 55 cặp dịch `fp-12-escalate` × {bn,ur,te,kn,ps} (11 template mỗi ngôn ngữ) thất bại vì validator cũ coi là chữ Latin; thử lại lúc ~10:34Z (+165 call) rồi backoff 24h, cho tới khi deploy fix.
- Retrieval Top-1 chỉ 65.4% (xem 10); selector bù lại.
- Hard-negative "đảm bảo ngày niêm yết cố định" vẫn bị chọn nhầm FAQ niêm yết (1/12 no-answer).
- RAGFlow gần như tuần tự: ~3.6 req/s, p95 5.3s ở 16 đồng thời.
- `ruff format --check` báo 3–4 file chưa format (có sẵn từ trước, không bắt buộc).

## 8. Đã sửa (phiên này)
`router.ts` bắt lỗi search → `UNAVAILABLE` (không ticket system-error hàng loạt); `ragflow/client.py::_unwrap` map 4xx/non-JSON → `RagFlowError`; `scripts/eval-rag-golden.py` ép UTF-8 stdout (crash Windows); `tests/helpers.ts` expose `World.knowledge`.

## 9. Lệnh test
```
npm run typecheck && npx vitest run
python -m pytest python_tests -q && python -m ruff check python_app python_tests
python scripts/eval-rag-golden.py --split holdout --workers 4        # chỉ retrieval thô, không LLM
npx tsx scripts/eval-rag-production.ts --split holdout --workers 2 --json-out out.json   # LLM + RAGFlow thật (tốn token), cần env LLM_*, INTERNAL_SERVICE_TOKEN
```

## 10. Kết quả mới nhất (2026-10-02, stack local thật)
- Node 537/537, Python 30/30, typecheck + ruff check PASS.
- Holdout 93 ca, đường production thật (LLM + RAGFlow + RRF + select), 2 worker, 430s: retrieval Top-1 **65.4%**, Recall@5 **91.4%**, selected accuracy **90.1%**, no-answer precision 78.6% / recall 91.7%.
- Retrieval thô (không rewrite) holdout: Top-1 37.0%, Recall@5 61.7% → rewrite+RRF là thứ nâng chất lượng.
- Mục tiêu handoff: Recall@5 ≥95% **CHƯA ĐẠT** (91.4%); end-to-end Top-1 ≥90% đạt sát (90.1%). 9 lỗi: 4 nhầm sang doc anh em gần nghĩa (có thể nhãn golden mơ hồ), 3 câu chào/mơ hồ → ESCALATE (có thể chấp nhận), 1 hard-negative, 1 sai thật. Không được tune trên holdout; muốn cải thiện hãy dùng dev (258 ca) rồi đo lại holdout một lần.
- Stress retrieval thô: 351 req, 16 đồng thời, 0 lỗi HTTP, p99 5.7s.

## 11. DB / migration
014 (cost_status, cost nullable, `translation_failures`), 015 (re-queue 109 bản active vào outbox; đã chạy xong: 109 active, outbox 109 done). Không sửa migration đã phát hành.

## 12. Môi trường
`.env` (không commit): `LLM_*`, `INTERNAL_SERVICE_TOKEN`, `RAGFLOW_*` (pool/timeout/concurrency mặc định trong `.env.example`), `RETRIEVAL_PROVIDER=python`, tuỳ chọn `LLM_PRICING_JSON` (USD/1M token, chỉ khai giá đã xác minh).

## 13. Việc tồn đọng
1. Deploy + xác minh 55 cặp dịch thành công (cần chấp thuận).
2. Commit/PR.
3. Nâng Recall@5 (dev set), xử lý hard-negative ngày niêm yết.
4. Hợp nhất hai knowledge plane.
5. Chưa chạy: test adversarial/prompt-injection mới, E2E Telegram thật, đo LLM calls/token mỗi lượt trước–sau.

## 14. Giới hạn
Cost chỉ `unknown` cho tới khi có `LLM_PRICING_JSON`; prompt cache không dùng; eval holdout đã đo một lần cho bản này — đo lại sau khi tune sẽ không còn là holdout sạch.

## 15. Bước tiếp theo chính xác
1. Hỏi owner: deploy (`docker compose build bot worker admin && up -d`) rồi chờ vòng prewarm kế; kiểm `select count(*) from translation_failures` giảm và `llm_calls` translate không tăng.
2. `npx tsx scripts/eval-rag-production.ts --split dev` để phân tích lỗi Recall@5, sửa, rồi đo holdout lần cuối.
3. Viết regression adversarial + đo calls/turn.
