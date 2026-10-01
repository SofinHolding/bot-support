# Đề xuất: giảm số lượt gọi AI trong luồng trả lời tri thức (tăng tốc phản hồi)

**Trạng thái**: đề xuất, chưa áp dụng. Cần chủ dự án đọc, quyết định, và người có quyền sửa SKILL áp dụng qua Admin Web —
theo đúng bất biến 1 trong CLAUDE.md (agent không được tự sửa nội dung SKILL/luật AI).

> **Đính chính 2026-09-30 (sau khi tài liệu này đã đưa ra)**: mục 3 "Phương án A" bên dưới (tắt `router.tier3_verify`)
> **sai** — đọc lại luồng điều phối thật ([src/bot/pipeline.ts:221-223](../../src/bot/pipeline.ts:221)) thì
> `router.mode = hybrid` luôn đi qua `routeHybrid` → `routeLlmFirst`, mà cài đặt `tier3_verify` chỉ được đọc bởi hàm
> `tier3()` ([src/core/router.ts:273](../../src/core/router.ts:273)) — hàm này KHÔNG nằm trong luồng đang chạy thật.
> Tắt cài đặt đó **không có tác dụng gì**, đã thử tắt và xác nhận bằng đo thật. Chỉ còn Phương án B (mục 3.2) là hướng
> khả thi. Đồng thời xác nhận lại: `router.tier3_mode` thật đang là `generative` (không phải `extractive`), nên bước
> gọi AI thứ 3 (`grounded`) là AI **viết câu trả lời có trích dẫn**, không phải bước "xác nhận lại" như mô tả ban đầu
> — mục 2 dưới đây đã sửa lại cho đúng.

## 1. Vấn đề đo được

Đo thật (2026-09-30, DB thật, LLM thật) cho các câu hỏi cần tra kho tri thức (vault): mỗi câu mất **11–16 giây**, gồm
đúng 3 lượt gọi AI tuần tự (lượt sau cần kết quả lượt trước, không song song được):

| Bước | `purpose` | Việc làm | Thời gian đo được |
|---|---|---|---|
| 1 | `understand` | Hiểu ý định + ngôn ngữ của khách | 2.4 – 3.6s |
| 2 | `select` | Chọn ứng viên đúng (SKILL `select-answer`) trong danh sách mẫu câu trả lời + đoạn tài liệu | 3.6 – 4.7s |
| 3 | `grounded` | AI xác nhận (hoặc viết) câu trả lời từ đoạn đã chọn | 3.3 – 6.2s |

Bước 1 khó bỏ (cần biết ngôn ngữ/ý định trước khi tìm kho). Cơ hội tăng tốc nằm ở bước 2 và 3 — hai bước này **có
lúc làm việc trùng nhau về mặt phán đoán** (cả hai đều phải trả lời "đoạn này có đúng là câu trả lời cho câu hỏi
không").

## 2. Vì sao có bước 3, và vì sao không nên xoá thẳng

- CLAUDE.md bất biến 3: *"Không có đường nào gửi thẳng nội dung trong kho cho khách: mọi câu trả lời phải qua SKILL
  AI đánh giá trong lượt đó (verify-answer / select-answer) rồi dịch."* — nghĩa là **bắt buộc phải có ít nhất một
  lượt AI đánh giá** trước khi gửi nội dung tri thức cho khách. Không thể bỏ hoàn toàn bước đánh giá này.
- `select-answer` (SKILL, bước 2) đã có yêu cầu R1: *"Choose a candidate ONLY if its text answers the customer's
  actual question."* — nghĩa là bước 2 **đã** phán đoán "đoạn này có trả lời đúng câu hỏi không" ở mức khá kỹ, dù
  nhiệm vụ chính của nó là chọn giữa nhiều ứng viên (gồm cả mẫu câu trả lời T: lẫn đoạn tài liệu K:), không phải chỉ
  xác nhận một đoạn.
- **Sửa lại cho đúng (xem đính chính đầu tài liệu)**: bước 3 (`grounded`) trên hệ thống thật đang chạy ở chế độ
  `router.tier3_mode = generative` ([src/core/router.ts:801](../../src/core/router.ts:801)) — nghĩa là AI **thật sự
  VIẾT câu trả lời mới** từ đoạn đã chọn (có trích dẫn), không phải chỉ "xác nhận lại". Code tự kiểm output này:
  trích đúng đoạn đã chọn, không bịa số liệu ngoài nguồn, không đoán giá/ROI, đúng ngôn ngữ khách — không đạt thì tự
  động gửi nguyên văn đoạn gốc thay cho câu AI viết. Đây KHÔNG phải việc thừa: viết lại tự nhiên hơn nguyên văn tài
  liệu là mục đích chính của chế độ `generative` (khác với chế độ `extractive`, chỉ gửi nguyên văn, không cần bước
  này).

**Không đề xuất xoá bước 3**, vì nó vừa là nơi sinh ra câu trả lời (không phải bước thừa) vừa có lớp code kiểm output
— đúng tinh thần "mọi đầu ra AI được code kiểm lại". Đề xuất là **gộp việc "chọn" (bước 2) và "viết có kiểm chứng"
(bước 3) vào MỘT lượt gọi duy nhất**, để AI chọn xong viết luôn trong cùng một lần suy luận thay vì hai lượt tách
rời — vẫn giữ nguyên mọi lớp kiểm tra bằng code sau đó.

## 3. Phương án đề xuất

### ~~Phương án A~~ — ĐÃ LOẠI: không có tác dụng

~~Tắt `router.tier3_verify` qua Admin Web~~ — **đã thử tắt thật (2026-09-30) và xác nhận không đổi được gì**: cài đặt
này chỉ được đọc bởi hàm `tier3()`, hàm này không nằm trong luồng `routeHybrid`/`routeLlmFirst` mà `router.mode =
hybrid` đang dùng (xem đính chính đầu tài liệu). Bỏ qua phương án này.

### Phương án B (viết lại 2026-09-30) — Gộp SKILL `select-answer` với bước viết câu trả lời, giảm 3 lượt còn 2

Hệ thống thật đang chạy `router.tier3_mode = generative`, nên phương án duy nhất còn tạo được khác biệt tốc độ thật
là gộp đúng cặp bước đang chạy thật: **bước 2 (`select`, chọn ứng viên) + bước 3 (`grounded` chế độ generative, AI
viết câu trả lời có trích dẫn)**.

Sửa `content/skills/select-answer/SKILL.md` (qua Admin Web, người có quyền):

- Bỏ giới hạn "you never write the reply yourself" **chỉ cho trường hợp** ứng viên được chọn là `K:` (đoạn tài
  liệu) — khi đó, thêm yêu cầu: AI phải viết luôn câu trả lời cho khách trong CÙNG câu trả lời JSON, bằng đúng ngôn
  ngữ khách, có trích dẫn đoạn nguồn (`cited: [chunk_id, ...]`) — giữ nguyên các ràng buộc hiện có của `grounded()`
  (không bịa số liệu ngoài nguồn, không đoán giá/ROI, không lộ công thức nội bộ).
- Vẫn giữ nguyên hành vi cũ khi chọn `T:` (mẫu câu trả lời đã duyệt) — không viết gì thêm, gửi nguyên văn như hiện
  tại (đa số lưu lượng đi đường này, vốn đã nhanh).
- Sửa [src/core/router.ts](../../src/core/router.ts) (đoạn 600-826): khi `pick` trả về cả `ref` lẫn `answer` đã viết
  cho trường hợp `K:`, **bỏ lượt gọi `llm.grounded()` riêng** — dùng thẳng `answer` đó, chạy qua ĐÚNG các bước kiểm
  tra bằng code hiện có (`checkOutput`, `numbersNotIn`, `scriptProblem`, kiểm trích dẫn nằm trong danh sách ứng
  viên) — không đạt thì gửi nguyên văn đoạn gốc, y hệt cơ chế dự phòng đang có ở bước 3 hiện tại.
- **Vẫn giữ riêng lượt `grounded()` cho trường hợp khác ngôn ngữ** (`crossLanguage`, [src/core/router.ts:294](../../src/core/router.ts:294)) —
  nhưng lưu ý dòng này thuộc hàm `tier3()` KHÔNG nằm trong luồng thật (xem đính chính đầu tài liệu); trên
  `routeLlmFirst` thật, cần kiểm tra lại xem có logic tương đương xử lý khác-ngôn-ngữ hay không trước khi sửa, để
  không bỏ sót trường hợp này.

**Vì sao đây là thay đổi có rủi ro thật, không phải việc nhỏ**: gộp "phán đoán chọn đúng giữa nhiều ứng viên" với
"viết văn tự nhiên có trích dẫn" vào MỘT lượt suy luận có thể khiến AI kém nghiêm khắc hơn ở phần phán đoán (dễ bị
việc viết văn "kéo" sang chọn ứng viên dễ viết thay vì ứng viên đúng nhất) — đây là lý do chính đáng để KHÔNG tự làm
mà cần chủ dự án cân nhắc, và **bắt buộc chạy `eval:live` đạt** (so sánh trực tiếp với bản hiện tại bằng
`scripts/vault-eval.ts`, mở rộng thêm case cho tài liệu cũ) trước khi áp dụng thật, đúng CLAUDE.md bất biến 1.

## 4. Việc cần làm khi áp dụng (không phải việc của agent)

1. Người có quyền sửa SKILL cập nhật `content/skills/select-answer/SKILL.md` qua Admin Web theo mô tả ở Phương án B;
   agent có thể hỗ trợ sửa phần code `router.ts` tương ứng SAU KHI SKILL đã đổi.
2. Chạy `scripts/vault-eval.ts` (và mở rộng thêm case cho các chủ đề tài liệu cũ, không chỉ vault) so sánh trước/sau
   — không áp dụng nếu tỷ lệ đúng giảm.
3. Cân nhắc chạy song song một thời gian (vd bật cho 10% lưu lượng) trước khi áp dụng 100%, nếu Admin Web có hỗ trợ
   cấu hình theo tỷ lệ — nếu chưa có, ít nhất theo dõi sát `decisions`/escalate rate vài ngày đầu sau khi đổi.

## 5. Lợi ích ước tính

- Tiết kiệm ~3-6 giây cho **mọi câu hỏi được trả lời bằng đoạn tài liệu (`K:`) qua chế độ `generative`** — phần lớn
  lưu lượng thực tế hiện nay theo log đo được (luồng FAST PATH/template `T:` vốn đã nhanh, 1-2 lượt gọi, không đổi).
- Lợi ích chỉ đến khi áp dụng thật Phương án B (đã viết lại 2026-09-30) — không còn phương án "miễn phí, không sửa
  gì" nữa như bản đầu tài liệu này từng nói.
