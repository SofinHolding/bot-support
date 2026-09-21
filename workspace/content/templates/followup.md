---
id: email-old-email-required
group: FollowUp
response_mode: EXACT_TEMPLATE
priority: 0
source: SKILL.md L18
sets_context:
  issue: Sau template "đổi email"
  status: none
---
<!-- answer:en -->
You need a verification code from your old email in order to change to a new email. We currently don't support changing email addresses. You can still log in using face verification.
<!-- next -->
---
id: you-are-welcome
group: FollowUp
response_mode: EXACT_TEMPLATE
priority: 0
source: SKILL.md L45
sets_context:
  status: resolved
---
<!-- answer:en -->
You're welcome
