---
id: fp-1-greeting
group: Greeting
response_mode: EXACT_TEMPLATE
priority: 900
source: AGENTS.md#FP-1
match:
  exact:
    - hi
    - hello
    - hey
    - start
    - /start
    - chào
sets_context:
  status: none
---
<!-- answer:en -->
May I help you
<!-- next -->
---
id: fp-2-withdraw
group: Withdraw
response_mode: EXACT_TEMPLATE
priority: 890
source: AGENTS.md#FP-2
match:
  keywords:
    - withdraw
    - rút tiền
    - cash out
    - how to withdraw
    - khi nào rút
  examples:
    - rút tiền
    - cash out
    - how to withdraw
    - khi nào rút
sets_context:
  issue: withdraw availability
  status: pending
---
<!-- answer:en -->
you can not withdraw now, it will be withdrawn in the future when ITLG token is listed on exchanges and it will be a big surprise
<!-- next -->
---
id: fp-3-listing-tge
group: Listing
response_mode: EXACT_TEMPLATE
priority: 880
source: AGENTS.md#FP-3
match:
  keywords:
    - when list
    - when tge
    - khi nào list
    - khi nào lên sàn
    - convert ITLG
    - convert to ITL
    - exchange list
  examples:
    - when list
    - when tge
    - khi nào list
    - khi nào lên sàn
    - convert ITLG
    - convert to ITL
    - exchange list
sets_context:
  issue: listing / TGE / convert question
  status: pending
---
<!-- answer:en -->
Follow our project on social media to stay updated
https://x.com/inter_link
<!-- next -->
---
id: fp-4-itlg-burn
group: Burn
response_mode: EXACT_TEMPLATE
priority: 870
source: AGENTS.md#FP-4
match:
  keywords:
    - why ITLG reduce
    - ITLG bị giảm
    - ITLG bị burn
    - ITLG bị trừ
    - total reduce
    - mất ITLG
    - ITLG decreased
    - why burned
    - tại sao burn
  examples:
    - why ITLG reduce
    - ITLG bị giảm
    - ITLG bị burn
    - ITLG bị trừ
    - total reduce
    - mất ITLG
    - ITLG decreased
    - why burned
follow_up:
  negative: ESCALATE
sets_context:
  issue: ITLG reduced / burn question
  status: pending
ticket:
  error_code: M02
  pic: Quang
  category: mining
---
<!-- answer:en -->
The token burn mechanism is now active, please stay tuned
If your direct and indirect referrals remain inactive and their total ITLG becomes 0, the referral rewards you previously received from them will be deducted.
🌅 Burn image: https://drive.google.com/file/d/1CTwDOk3b1LT6AgPqTRoJ5w_rsCMfofSA/view?usp=drive_link
🎥 Check Burn video: https://drive.google.com/file/d/1TKiyC21cPZpmkGkTVzW5sn3RbLSIIACT/view?usp=drive_link
<!-- next -->
---
id: fp-5-how-to-kyc
group: KYC
response_mode: EXACT_TEMPLATE
priority: 860
source: AGENTS.md#FP-5
match:
  keywords:
    - how to KYC
    - cách KYC
    - làm sao KYC
    - verify mặt
  examples:
    - how to KYC
    - cách KYC
    - làm sao KYC
    - verify mặt
sets_context:
  issue: how to do KYC
  status: pending
---
<!-- answer:en -->
Register with the curator you want, then wait to be matched with them and submit your application.
📹 Demo: https://drive.google.com/file/d/16fGmqtwrvRC-UTeRoClI0CeLYAPe6Y3U/view?usp=drive_link
<!-- next -->
---
id: fp-5b-kyc-email-queue
group: KYC
response_mode: EXACT_TEMPLATE
priority: 990
source: AGENTS.md#FP-5b
match:
  examples:
    - I got the verification email but the app is still in the queue
    - got mail but in app still waiting
    - nhận email xác minh nhưng app vẫn chờ
    - quá trình xác minh đã sẵn sàng nhưng app vẫn pending
    - email says upload verification documents but app shows nothing
  image_types:
    - kyc_email
    - kyc_queue_screen
  rules:
    - all:
        - mentions_kyc_email_received
        - still_waiting
  overrides_context: true
follow_up:
  more_images: fp-5b-kyc-email-queue
  negative: ESCALATE
  thanks: you-are-welcome
sets_context:
  issue: kyc notification email pending
  status: pending
---
<!-- answer:en -->
That's just a notification email. Please monitor the KYC section in the Interlink app regularly for the official request to submit your documents. Be sure not to miss the 24-hour submission deadline
<!-- next -->
---
id: fp-6-kyc-slow
group: KYC
response_mode: EXACT_TEMPLATE
priority: 840
source: AGENTS.md#FP-6
match:
  keywords:
    - KYC chậm
    - KYC slow
    - curator chưa chọn
    - not selected
    - waiting curator
    - vẫn chưa KYC
  examples:
    - KYC chậm
    - KYC slow
    - curator chưa chọn
    - not selected
    - waiting curator
    - vẫn chưa KYC
  excludes:
    - mentions_kyc_email_received
    - completed_level_1
    - wants_speed_up
    - mentions_duration_with_kyc
sets_context:
  issue: KYC verification delayed while waiting in curator queue
  status: pending
---
<!-- answer:en -->
Users will be verified one by one, and your turn will come soon.
<!-- next -->
---
id: fp-6b-kyc-review-long
group: KYC
response_mode: EXACT_TEMPLATE
priority: 830
source: AGENTS.md#FP-6b
match:
  keywords:
    - completed level 1
    - finished level 1
    - done step 1
    - passed stage 1
    - level 1 done
    - first KYC done
    - hoàn thành level 1
    - hoàn tất KYC lần đầu
    - hoàn tất thủ tục KYC lần đầu
    - xong bước 1
    - qua level 1
    - waiting for next step
    - next stage
    - level 2
    - stage 2
    - bước tiếp theo
    - chưa nhận được bước tiếp theo
    - chưa hoàn tất lần thứ hai
    - KYC pending
    - still KYC pending
    - still pending KYC
    - KYC review takes long
    - KYC review taking long
    - KYC too long
    - hồ sơ KYC đang xem xét
    - KYC lâu quá
    - quá trình KYC lâu
    - tại sao KYC lâu
    - speed up KYC
    - speed up verification
    - faster KYC
    - expedite KYC
    - push KYC faster
    - đẩy nhanh KYC
    - đẩy nhanh xác minh
    - KYC nhanh hơn
    - muốn nhanh KYC
  examples:
    - my KYC review is taking too long
    - I finished level 1 what is next
    - how can I speed up my verification
    - KYC đang xem xét 20 ngày rồi
  rules:
    - all:
        - mentions_kyc
        - mentions_duration
sets_context:
  issue: KYC review taking long
  status: pending
---
<!-- answer:en -->
Please try to improve your mining rate, HCS score,..v..v., and follow the steps shown in the video. Doing so will help the system recognize your positive activity within the InterLink app and may help speed up your identity verification (KYC) process
https://drive.google.com/file/d/1LMNTp7keWoM7HBVdmmGSj2cWnGHYyV8Y/view?usp=drive_link
<!-- next -->
---
id: fp-7-change-email
group: Account
response_mode: EXACT_TEMPLATE
priority: 820
source: AGENTS.md#FP-7
match:
  keywords:
    - change email
    - đổi email
    - update email
  examples:
    - change email
    - đổi email
    - update email
follow_up:
  no_old_email: email-old-email-required
sets_context:
  issue: Change email address
  status: pending
---
<!-- answer:en -->
Please go to the "Account" section and change your email address.
<!-- next -->
---
id: fp-8-forgot-id
group: Account
response_mode: EXACT_TEMPLATE
priority: 810
source: AGENTS.md#FP-8
match:
  keywords:
    - forgot ID
    - quên ID
    - lost ID
    - forgot login
    - quên login
  examples:
    - forgot ID
    - quên ID
    - lost ID
    - forgot login
    - quên login
  excludes:
    - any:
        - login id
        - quên login id
sets_context:
  issue: forgot ID
  status: pending
---
<!-- answer:en -->
Please tap on "Forgot ID" and follow the system's instructions.
📹 Demo: https://drive.google.com/file/d/1ytm-A7-cTNyREGluEBB3h8gPoaQ1CS65/view?usp=drive_link
<!-- next -->
---
id: fp-9-delete-account
group: Account
response_mode: EXACT_TEMPLATE
priority: 800
source: AGENTS.md#FP-9
match:
  keywords:
    - delete account
    - xoá account
    - xóa tài khoản
    - close account
  examples:
    - delete account
    - xoá account
    - xóa tài khoản
    - close account
sets_context:
  issue: delete account
  status: pending
---
<!-- answer:en -->
We currently don't support account deletion. Thank you for your understanding.
<!-- next -->
---
id: fp-10-change-id
group: Account
response_mode: EXACT_TEMPLATE
priority: 790
source: AGENTS.md#FP-10
match:
  keywords:
    - change ID
    - đổi ID
    - update ID
  examples:
    - change ID
    - đổi ID
    - update ID
sets_context:
  issue: change ID
  status: pending
---
<!-- answer:en -->
Currently, we do not support changing your ID. Thank you for your understanding.
<!-- next -->
---
id: fp-11-ambassador
group: Ambassador
response_mode: EXACT_TEMPLATE
priority: 780
source: AGENTS.md#FP-11
match:
  keywords:
    - ambassador
    - đại sứ
    - i want ambassador
    - how to become ambassador
  examples:
    - đại sứ
    - i want ambassador
    - how to become ambassador
sets_context:
  issue: ambassador program
  status: pending
---
<!-- answer:en -->
Here is some information for those who want to become an ambassador and join the InterLink community.

Please Follow our Process:
https://t.me/Interlink_Coach_House_Onboarding/150662

Check process for trainee here:
https://docs.google.com/document/d/1lgdGwKKtwrye4F5ALVw2WeKn2_kRpwHDCKRCbMhxPYU/edit?tab=t.0#heading=h.n6jortdbkmod

🔷 Ambassador Concerns
If you have any questions or issues related to the Ambassador Program, kindly DM our Ambassador Moderators, Coaches' PAs, or contact directly:
👤 @ekwinbudi
<!-- next -->
---
id: fp-11b-campaign-10m-nft
group: Campaign
response_mode: EXACT_TEMPLATE
priority: 770
source: AGENTS.md#FP-11b
match:
  keywords:
    - do you not own this nft
  examples:
    - I completed the 10M campaign but did not receive my NFT
    - chưa nhận được NFT campaign 10M
    - it says do you not own this NFT
  rules:
    - all:
        - mentions_campaign_10m
        - nft_not_received
sets_context:
  issue: Campaign 10M NFT not received
  status: pending
---
<!-- answer:en -->
The NFT token rewards for users who joined the 10M Campaign are still being distributed. Since the payout is still in progress, you may not have received yours yet. Your turn should come soon, so no worries
<!-- next -->
---
id: fp-12-escalate
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 0
source: AGENTS.md#FP-12
sets_context:
  issue: escalated to support
  status: none
---
<!-- answer:en -->
I'm sorry, I don't have enough information to answer this question.

Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance. Your reference code: {REF}
<!-- next -->
---
id: esc-wallet-create
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 760
source: AGENTS.md#FP-12
match:
  keywords:
    - creating wallet failed
    - wallet creation error
    - tạo ví lỗi
    - wallet error
    - failed to create wallet
    - lỗi tạo ví
  examples:
    - creating wallet failed
    - wallet creation error
    - tạo ví lỗi
    - wallet error
    - failed to create wallet
    - lỗi tạo ví
answer_from: fp-12-escalate
sets_context:
  issue: wallet issue (escalated)
  status: none
ticket:
  category: wallet
required_info:
  - Interlink ID
  - screenshot lỗi
  - thời điểm lỗi
---

<!-- next -->
---
id: esc-token-missing
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 759
source: AGENTS.md#FP-12
match:
  keywords:
    - faucet not added
    - faucet chưa cộng
    - token chưa về
    - token not received
    - missing token
    - ITL chưa về
    - ITLG chưa về
  examples:
    - faucet not added
    - faucet chưa cộng
    - token chưa về
    - token not received
    - missing token
    - ITL chưa về
    - ITLG chưa về
answer_from: fp-12-escalate
sets_context:
  issue: token issue (escalated)
  status: none
ticket:
  category: token
required_info:
  - Interlink ID
  - screenshot
  - thời điểm
---

<!-- next -->
---
id: esc-swap
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 758
source: AGENTS.md#FP-12
match:
  keywords:
    - swap fail
    - swap error
    - swap không được
    - swap stuck
  examples:
    - swap fail
    - swap error
    - swap không được
    - swap stuck
answer_from: fp-12-escalate
sets_context:
  issue: wallet issue (escalated)
  status: none
ticket:
  error_code: SWAP
  pic: Quang
  category: wallet
required_info:
  - screenshot
  - wallet address
---

<!-- next -->
---
id: esc-mining-bug
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 757
source: AGENTS.md#FP-12
match:
  keywords:
    - mining bug
    - không cộng ITLG
    - HHP reset
  examples:
    - mining bug
    - không cộng ITLG
    - HHP reset
answer_from: fp-12-escalate
sets_context:
  issue: mining issue (escalated)
  status: none
ticket:
  error_code: M01
  pic: Quang
  category: mining
required_info:
  - Interlink ID
  - screenshot HHP/ITLG
  - thời gian bị lỗi
  - số lần xảy ra
---

<!-- next -->
---
id: esc-weekly-reward
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 756
source: AGENTS.md#FP-12
match:
  keywords:
    - weekly reward chưa nhận
  examples:
    - weekly reward chưa nhận
answer_from: fp-12-escalate
sets_context:
  issue: mining issue (escalated)
  status: none
ticket:
  error_code: M03
  pic: Minh
  category: mining
required_info:
  - Interlink ID
  - screenshot
  - thời gian
---

<!-- next -->
---
id: esc-login-fail
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 755
source: AGENTS.md#FP-12
match:
  keywords:
    - login fail
    - face verify fail
  examples:
    - login fail
    - face verify fail
answer_from: fp-12-escalate
sets_context:
  issue: login issue (escalated)
  status: none
ticket:
  error_code: S02
  pic: Quang
  category: login
required_info:
  - video scan mặt
  - lỗi hiển thị
---

<!-- next -->
---
id: esc-forgot-password
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 754
source: AGENTS.md#FP-12
match:
  keywords:
    - quên password
    - forgot password
    - password reset
  examples:
    - quên password
    - forgot password
    - password reset
answer_from: fp-12-escalate
sets_context:
  issue: login issue (escalated)
  status: none
ticket:
  error_code: S01
  pic: Quang
  category: login
required_info:
  - ảnh chân dung (chị Thuỷ test trước khi Quang reset)
---

<!-- next -->
---
id: esc-game-bug
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 753
source: AGENTS.md#FP-12
match:
  keywords:
    - score not added
    - điểm chưa cộng
    - submit fail
  examples:
    - score not added
    - điểm chưa cộng
    - submit fail
answer_from: fp-12-escalate
sets_context:
  issue: game issue (escalated)
  status: none
ticket:
  error_code: G02
  pic: Minh
  category: game
required_info:
  - video
  - thời gian
---

<!-- next -->
---
id: esc-hcs-app
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 752
source: AGENTS.md#FP-12
match:
  keywords:
    - HCS not added
    - HCS không cộng
    - HCS không tăng
  examples:
    - HCS not added
    - HCS không cộng
    - HCS không tăng
answer_from: fp-12-escalate
sets_context:
  issue: hcs issue (escalated)
  status: none
ticket:
  error_code: HCS
  pic: Quang
  category: hcs
required_info:
  - Interlink ID
  - screenshot
---

<!-- next -->
---
id: esc-app-error-image
group: Escalate
response_mode: EXACT_TEMPLATE
priority: 750
source: AGENTS.md#FP-12 (ảnh báo lỗi trong app)
match:
  image_types:
    - error_dialog
answer_from: fp-12-escalate
sets_context:
  issue: app error from screenshot
  status: none
ticket:
  category: app-error
required_info:
  - screenshot lỗi
  - thời điểm
  - bước đang thao tác
---

