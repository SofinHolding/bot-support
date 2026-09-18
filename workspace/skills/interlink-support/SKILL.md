---
name: interlink-support
description: >
  Bộ template support InterLink. Copy-paste NGUYÊN VĂN, không rewrite. Top 12 case đã có ở AGENTS.md FAST-PATH (FP-1→FP-13) — bot đọc file này CHỈ khi không match FAST-PATH.
---

# InterLink Support — Compact Templates

**⚠️ RULE:** Mọi `→ ...` dưới đây là **GỬI NGUYÊN VĂN**. Không thêm intro/closing. Dịch sang ngôn ngữ user nếu cần (xem rule Ngôn ngữ trong AGENTS.md). Giữ nguyên URL + tên sản phẩm (Interlink, ITLG, ITL, HCS, HHP) + Telegram handle.

**📌 Trước khi dùng SKILL.md:** check FAST-PATH (FP-1→FP-13) trong AGENTS.md. Hầu hết case thường gặp đã ở đó. SKILL.md là **fallback** cho case ít gặp.

---

## 🔁 Follow-up rules (đặc biệt)

### Sau template "đổi email" (FP-7), user reply "không còn email cũ" / "no longer have old email" / "lost old email":
→ `You need a verification code from your old email in order to change to a new email. We currently don't support changing email addresses. You can still log in using face verification.`

### Sau template "burn ITLG" (FP-4), user reply "not burn" / "no" / "không phải burn":
→ ESCALATE (FP-12 template).

### Sau template "OTP email", user reply "not receive" / "still not receive" / "vẫn không nhận được":
→ ESCALATE (FP-12 template).

### Sau template "Got verification email nhưng app vẫn ở queue" (KYC notification), phân loại turn tiếp theo:

**Case 1 — User gửi THÊM ảnh KYC (email InterLink Type 1 hoặc screen app Type 2 — xem FP-5b) — KHÔNG kèm text hoặc text trùng nội dung cũ:** Đây KHÔNG phải follow-up, chỉ là user gửi thêm evidence cho cùng case.
→ **GỬI LẠI NGUYÊN VĂN cùng template KYC notification** (lặp lại OK):
```
That's just a notification email. Please monitor the KYC section in the Interlink app regularly for the official request to submit your documents. Be sure not to miss the 24-hour submission deadline
```

**Case 2 — User HỎI TIẾP với nội dung mới (CHỈ áp dụng khi turn này KHÔNG kèm ảnh FP-5b Type 1/Type 2):** match keyword: `Nooo`, `still nothing`, `still not`, `still wait`, `still waiting`, `vẫn chưa thấy`, `vẫn chưa được`, `vẫn ko thấy`, `đã chờ mấy ngày`, `waited X days`, `checked but no`, `not yet`, `still pending`, `still waiting after`, `help me please`, `what should I do`, `tôi phải làm gì`, `giúp tôi với`, `please help`, hoặc câu hỏi/yêu cầu hỗ trợ thêm.

**⚠️ Lưu ý quan trọng:** Nếu turn này có ẢNH match FP-5b (Type 1 email InterLink hoặc Type 2 screen KYC queue) → KHÔNG match Case 2, áp dụng FP-5b HIGHEST PRIORITY OVERRIDE → reply NGUYÊN VĂN template KYC notification (kể cả khi caption text là "still wait", "still nothing", v.v.).
→ **HANDOFF theo AGENTS.md FP-12** (bước 5 KB → bước 6 handoff). **⛔ KHÔNG output câu nào trước/sau** ngoài dòng hướng dẫn + fenced block của `skills/support-handoff/SKILL.md`.

**Case 3 — User cảm ơn/đồng ý** (`okay thank you`, `thanks`, `got it`, `ok`, `cảm ơn`):
→ `You're welcome` (không escalate).

---

## 💰 ITLG & Token

### ITLG → ITL conversion
**Keywords:** "chuyển ITLG sang ITL", "convert ITLG to ITL", "ITLG to ITL".
→ `ITLG hasn't entered the verification phase yet. Please stay tuned for updates`

### Cách recover ITLG (sau burn)
**Keywords:** "recover ITLG", "lấy lại ITLG", "khôi phục ITLG".
→ ```
If your ITLG was burned due to inactivity, it will be restored once you complete the full mining streak.

If the burn was caused by your downline being inactive, they need to become active again and complete the mining streak to fully restore the burned ITLG. Once that happens, the ITLG burned from your downline will also be credited back to you.

📹 Demo: https://drive.google.com/file/d/15AwUgjMbGSDcomzePlRIZ08-d5uC3ZYo/view?usp=drive_link
```

### Tại sao ITLG mine được ít hơn (giảm 50%)
**Keywords:** "giảm 50%", "ITLG ít", "mine ít", "DAO", "vote".
→ `Through Interlink DAO, with 99% community approval via voting, we have reduced the number of ITLG tokens mined per session by 50%. With the main purpose of preventing ITLG inflation.`

### Cách kiếm thêm ITLG
**Keywords:** "earn more ITLG", "kiếm thêm ITLG", "tăng ITLG", "how to earn".
→ ```
1. You only need to claim ITLG once every 4 hours.
2. Invite your friends using your referral code —> for each person you invite, you'll earn 500 ITLG and boost your mining speed by 0.2x.
3. Join the in-app game and reach Tier 6 or higher to receive weekly and monthly rewards.
4. On top of that, you can earn even more ITLG by playing games and participating in events on Telegram and Discord.
5. Join a mining group to receive additional ITLG daily.
```

### Mine đều nhưng vẫn bị burn (SECONDARY — chỉ khi user nói rõ "I mine daily but still burned")
**Keywords (CHỈ khi rõ ràng):** "I mine every day but still got burned", "mine đều mà vẫn bị burn", "ngày nào cũng mine mà bị trừ".
→ ```
If you mine daily but still get burned, it's likely your referral got burned to 0, so you'll be deducted:
+ 1000 ITLG for F1
+ 500 ITLG for F2

If you've already been deducted once, and the same referral gets burned to 0 again later, you will NOT be deducted again.
```

### M03 — Chưa nhận Weekly Reward
**Keywords:** "weekly reward", "monthly reward", "chưa nhận thưởng tuần/tháng".
→ ```
Weekly game reward is paid at 3AM UTC+0 on Sunday.
Monthly reward is paid on the first day of the month at 3AM UTC+0.

If you still haven't received your reward past this time, please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance.
```

---

## 🆔 Account & Login

### Cách login
**Keywords:** "how to login", "cách login", "đăng nhập".
→ `Just enter your ID and proceed to log in.`

### S03 — Scan face đen thui
**Keywords:** "scan face black", "scan đen", "camera không hoạt động", "camera black screen".
→ `Please go to Settings and check if you have granted camera permission to the Interlink Network app.`

### S04 — Quên Login ID
**Keywords:** "forgot login ID" (KHÁC với "forgot ID" — FP-8).
→ ```
Please tap "Forgot Login ID" and perform a face scan — this will recover your Login ID.

If that doesn't work, please record your screen during the face scan and send a portrait photo so our Dev can check.
```

### O03 — Sinh đôi (twin account)
**Keywords:** "twin", "sinh đôi", "anh em sinh đôi", "cùng mặt".
→ `We're currently updating this feature. Thank you for your patience.`

### Hướng dẫn đăng ký (full signup flow)
**Keywords:** "how to sign up", "cách đăng ký", "register", "create account".
→ ```
1. Download the App:
 For iPhone: Go to the App Store and search for "Interlink"
 For Android: Go to Google Play and search for "Interlink"
2. Sign Up:
 Open the app and click "Sign Up".
 Enter your ID (A random number sequence created by you, not matching any other InterLink account).
The password consists of 6 digits, created by you, and please remember it
3. Complete Profile & Face Verification:
 Log in, complete your profile, and finish face verification to unlock all features.
4. Go to the 'Human Hash' section, submit the referral code, and once completed, your code will become active.
You can use the code: 1901200219

📹 Demo: https://drive.google.com/file/d/1mtGeCHLehfvzMldE9_qgFF5nkdVduyHR/view?usp=drive_link
```

---

## 🆔 KYC

### Đã match curator nhưng chưa được KYC
**Keywords:** "đã match curator", "matched but not KYC", "curator selected nhưng chưa verify".
→ `The system will send you a notification once a curator selects your ID account, and you'll have 24 hours to prepare your application. Please don't worry.`

### Got verification email nhưng app vẫn ở queue / waiting
**Keywords (EN):** "got mail but still in queue", "got mail but in app still in the queue", "received verification email but still queue/waiting", "verification email but in app still waiting", "email says upload documents but app still waiting", "email ready to upload verification documents but app no screen", "verification email but no screen in app".
**Keywords (VI):** "nhận email xác minh nhưng app vẫn chờ", "email bảo tải lên tài liệu xác minh nhưng app chưa thấy", "email rồi nhưng app vẫn pending/queue", "đã có email xác minh nhưng vào app không thấy màn hình", "quá trình xác minh đã sẵn sàng nhưng app vẫn chờ".
**Image trigger:** screenshot email tiêu đề/nội dung "Verification is available for your account" / "Your verification turn is here" / "Match Curator" / InterLink verification notification email.
→ `That's just a notification email. Please monitor the KYC section in the Interlink app regularly for the official request to submit your documents. Be sure not to miss the 24-hour submission deadline`

---

## 💼 Wallet

### Cách tạo ví
**Keywords:** "create wallet", "tạo ví", "make wallet".
→ ```
Please perform the steps shown in the video on your own account

📹 Demo: https://drive.google.com/file/d/1mDRsk1EPbjKRsA51C9ztL4BjMjgRrJ8H/view?usp=drive_link
```

### Cách check seedphrase
**Keywords:** "check seedphrase", "xem seedphrase", "private key".
→ ```
Please follow the tutorial video.

📹 Demo: https://drive.google.com/file/d/1rGQzCfGiOdjpv2EzieenhBbJJsN_V-Nc/view?usp=drive_link
```

### Cách connect social
**Keywords:** "connect social", "kết nối X/Twitter/Discord".
→ ```
Please follow the tutorial video.

📹 Demo: https://drive.google.com/file/d/1nuv6_-dif_J6mApJw6HRIcTHXQlhX5U4/view?usp=drive_link
```

### Cách apply visa card
**Keywords:** "visa card", "apply visa", "đăng ký thẻ visa".
→ ```
Please follow the tutorial video.

📹 Demo: https://drive.google.com/file/d/1Z4yAW3UvVD2IzwSn6jU_nXaiEamSDQ-V/view?usp=drive_link
```

### Cách check địa chỉ ví
**Keywords:** "wallet address", "địa chỉ ví", "find wallet address".
→ ```
Please follow the tutorial video.

📹 Demo: https://drive.google.com/file/d/1QfPIeHRYwgbrgB9KS0_io5evaiD3_M7M/view?usp=drive_link
```

### Swap A→B mà không thấy B trong ví
**Keywords:** "swap không thấy", "destination token", "swapped but missing".
→ `The destination token may not be in your default token list. Please check if you have enabled the destination token. If you don't know how, please send a screenshot and I'll guide you.`

### Reset ví / mất ví sau khi xóa app
**Keywords:** "reset wallet", "lost wallet", "uninstalled app", "out of wallet", "lấy lại ví".
→ ```
- NO if you did not back up your seedphrase or private key beforehand.
- YES if you have previously saved your seedphrase or private key.

Please always save your seedphrase / private key / iCloud backup so you can import your wallet again if you get logged out.
```

---

## 👥 Group Mining

### Tạo group
**Keywords:** "create group", "tạo group", "group mining", "mining group".
→ ```
You must complete verification before creating or joining a group.
For a member to be eligible to claim group rewards: The group must have at least 3 members. At least 2 members in the group must be active (e.g., 2/3, 2/4, 2/5).
Among those active members, you yourself must also be active. "Active" means mining at least once per day within the total of 6 mining sessions, and it only counts after you have joined the group (for example, if you mined once before joining the group, it does not count). You can join the group to exchange with other users. https://t.me/interlinkIDchat

📹 Demo: https://drive.google.com/file/d/1XuRxGWpMdc4IEL0goaJtjSmm8iqJQWmC/view?usp=drive_link
```

---

## 📲 OTP & Referral

### Referral code (nhập / lấy)
**Keywords:** "referral code", "mã mời", "ref code", "nhập code".
→ ```
Go to the 'Human Hash' section, submit the referral code, and once completed, your code will become active.
You can use the code: 1901200219

📹 Demo: https://drive.google.com/file/d/1QfDxCUnwXCrlVdoSVkHTXNUiy29N1-hA/view?usp=drive_link
```

### OTP qua email
**Keywords:** "OTP email", "không nhận OTP email", "verification code".
→ `Please check the messages in your spam folder and double-check your email address.`
(*Nếu user reply "not receive" → ESCALATE FP-12.*)

### OTP qua Telegram
**Keywords:** "OTP telegram", "telegram OTP bot".
→ `The Telegram OTP bot may be overloaded at the moment. Please try again in 15-30 minutes.`

---

## 🎮 Game

### G01 — Slime cloud (đám mây đen)
**Keywords:** "slime cloud", "đám mây đen", "game khó", "đám mây slime".
→ `This is not a bug — it's a game feature to increase difficulty.`

### G03 — Không nâng cấp được item
**Keywords:** "upgrade", "không nâng cấp", "MAX item".
→ ```
Items marked MAX cannot be upgraded further.
Tap once and wait — don't tap continuously, it will lag.
```

(*G02 score không cộng + G04 cheat tool → ESCALATE FP-12.*)

---

## 📄 Whitepaper / Project Info

### Câu hỏi CHUNG (general): "What is Interlink?", "tell me about project"
→ ```
You can read the InterLink whitepaper v2 & related documents here:
https://whitepaper.interlinklabs.ai
https://x.com/inter_link/status/1934870831609598430
```

### Câu hỏi CỤ THỂ (specific) về $ITL / $ITLG / tokenomics / mining mechanism / FAQ
**⚠️ Đọc `memory/whitepaper-data.md`** → tìm section khớp → copy nguyên văn. Kèm link:
- $ITL: `https://whitepaper.interlinklabs.ai/interlink-token-usditl`
- $ITLG: `https://whitepaper.interlinklabs.ai/interlink-genesis-token-usditlg`
- Tokenomics: `https://whitepaper.interlinklabs.ai/interlink-tokenomics/introducing`
- Mining: `https://whitepaper.interlinklabs.ai/token-mining-mechanism-and-sustainability`
- FAQ: `https://whitepaper.interlinklabs.ai/faq`

**⛔ KHÔNG dự đoán giá / ROI / lợi nhuận. KHÔNG dùng FAQ cho "when list" / "convert" / "withdraw" (đã FP-2/FP-3).**

---

## 🧮 HCS (Human Contribution Score)

### HCS không cộng ở App
**Keywords:** "HCS not added", "HCS không cộng", "HCS không tăng" (ở App).
→ ESCALATE FP-12. PIC: Quang.

### HCS không cộng ở Ví
**Keywords:** "HCS wallet", "HCS ví".
→ ```
Have you linked this wallet to your Interlink ID?
If yes, the AI needs some time to calculate your HCS score — please wait.
```

### Hỏi công thức HCS
**Keywords:** "HCS formula", "công thức HCS", "cách tính HCS".
**⛔ KHÔNG public công thức.**
→ `Stay active in the app — Mining, Group Mining, Games — and in the wallet — Trade, Swap. The AI calculates HCS based on each user's activity level, keeping it fair for both new and existing users.`

### HCS thấp dù ITLG nhiều
**Keywords:** "HCS thấp", "HCS low", "nhiều ITLG nhưng HCS thấp".
→ ```
HCS is a recently introduced feature, so it's fair for both new and existing users.
Active old users will still be prioritized later if they maintain their activity.
Interlink will ensure the fairest treatment for all users.
```

### Liên kết nhiều ví với 1 ID có cộng HCS không?
**Keywords:** "nhiều ví", "multiple wallets", "link multiple wallet HCS".
→ ```
Yes — linking multiple wallets to the same Interlink ID will accumulate HCS for that ID.
Whichever ID a wallet is linked to, that ID receives the HCS.
Requirement: the wallet must be active (Trade, Swap).
```

---

## ⛔ KHÔNG khớp case nào → ESCALATE

→ Chạy bước 5 (KB admin: `skills/interlink-knowledge/kb/INDEX.md`). KB miss → **HANDOFF theo AGENTS.md FP-12**.
