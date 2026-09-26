# CLAUDE.md — InterLink Support Bot

Hướng dẫn cho agent làm việc trong repo này. Đọc trước khi đề xuất thay đổi.

## Bản đồ

- `src/core/`: luật thuần, không I/O.
  - `router.ts`: chọn câu trả lời.
  - `gate.ts`: cổng quyết định.
  - `template-index.ts`: sinh ứng viên.
  - `items.ts`: mô hình mục hỏi đáp; parse, kiểm tra, dịch sang template.
  - `knowledge.ts`: cắt đoạn tài liệu.
  - `followup.ts`: tin nối tiếp.
- `src/kb/`: kho nội dung.
  - `service.ts`: nháp → kiểm tra 6 bước → publish → rollback; `itemGate` là luật chặn publish của mục hỏi đáp.
  - `routing-check.ts`: "hỏi thử bot".
  - `pair-decisions.ts`: quyết định theo cặp, gắn hash nội dung.
  - `migrate-items.ts`, `review-import.ts`: chuyển dữ liệu cũ, áp quyết định của khách.
- `src/bot/`: pipeline Telegram, episode (gồm `pending_clarify`: hỏi lại khách 1 lần).
- `src/admin/`: API Fastify (`server.ts`) + SPA vanilla (`web/app.js`; CSP chặt, không `innerHTML`).
- `src/db/migrations/`: SQL tăng dần. Không sửa migration đã phát hành, chỉ thêm file mới.
- `content/`:
  - `skills/*/SKILL.md`: chỉ dẫn cho AI;
  - `guide/agent-guide.md`: Hướng dẫn AI làm việc;
  - `config/predicates.yml`;
  - `templates/`, `knowledge/`: nội dung gốc cho seed.
- `docs/KIEN_TRUC_KIEN_THUC.md`: kiến trúc hệ thống kiến thức; đọc trước khi động vào kb/router.
- `docs/adr/`: các quyết định lớn và lý do.

## Lệnh

```bash
npm run typecheck
npm test
npx vitest run tests/items.test.ts
```

Test chạy trên PGlite (Postgres trong bộ nhớ), không cần DB thật. `tests/pg-driver.test.ts` cần mở cổng TCP cục bộ và có thể bị bỏ qua trên Windows.

Script thao tác dữ liệu (`scripts/*.ts`) chỉ ghi file vào `.staging/` (gitignored), trừ khi tài liệu đầu file nói khác.

## Bất biến — KHÔNG được làm

1. **Không đổi nghĩa** các luật [CODE]/[AI] trong `agent-guide`, các yêu cầu R1… trong SKILL, mẫu SECURITY_RULE, `predicates.yml`, quy trình kiểm tra/duyệt. Thay đổi các nội dung này chỉ đi qua **Admin Web** (duyệt hai người khi bật `approval.second_person`; owner đã chốt không bắt buộc người thứ hai — QĐ2). Đổi SKILL hay đầu vào của AI phải chạy `eval`/`eval:live` đạt trước khi áp dụng. Agent chỉ được soạn đề xuất (`docs/de-xuat/`), không sửa thẳng file.
2. Luồng nạp nội dung (intake) **không bao giờ** tạo hay sửa "Hướng dẫn AI làm việc" (`agent-guide`).
3. AI chỉ **chọn**, không viết câu trả lời. Khách nhận nguyên văn nội dung đã duyệt (dịch trung thành). Mọi đầu ra của AI được code kiểm lại.
   **Không có đường nào gửi thẳng nội dung trong kho cho khách:** mọi câu trả lời phải qua SKILL AI đánh giá trong lượt đó (verify-answer / select-answer) rồi dịch.
   Dịch luôn do AI làm (không có bước duyệt bản dịch); không đạt kiểm tra thì dịch lại kèm lỗi, vẫn không đạt thì chuyển nhân viên. **Mọi câu gửi khách bằng ngôn ngữ của khách (QĐ1)**; khách không dùng tiếng Việt không bao giờ nhận chữ tiếng Việt. Mất kết nối LLM (hoặc chưa cấu hình, hết ngân sách) -> câu `network-disconnected`, outcome `UNAVAILABLE`. Không thêm lại chế độ trả lời bằng từ khoá khi AI lỗi, không thêm cài đặt tắt bước AI xác nhận.
   **Câu khẩn** (QĐ3; `URGENT_TEMPLATE_IDS` ở `src/core/fixed-messages.ts`: cảnh báo lộ seed/private key, cảnh báo ảnh chứa bí mật, chống spam, báo mất kết nối, câu chuyển nhân viên dùng làm lối cuối) chỉ qua **một** bước AI là dịch (`ResponseResolver.forUrgent`): bản dịch sẵn (job `prewarm-urgent-translations`) hoặc dịch tại chỗ với thời gian chờ ngắn; không qua understand/select/verify. Không có bản dịch hợp lệ: cảnh báo bảo mật, báo mất kết nối, câu chuyển nhân viên gửi bản gốc tiếng Anh (khách phải biết ngay); chống spam không gửi câu nhưng vẫn áp bậc chặn. Mỗi lần rơi vào dự phòng ghi event `urgent_fallback` và xếp việc dịch sẵn.
   **Không bao giờ gửi bí mật của khách cho AI** (N8): tin có seed/private key đã phát hiện không đi vào lời gọi LLM nào; lời gọi dịch câu khẩn chỉ nhận câu mẫu. Giới hạn: ảnh vẫn phải qua SKILL đọc ảnh để biết có bí mật hay không, và chỉ bí mật mà `detectKeyLeak`/`maskSensitive` nhận ra mới được chặn.
4. Mục hỏi đáp:
   - không có độ ưu tiên dạng số;
   - không có cụm nhận biết một từ;
   - không đổi `id` đã publish;
   - không gộp hai mục chỉ vì giống chữ; gộp là quyết định của người duyệt;
   - hai mục dễ lẫn phải khai báo `distinct_from` kèm câu hỏi lại.
5. Xung đột dữ liệu phải xử lý xong trước khi publish (`itemGate`, `reviewGate`). Không hạ lỗi xuống cảnh báo để cho qua. AI không kiểm tra được một cặp thì cặp đó bị chặn, không được coi là "không có xung đột".
6. Không gọi dịch vụ AI / embedding **trả phí** trong script hay test mà không hỏi người dùng. Test dùng `fakeLlm()` và `HashEmbedder`.
7. Câu hỏi gửi khách hàng (người sở hữu nội dung) chỉ lấy từ xung đột mà các phương pháp của dự án phát hiện, không tự suy luận ra.
8. Báo cáo cho người dùng viết bằng lời thường, không có mã code hay id (trừ cột "Mã hệ thống" dùng làm khoá).

## Quy ước

- Comment và thông báo lỗi cho admin viết bằng tiếng Việt. Câu trả lời gốc cho khách viết bằng tiếng Anh.
- Thông báo lỗi kiểm tra phải nói **cần làm gì**, không chỉ nói sai ở đâu.
- Sửa `app.js`: dùng `h()`/`textContent`; không handler inline; không `innerHTML`.
