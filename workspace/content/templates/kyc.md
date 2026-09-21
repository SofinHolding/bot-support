---
id: kyc-matched-not-verified
group: KYC
response_mode: EXACT_TEMPLATE
priority: 489
source: SKILL.md L146
match:
  keywords:
    - đã match curator
    - matched but not KYC
    - curator selected nhưng chưa verify
  examples:
    - đã match curator
    - matched but not KYC
    - curator selected nhưng chưa verify
sets_context:
  issue: Đã match curator nhưng chưa được KYC
  status: pending
---
<!-- answer:en -->
The system will send you a notification once a curator selects your ID account, and you'll have 24 hours to prepare your application. Please don't worry.
