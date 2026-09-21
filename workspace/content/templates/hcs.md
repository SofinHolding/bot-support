---
id: hcs-wallet-not-added
group: HCS
response_mode: EXACT_TEMPLATE
priority: 474
source: SKILL.md L295
match:
  keywords:
    - HCS wallet
    - HCS ví
  examples:
    - HCS wallet
    - HCS ví
sets_context:
  issue: HCS không cộng ở Ví
  status: pending
---
<!-- answer:en -->
Have you linked this wallet to your Interlink ID?
If yes, the AI needs some time to calculate your HCS score — please wait.
<!-- next -->
---
id: hcs-formula
group: HCS
response_mode: EXACT_TEMPLATE
priority: 473
source: SKILL.md L303
match:
  keywords:
    - HCS formula
    - công thức HCS
    - cách tính HCS
  examples:
    - HCS formula
    - công thức HCS
    - cách tính HCS
sets_context:
  issue: Hỏi công thức HCS
  status: pending
---
<!-- answer:en -->
Stay active in the app — Mining, Group Mining, Games — and in the wallet — Trade, Swap. The AI calculates HCS based on each user's activity level, keeping it fair for both new and existing users.
<!-- next -->
---
id: hcs-low
group: HCS
response_mode: EXACT_TEMPLATE
priority: 472
source: SKILL.md L307
match:
  keywords:
    - HCS thấp
    - HCS low
    - nhiều ITLG nhưng HCS thấp
  examples:
    - HCS thấp
    - HCS low
    - nhiều ITLG nhưng HCS thấp
sets_context:
  issue: HCS thấp dù ITLG nhiều
  status: pending
---
<!-- answer:en -->
HCS is a recently introduced feature, so it's fair for both new and existing users.
Active old users will still be prioritized later if they maintain their activity.
Interlink will ensure the fairest treatment for all users.
<!-- next -->
---
id: hcs-multiple-wallets
group: HCS
response_mode: EXACT_TEMPLATE
priority: 471
source: SKILL.md L315
match:
  keywords:
    - nhiều ví
    - multiple wallets
    - link multiple wallet HCS
  examples:
    - nhiều ví
    - multiple wallets
    - link multiple wallet HCS
sets_context:
  issue: Liên kết nhiều ví với 1 ID có cộng HCS không?
  status: pending
---
<!-- answer:en -->
Yes — linking multiple wallets to the same Interlink ID will accumulate HCS for that ID.
Whichever ID a wallet is linked to, that ID receives the HCS.
Requirement: the wallet must be active (Trade, Swap).
