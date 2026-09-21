---
id: wallet-create
group: Wallet
response_mode: EXACT_TEMPLATE
priority: 488
source: SKILL.md L160
match:
  keywords:
    - create wallet
    - tạo ví
    - make wallet
  examples:
    - create wallet
    - tạo ví
    - make wallet
sets_context:
  issue: Cách tạo ví
  status: pending
---
<!-- answer:en -->
Please perform the steps shown in the video on your own account

📹 Demo: https://drive.google.com/file/d/1mDRsk1EPbjKRsA51C9ztL4BjMjgRrJ8H/view?usp=drive_link
<!-- next -->
---
id: wallet-check-seedphrase
group: Wallet
response_mode: EXACT_TEMPLATE
priority: 487
source: SKILL.md L168
match:
  keywords:
    - check seedphrase
    - xem seedphrase
    - private key
  examples:
    - check seedphrase
    - xem seedphrase
    - private key
sets_context:
  issue: Cách check seedphrase
  status: pending
---
<!-- answer:en -->
Please follow the tutorial video.

📹 Demo: https://drive.google.com/file/d/1rGQzCfGiOdjpv2EzieenhBbJJsN_V-Nc/view?usp=drive_link
<!-- next -->
---
id: wallet-connect-social
group: Wallet
response_mode: EXACT_TEMPLATE
priority: 486
source: SKILL.md L176
match:
  keywords:
    - connect social
    - kết nối X/Twitter/Discord
  examples:
    - connect social
    - kết nối X/Twitter/Discord
sets_context:
  issue: Cách connect social
  status: pending
---
<!-- answer:en -->
Please follow the tutorial video.

📹 Demo: https://drive.google.com/file/d/1nuv6_-dif_J6mApJw6HRIcTHXQlhX5U4/view?usp=drive_link
<!-- next -->
---
id: wallet-visa-card
group: Wallet
response_mode: EXACT_TEMPLATE
priority: 485
source: SKILL.md L184
match:
  keywords:
    - visa card
    - apply visa
    - đăng ký thẻ visa
  examples:
    - visa card
    - apply visa
    - đăng ký thẻ visa
sets_context:
  issue: Cách apply visa card
  status: pending
---
<!-- answer:en -->
Please follow the tutorial video.

📹 Demo: https://drive.google.com/file/d/1Z4yAW3UvVD2IzwSn6jU_nXaiEamSDQ-V/view?usp=drive_link
<!-- next -->
---
id: wallet-address
group: Wallet
response_mode: EXACT_TEMPLATE
priority: 484
source: SKILL.md L192
match:
  keywords:
    - wallet address
    - địa chỉ ví
    - find wallet address
  examples:
    - wallet address
    - địa chỉ ví
    - find wallet address
sets_context:
  issue: Cách check địa chỉ ví
  status: pending
---
<!-- answer:en -->
Please follow the tutorial video.

📹 Demo: https://drive.google.com/file/d/1QfPIeHRYwgbrgB9KS0_io5evaiD3_M7M/view?usp=drive_link
<!-- next -->
---
id: wallet-swap-token-missing
group: Wallet
response_mode: EXACT_TEMPLATE
priority: 483
source: SKILL.md L200
match:
  keywords:
    - swap không thấy
    - destination token
    - swapped but missing
  examples:
    - swap không thấy
    - destination token
    - swapped but missing
follow_up:
  info_provided: ESCALATE
sets_context:
  issue: Swap A→B mà không thấy B trong ví
  status: pending
ticket:
  error_code: SWAP
  pic: Quang
  category: wallet
---
<!-- answer:en -->
The destination token may not be in your default token list. Please check if you have enabled the destination token. If you don't know how, please send a screenshot and I'll guide you.
<!-- next -->
---
id: wallet-reset-lost
group: Wallet
response_mode: EXACT_TEMPLATE
priority: 482
source: SKILL.md L204
match:
  keywords:
    - reset wallet
    - lost wallet
    - uninstalled app
    - out of wallet
    - lấy lại ví
  examples:
    - reset wallet
    - lost wallet
    - uninstalled app
    - out of wallet
    - lấy lại ví
sets_context:
  issue: Reset ví / mất ví sau khi xóa app
  status: pending
---
<!-- answer:en -->
- NO if you did not back up your seedphrase or private key beforehand.
- YES if you have previously saved your seedphrase or private key.

Please always save your seedphrase / private key / iCloud backup so you can import your wallet again if you get logged out.
