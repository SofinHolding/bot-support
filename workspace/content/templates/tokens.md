---
id: itlg-to-itl-conversion
group: Tokens
response_mode: EXACT_TEMPLATE
priority: 500
source: SKILL.md L53
match:
  keywords:
    - chuyển ITLG sang ITL
    - ITLG to ITL
  examples:
    - chuyển ITLG sang ITL
    - convert ITLG to ITL
    - ITLG to ITL
sets_context:
  issue: ITLG → ITL conversion
  status: pending
---
<!-- answer:en -->
ITLG hasn't entered the verification phase yet. Please stay tuned for updates
<!-- next -->
---
id: itlg-recover-after-burn
group: Tokens
response_mode: EXACT_TEMPLATE
priority: 499
source: SKILL.md L57
match:
  keywords:
    - recover ITLG
    - lấy lại ITLG
    - khôi phục ITLG
  examples:
    - recover ITLG
    - lấy lại ITLG
    - khôi phục ITLG
sets_context:
  issue: Cách recover ITLG
  status: pending
---
<!-- answer:en -->
If your ITLG was burned due to inactivity, it will be restored once you complete the full mining streak.

If the burn was caused by your downline being inactive, they need to become active again and complete the mining streak to fully restore the burned ITLG. Once that happens, the ITLG burned from your downline will also be credited back to you.

📹 Demo: https://drive.google.com/file/d/15AwUgjMbGSDcomzePlRIZ08-d5uC3ZYo/view?usp=drive_link
<!-- next -->
---
id: itlg-mining-reduced-50
group: Tokens
response_mode: EXACT_TEMPLATE
priority: 498
source: SKILL.md L67
match:
  keywords:
    - giảm 50%
    - ITLG ít
    - mine ít
    - DAO
    - vote
  examples:
    - giảm 50%
    - ITLG ít
    - mine ít
sets_context:
  issue: Tại sao ITLG mine được ít hơn
  status: pending
---
<!-- answer:en -->
Through Interlink DAO, with 99% community approval via voting, we have reduced the number of ITLG tokens mined per session by 50%. With the main purpose of preventing ITLG inflation.
<!-- next -->
---
id: itlg-earn-more
group: Tokens
response_mode: EXACT_TEMPLATE
priority: 497
source: SKILL.md L71
match:
  keywords:
    - earn more ITLG
    - kiếm thêm ITLG
    - tăng ITLG
    - how to earn
  examples:
    - earn more ITLG
    - kiếm thêm ITLG
    - tăng ITLG
    - how to earn
sets_context:
  issue: Cách kiếm thêm ITLG
  status: pending
---
<!-- answer:en -->
1. You only need to claim ITLG once every 4 hours.
2. Invite your friends using your referral code —> for each person you invite, you'll earn 500 ITLG and boost your mining speed by 0.2x.
3. Join the in-app game and reach Tier 6 or higher to receive weekly and monthly rewards.
4. On top of that, you can earn even more ITLG by playing games and participating in events on Telegram and Discord.
5. Join a mining group to receive additional ITLG daily.
<!-- next -->
---
id: itlg-burn-despite-mining
group: Tokens
response_mode: EXACT_TEMPLATE
priority: 496
source: SKILL.md L81
match:
  keywords:
    - I mine every day but still got burned
    - mine đều mà vẫn bị burn
    - ngày nào cũng mine mà bị trừ
  examples:
    - I mine every day but still got burned
    - mine đều mà vẫn bị burn
    - ngày nào cũng mine mà bị trừ
sets_context:
  issue: Mine đều nhưng vẫn bị burn
  status: pending
---
<!-- answer:en -->
If you mine daily but still get burned, it's likely your referral got burned to 0, so you'll be deducted:
+ 1000 ITLG for F1
+ 500 ITLG for F2

If you've already been deducted once, and the same referral gets burned to 0 again later, you will NOT be deducted again.
<!-- next -->
---
id: weekly-reward-schedule
group: Tokens
response_mode: EXACT_TEMPLATE
priority: 495
source: SKILL.md L91
match:
  keywords:
    - weekly reward
    - monthly reward
    - chưa nhận thưởng tuần/tháng
  examples:
    - weekly reward
    - monthly reward
    - chưa nhận thưởng tuần/tháng
follow_up:
  negative: ESCALATE
sets_context:
  issue: Chưa nhận Weekly Reward
  status: pending
ticket:
  error_code: M03
  pic: Minh
  category: mining
---
<!-- answer:en -->
Weekly game reward is paid at 3AM UTC+0 on Sunday.
Monthly reward is paid on the first day of the month at 3AM UTC+0.

If you still haven't received your reward past this time, please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance.
