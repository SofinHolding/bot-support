---
id: how-to-login
group: Account
response_mode: EXACT_TEMPLATE
priority: 494
source: SKILL.md L104
match:
  keywords:
    - how to login
    - cách login
    - đăng nhập
  examples:
    - how to login
    - cách login
    - đăng nhập
sets_context:
  issue: Cách login
  status: pending
---
<!-- answer:en -->
Just enter your ID and proceed to log in.
<!-- next -->
---
id: face-scan-black-screen
group: Account
response_mode: EXACT_TEMPLATE
priority: 493
source: SKILL.md L108
match:
  keywords:
    - scan face black
    - scan đen
    - camera không hoạt động
    - camera black screen
  examples:
    - scan face black
    - scan đen
    - camera không hoạt động
    - camera black screen
sets_context:
  issue: Scan face đen thui
  status: pending
ticket:
  error_code: S03
  category: login
---
<!-- answer:en -->
Please go to Settings and check if you have granted camera permission to the Interlink Network app.
<!-- next -->
---
id: forgot-login-id
group: Account
response_mode: EXACT_TEMPLATE
priority: 492
source: SKILL.md L112
match:
  keywords:
    - forgot login ID
  examples:
    - forgot login ID
  rules:
    - all:
        - mentions_forgot
        - mentions_login_id
follow_up:
  info_provided: ESCALATE
sets_context:
  issue: Quên Login ID
  status: pending
ticket:
  error_code: S04
  pic: Anh Đạt
  category: login
---
<!-- answer:en -->
Please tap "Forgot Login ID" and perform a face scan — this will recover your Login ID.

If that doesn't work, please record your screen during the face scan and send a portrait photo so our Dev can check.
<!-- next -->
---
id: twin-account
group: Account
response_mode: EXACT_TEMPLATE
priority: 491
source: SKILL.md L120
match:
  keywords:
    - twin
    - sinh đôi
    - anh em sinh đôi
    - cùng mặt
  examples:
    - sinh đôi
    - anh em sinh đôi
    - cùng mặt
sets_context:
  issue: Sinh đôi
  status: pending
ticket:
  error_code: O03
  category: account
---
<!-- answer:en -->
We're currently updating this feature. Thank you for your patience.
<!-- next -->
---
id: how-to-sign-up
group: Account
response_mode: EXACT_TEMPLATE
priority: 490
source: SKILL.md L124
match:
  keywords:
    - how to sign up
    - cách đăng ký
    - register
    - create account
  examples:
    - how to sign up
    - cách đăng ký
    - create account
sets_context:
  issue: Hướng dẫn đăng ký
  status: pending
---
<!-- answer:en -->
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
<!-- next -->
---
id: referral-code
group: Account
response_mode: EXACT_TEMPLATE
priority: 480
source: SKILL.md L231
match:
  keywords:
    - referral code
    - mã mời
    - ref code
    - nhập code
  examples:
    - referral code
    - mã mời
    - ref code
    - nhập code
sets_context:
  issue: Referral code
  status: pending
---
<!-- answer:en -->
Go to the 'Human Hash' section, submit the referral code, and once completed, your code will become active.
You can use the code: 1901200219

📹 Demo: https://drive.google.com/file/d/1QfDxCUnwXCrlVdoSVkHTXNUiy29N1-hA/view?usp=drive_link
<!-- next -->
---
id: otp-email
group: Account
response_mode: EXACT_TEMPLATE
priority: 479
source: SKILL.md L240
match:
  keywords:
    - OTP email
    - không nhận OTP email
    - verification code
  examples:
    - OTP email
    - không nhận OTP email
    - verification code
follow_up:
  not_receive: ESCALATE
  negative: ESCALATE
sets_context:
  issue: OTP qua email
  status: pending
---
<!-- answer:en -->
Please check the messages in your spam folder and double-check your email address.
<!-- next -->
---
id: otp-telegram
group: Account
response_mode: EXACT_TEMPLATE
priority: 478
source: SKILL.md L245
match:
  keywords:
    - OTP telegram
    - telegram OTP bot
  examples:
    - OTP telegram
    - telegram OTP bot
sets_context:
  issue: OTP qua Telegram
  status: pending
---
<!-- answer:en -->
The Telegram OTP bot may be overloaded at the moment. Please try again in 15-30 minutes.
