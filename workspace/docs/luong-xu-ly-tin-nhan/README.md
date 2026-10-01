# Luồng xử lý tin nhắn khách hàng — từ lúc nhận đến lúc trả lời

Tài liệu mô tả cách bot hỗ trợ InterLink nhận một tin nhắn của khách trên Telegram, xử lý và gửi câu trả lời. Có mô tả riêng cách bot xử lý khi **mất mạng** và khi **AI (LLM) lỗi**.

Nội dung viết theo code hiện tại của nhánh `feat/memory-phase1` (ngày 27/09/2026). Code thay đổi thì phải cập nhật lại tài liệu này.

## Trong thư mục này

| Tệp | Nội dung |
|---|---|
| [`01-tong-the.html`](01-tong-the.html) | Sơ đồ 1: toàn bộ luồng, từ tin của khách tới câu trả lời |
| [`02-router-ai.html`](02-router-ai.html) | Sơ đồ 2: bên trong bước Router AI (hiểu → tìm → chọn/xác nhận) |
| [`03-loi-llm.html`](03-loi-llm.html) | Sơ đồ 3: xử lý khi AI lỗi hoặc mất kết nối |
| [`04-mat-mang-telegram.html`](04-mat-mang-telegram.html) | Sơ đồ 4: mất mạng khi gửi tin, sập tiến trình giữa chừng |
| `anh/*.png` | Ảnh chụp sẵn của từng sơ đồ, để xem nhanh hoặc dán vào tài liệu khác |
| `nguon/*.workflow.json` | Bản nguồn của từng sơ đồ. Sửa tệp nguồn rồi xuất lại HTML (lệnh ở cuối tài liệu) |

Mở các tệp `.html` bằng trình duyệt. Không cần mạng hay cài đặt gì. Trong sơ đồ có thể kéo, phóng to, tìm kiếm, bấm vào một bước để xem các đường nối với nó, và xuất ảnh PNG/SVG.

---

## 1. Tổng quan một lượt xử lý (sơ đồ 1)

Một **lượt** là tất cả những gì bot làm cho một nhóm tin liên tiếp của một khách. Thứ tự các bước:

```
Khách → Nhận & gom tin → Kiểm tra trước → Chuẩn bị ngữ cảnh → Router AI → Dựng & dịch → Kiểm tra đầu ra → Gửi cho khách → Ghi nhận
```

Có ba nguyên tắc áp dụng cho mọi bước:

1. **AI chỉ chọn, không tự viết câu trả lời.** Khách nhận nguyên văn nội dung đã được duyệt trong kho, dịch trung thành sang ngôn ngữ của khách. Code kiểm tra lại mọi thứ AI trả về.
2. **Nội dung trong kho không bao giờ được gửi thẳng.** Câu trả lời nào cũng phải được AI chọn hoặc xác nhận ngay trong lượt đó.
3. **Khách nhắn bằng ngôn ngữ nào thì nhận câu trả lời bằng ngôn ngữ đó.** Khách không dùng tiếng Việt không bao giờ nhận chữ tiếng Việt.

### 1.1 Nhận & gom tin

- Bot nhận tin theo một trong hai chế độ: **webhook**, khi Telegram gọi vào bot và phải kèm đúng mã bí mật, sai mã thì bị từ chối; hoặc **polling**, khi bot tự hỏi Telegram liên tục (mỗi lần hỏi chờ tối đa 25 giây nếu chưa có tin mới).
- Tin của bot khác bị bỏ qua. Trong nhóm chat, bot chỉ trả lời khi được nhắc tên hoặc khi khách trả lời vào tin của bot.
- **Gom tin:** các tin một khách gửi liên tiếp trong **2 giây** được gộp thành một lượt. Ví dụ khách gửi 2 ảnh KYC liền nhau thì chỉ nhận 1 câu trả lời. Các lượt của cùng một khách chạy **lần lượt**, không bao giờ chạy song song.
- **Chống trả lời trùng:** mỗi update của Telegram chỉ được xử lý một lần. Chi tiết ở mục 4.

### 1.2 Kiểm tra trước (chỉ dùng code, chưa gọi AI)

Các bước dưới đây chạy theo đúng thứ tự:

| Bước | Xảy ra gì |
|---|---|
| **Lộ seed phrase / private key** (ưu tiên cao nhất) | Gửi ngay cảnh báo bảo mật, rồi dừng lượt. Tin này **không bao giờ** được đưa cho AI. Nội dung tin không được lưu, chỉ lưu dòng "[REDACTED]". Bot mở một vụ việc bảo mật riêng và báo cho chủ bot (owner). |
| Che dữ liệu nhạy cảm | Các phần còn lại của tin được che trước khi lưu và trước khi đưa cho AI. |
| Lệnh quản trị | Nếu admin gõ lệnh console cũ, bot trả về đường dẫn tới Admin Web. |
| **Chống spam** | Khách đang bị chặn thì bot im lặng. Khách đã được báo thời gian chặn từ trước. |
| **Hạn mức AI** | Mỗi khách được dùng tối đa **200.000 token mỗi ngày**. Vượt hạn mức thì lượt đó coi như không có AI, và khách nhận câu báo mất kết nối (xem mục 3). |

### 1.3 Chuẩn bị ngữ cảnh

- **Ảnh:** bot đọc tối đa 3 ảnh bằng AI để biết loại màn hình (KYC, hộp thoại lỗi, màn hình app…), chữ trong ảnh, và ảnh có chứa bí mật không. Nếu có bí mật, bot gửi thêm câu nhắc che thông tin và **không lưu** ảnh đó.
- **Ngôn ngữ:** code nhận diện ngôn ngữ trước, sau đó AI xác định lại. Code vẫn kiểm lại kết quả của AI: nếu chữ viết của tin là tiếng Hàn, Nhật, Nga… thì chữ viết thắng. Gặp một ngôn ngữ mới, bot xếp việc dịch sẵn các câu khẩn sang ngôn ngữ đó.
- **Vụ việc (episode):** bot nạp vụ việc đang mở của khách. Vụ việc gồm tóm tắt cuộn, các tin gần đây, những giá trị khách đã nêu (mã lỗi, phiên bản app, thiết bị…) và câu trả lời gần nhất. Nhờ đó bot hiểu được các tin nối tiếp như "vẫn không được", "cảm ơn".
- Trong lúc chờ AI, cứ 4 giây bot hiện "đang soạn…" một lần.

### 1.4 Router AI → kết quả của lượt

Router quyết định **một** trong các kết quả sau. Chi tiết ở sơ đồ 2.

| Kết quả | Ý nghĩa | Khách nhận |
|---|---|---|
| Trả lời bằng mục hỏi đáp | AI chọn hoặc xác nhận một câu trả lời đã duyệt | Câu trả lời đã duyệt, dịch sang ngôn ngữ của khách |
| Trả lời bằng tài liệu | Một đoạn tài liệu (whitepaper, hạ tầng…) trả lời được câu hỏi | Đoạn tài liệu nguyên văn, hoặc câu AI viết dựa trên đoạn đó có trích nguồn và đã qua kiểm tra |
| Hỏi lại khách | Câu hỏi mơ hồ giữa 2–4 mục đã được khai báo là khác nhau | Câu hỏi lại do người duyệt soạn sẵn. **Tối đa 1 lần cho mỗi vụ việc** |
| Chuyển nhân viên | Kho không có câu trả lời đúng, hoặc có điều không chắc chắn | Câu chuyển nhân viên kèm **mã tham chiếu**, có thể kèm khối tóm tắt để khách sao chép gửi bộ phận hỗ trợ |
| Ngoài phạm vi | Tin không liên quan InterLink | Cảnh báo chống spam theo bậc (xem 1.6) |
| Báo mất kết nối | Không gọi được AI | Câu báo mất kết nối (xem mục 3) |

Một số trường hợp code quyết định luôn, không cần đến Router:
- Khách chỉ gửi video, voice hoặc tài liệu mà không kèm chữ: bot không đọc được nên chuyển nhân viên.
- Khách gửi ảnh nhưng đọc ảnh bị lỗi: nếu lỗi do mất kết nối AI thì báo mất kết nối, lỗi khác thì chuyển nhân viên.

### 1.5 Dựng & dịch, kiểm tra đầu ra

- **Dịch có kiểm tra:** khách dùng tiếng Anh thì nhận nguyên văn. Với ngôn ngữ khác, bot lấy theo thứ tự: bản dịch người duyệt viết sẵn trong mục, rồi bản dịch đã lưu (nội dung gốc không đổi và bản dịch vẫn qua kiểm tra), rồi mới nhờ AI dịch.
- Mỗi bản dịch được code kiểm tra: phải giữ nguyên link, @tên tài khoản, tên sản phẩm và con số; link phải thuộc danh sách cho phép; phải đúng chữ viết của ngôn ngữ đích; không còn chữ tiếng Việt. Không đạt thì AI dịch lại kèm danh sách lỗi, **tối đa 3 lần**. Vẫn không đạt thì chuyển nhân viên.
- **Kiểm tra đầu ra** áp dụng cho mọi câu sắp gửi: link thuộc danh sách cho phép, độ dài không vượt 4096 ký tự, đúng ngôn ngữ của khách. Không đạt thì đổi sang chuyển nhân viên.
- **Lưới an toàn cuối:** nếu câu nào sắp gửi cho khách không dùng tiếng Việt mà vẫn còn chữ tiếng Việt, câu đó bị thay bằng câu chuyển nhân viên.

### 1.6 Chống spam theo bậc

Mỗi tin ngoài phạm vi đẩy khách lên một bậc: bậc 1 và 2 là nhắc nhở, bậc 3 chặn 1 phút, bậc 4 chặn 10 phút, bậc 5 chặn 30 phút, bậc 6 chặn 1 giờ, từ bậc 7 trở lên chặn 24 giờ. Nếu không dịch được câu cảnh báo sang ngôn ngữ của khách, bot không gửi câu nhưng **vẫn áp dụng** bậc chặn. Admin không bị chống spam.

### 1.7 Gửi & ghi nhận

- Tin gửi dạng chữ thuần. Tin dài hơn 4096 ký tự được tách thành nhiều tin. Khối tóm tắt gửi nhân viên được gửi dạng khối code để khách chạm vào là sao chép được.
- **Gửi lỗi thì không mất tin:** tin được đưa vào hàng đợi gửi lại (xem mục 4).
- Sau khi gửi, bot ghi lại: tin đến và tin trả lời, quyết định của lượt kèm lý do (để admin xem "vì sao bot trả lời thế này"), các sự kiện của vụ việc, và giá trị khách đã nêu. Khi chuyển nhân viên, bot tạo **phiếu hỗ trợ** mới hoặc ghi nối vào phiếu đang mở cùng loại.
- Khi vụ việc có từ 6 tin chưa tóm tắt, bot xếp một việc nền để tóm tắt cuộn. Việc này chạy sau khi đã trả lời nên không làm khách phải chờ.

---

## 2. Bên trong Router AI (sơ đồ 2)

Chế độ mặc định là **hai nhánh** (setting `router.mode = hybrid`).

1. **AI hiểu tin.** AI xác định ngôn ngữ, ý định (câu hỏi / chào hỏi / tin nối tiếp / ngoài phạm vi / không rõ) và viết lại câu hỏi bằng tiếng Anh để dùng cho việc tìm kiếm. Code kiểm câu viết lại: không được thêm con số hay tên sản phẩm không có trong tin gốc, nếu thêm thì bỏ câu viết lại.
   - Chào hỏi, sticker, emoji: gửi lời chào.
   - Ngoài phạm vi: chuyển sang chống spam.
   - Không rõ: chuyển nhân viên.
   - Tin nối tiếp: làm theo bước tiếp theo mà người duyệt đã khai báo trong mục. Nếu khách báo "vẫn chưa được" mà mục không khai báo bước tiếp theo, bot tìm cách khác trong kho, bỏ qua những gì đã gửi.
2. **Đường nhanh:** chỉ đi đường này khi tin khớp **chắc chắn** bằng luật hoặc từ khoá, với cụm từ khoá chiếm ít nhất 50% nội dung câu hỏi. Ngay cả khi khớp chắc chắn, **AI vẫn phải xác nhận** câu trả lời đúng ý khách. AI không xác nhận thì chuyển sang đường tìm kiếm.
3. **Tìm trong kho (chỉ dùng code):** tối đa 8 mục hỏi đáp (tìm theo từ khoá và theo nghĩa) và 4 đoạn tài liệu. Các mục phải qua điều kiện "cần có / loại trừ" mà người duyệt đã khai báo. Không tìm được gì thì chuyển nhân viên.
4. **AI chọn:** AI chỉ được chọn một mục **trong danh sách**, hoặc trả lời "chuyển nhân viên", "ngoài phạm vi", hay "cần hỏi lại". Nếu AI chọn một mục ngoài danh sách thì chuyển nhân viên.
5. **Mâu thuẫn trong kho:** nếu mục AI chọn đang mâu thuẫn với một mục khác mà chưa được giải quyết, bot dùng mục mới hơn, và AI phải xác nhận mục mới hơn đó. Nếu hai mục cùng mốc thời gian thì chuyển nhân viên.
6. **Đoạn tài liệu ở chế độ sinh:** AI viết câu trả lời có trích nguồn. Code chặn câu viết nếu có số liệu không có trong tài liệu, có dự đoán giá hay lợi nhuận, có link lạ, hoặc sai chữ viết. Bị chặn thì gửi nguyên văn đoạn tài liệu.

---

## 3. Khi AI lỗi hoặc mất kết nối (sơ đồ 3)

### 3.1 Chuỗi provider

Mọi lời gọi AI (hiểu, chọn, xác nhận, dịch, đọc ảnh, tóm tắt) đều đi qua **chuỗi provider**: gateway đã cấu hình trên Admin Web chạy trước, Anthropic gọi trực tiếp chạy sau làm dự phòng (nếu có khoá).

- Mỗi lần gọi chờ tối đa **30 giây**. SDK Anthropic tự thử lại thêm 1 lần.
- **Lỗi hạ tầng** gồm mất mạng, quá tải (429), máy chủ lỗi (5xx), sai khoá (401/403) và sai model (404). Gặp lỗi này, bot chuyển sang provider kế tiếp. Một provider lỗi **3 lần liên tiếp** thì **cầu dao ngắt**: bot bỏ qua provider đó **60 giây**, hoặc lâu hơn nếu provider yêu cầu chờ (retry-after).
- **Đầu ra hỏng** (JSON sai): bot thử provider khác. Lỗi này thuộc về riêng câu đó nên **không** ngắt cầu dao.
- **AI từ chối:** dừng ngay, không thử provider khác.

### 3.2 Bot làm gì với từng loại lỗi

| Tình huống | Kết quả | Khách nhận |
|---|---|---|
| Hết provider vì lỗi hạ tầng, AI chưa được cấu hình, hoặc khách vượt hạn mức token | **Báo mất kết nối** | Câu báo mất kết nối |
| Mất kết nối đúng lúc đang dịch câu trả lời | Đổi kết quả sang báo mất kết nối | Câu báo mất kết nối, các câu phụ bị bỏ |
| Mọi provider đều trả đầu ra hỏng, hoặc AI từ chối | **Chuyển nhân viên** | Câu chuyển nhân viên kèm mã tham chiếu |
| Dịch 3 lần vẫn không qua kiểm tra | **Chuyển nhân viên** | Câu chuyển nhân viên. Nếu chính câu này cũng không dịch được thì gửi **bản tiếng Anh gốc** |
| Lỗi hệ thống bất ngờ (DB, lỗi lập trình…) | Lượt bị huỷ | Câu báo mất kết nối. Bot tạo **phiếu "lỗi hệ thống"** để người thật theo dõi |

**Không bao giờ:**
- trả lời bằng khớp từ khoá khi AI lỗi,
- hiện lỗi kỹ thuật cho khách,
- gửi chữ tiếng Việt cho khách không dùng tiếng Việt.

### 3.3 "Câu khẩn" — câu phải gửi được ngay cả khi mất AI

Câu khẩn gồm: cảnh báo lộ seed/key, nhắc che thông tin trong ảnh, các câu chống spam, câu báo mất kết nối, và câu chuyển nhân viên khi dùng làm lối cuối. Các câu này không qua bước hiểu, chọn hay xác nhận. Bước AI duy nhất là **dịch**, và bot lấy bản dịch theo thứ tự:

1. Khách dùng tiếng Anh: gửi nguyên văn.
2. Bản dịch người duyệt viết sẵn trong mục.
3. **Bản dịch sẵn** đã lưu. Việc nền "dịch sẵn câu khẩn" chạy mỗi giờ, cho 16 ngôn ngữ mặc định và mọi ngôn ngữ khách đã từng dùng.
4. Dịch tại chỗ **một lần**, chờ tối đa **8 giây**. Câu báo mất kết nối **không** dịch tại chỗ, vì lúc đó AI đang lỗi.
5. Dự phòng: cảnh báo bảo mật, báo mất kết nối và chuyển nhân viên gửi **bản tiếng Anh gốc**, vì khách phải biết ngay. Câu chống spam thì không gửi.

Mỗi lần phải dùng dự phòng, bot ghi vết và xếp việc dịch sẵn cho ngôn ngữ đó, để lần sau khách nhận được bằng ngôn ngữ của mình. Nếu DB lỗi đúng lúc cần gửi câu báo lỗi, bot dùng bản dịch đọc được gần nhất còn giữ trong bộ nhớ. Không có bản đó thì dùng câu gốc tiếng Anh viết cứng trong mã nguồn.

### 3.4 Sau khi AI hoạt động trở lại

- Nếu câu hỏi của khách bị bỏ lỡ vì mất kết nối, bot ghi nhận nó là "câu hỏi chưa trả lời". Lượt kế tiếp dùng câu này làm điểm bắt đầu vụ việc.
- Cầu dao tự đóng lại sau 60 giây. Lần gọi thành công đầu tiên đưa bộ đếm lỗi về 0.
- Khách được hướng dẫn thử lại sau vài phút, hoặc liên hệ @interlink_technicalsupport.

---

## 4. Mất mạng khi gửi tin và sập tiến trình (sơ đồ 4)

### 4.1 Không mất tin đến, không trả lời trùng

- Bot chỉ xác nhận "đã nhận" với Telegram **sau khi** xử lý xong lượt và ghi DB xong. Ở chế độ webhook, bot trả mã 200. Ở chế độ polling, bot mới tiến offset.
- Tiến trình chết giữa chừng thì Telegram không nhận được xác nhận, nên gửi lại update. Bot xét update gửi lại như sau:
  - update **đã xử lý xong**: bỏ qua, khách không nhận câu trả lời trùng;
  - update **đang dở chưa quá 2 phút**: webhook trả 503 để Telegram gửi lại sau, polling chờ 5 giây;
  - update **bỏ dở quá 2 phút**: bot nhận lại và xử lý lại từ đầu.
- Polling lỗi mạng: thử lại sau 3 giây. Offset chỉ tiến tới update cuối cùng đã xử lý xong trong lô.

### 4.2 Không mất tin trả lời

- Gửi Telegram lỗi (mất mạng, Telegram trả lỗi…): tin được đưa vào **hàng đợi gửi lại**, giữ nguyên cả định dạng khối code.
- Việc nền "gửi lại" chạy **mỗi phút**, mỗi lần tối đa 50 tin. Nếu gửi vẫn lỗi, lần thử sau chờ 30 giây, rồi 60, 120… giây. Sau **5 lần** không được thì tin được đánh dấu hỏng.
- Việc báo "đang soạn…" lỗi thì bỏ qua, không ảnh hưởng tới lượt xử lý.

### 4.3 Việc nền

Các việc nền: gửi lại tin, dịch sẵn câu khẩn, tóm tắt vụ việc, đồng bộ whitepaper, dọn dữ liệu quá hạn… Mỗi việc lỗi được thử lại với thời gian chờ tăng dần, bắt đầu từ 30 giây, tối đa 1 giờ. Quá 5 lần thì việc chuyển vào danh sách **hỏng hẳn**, hiện trên Admin Web để người quản trị xử lý.

---

## 5. Tham chiếu mã nguồn

| Phần | Tệp |
|---|---|
| Nhận tin, webhook/polling, xác nhận với Telegram | `src/bot/main.ts`, `src/bot/telegram.ts` |
| Gom tin 2 giây, xử lý lần lượt theo khách | `src/bot/coalescer.ts` |
| Pipeline một lượt (kiểm tra trước → gửi → ghi nhận) | `src/bot/pipeline.ts` |
| Router hai nhánh, AI hiểu/chọn/xác nhận | `src/core/router.ts` (`routeHybrid`, `routeLlmFirst`) |
| Dịch có kiểm, câu khẩn | `src/bot/resolver.ts`, `src/core/fixed-messages.ts` |
| Chuỗi provider, cầu dao | `src/llm/chain.ts`, `src/llm/anthropic.ts`, `src/llm/openai-compat.ts` |
| Chống trùng update | `src/db/repo-conv.ts` (`claimUpdate`) |
| Hàng đợi gửi lại, việc nền | `src/worker/jobs.ts`, `src/worker/runner.ts`, `src/db/repo-ops.ts` |
| Các giá trị mặc định (2 giây, 200k token, 8 giây…) | `src/core/settings.ts` |

## 6. Sửa và xuất lại sơ đồ

Sửa tệp trong `nguon/`, sau đó chạy lệnh dưới đây từ thư mục skill Archify. Thay `01-tong-the` bằng tên sơ đồ cần xuất:

```bash
node bin/archify.mjs deliver workflow <đường dẫn>/nguon/01-tong-the.workflow.json <đường dẫn>/01-tong-the.html --quality showcase --json
```

Ghi chú: phần giao diện của trình xem sơ đồ (các nút, menu) hiển thị bằng tiếng Anh, vì Archify chưa hỗ trợ tiếng Việt cho phần này. Nội dung sơ đồ vẫn là tiếng Việt.
