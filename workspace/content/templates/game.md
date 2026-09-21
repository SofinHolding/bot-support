---
id: game-slime-cloud
group: Game
response_mode: EXACT_TEMPLATE
priority: 477
source: SKILL.md L253
match:
  keywords:
    - slime cloud
    - đám mây đen
    - game khó
    - đám mây slime
  examples:
    - slime cloud
    - đám mây đen
    - game khó
    - đám mây slime
sets_context:
  issue: Slime cloud
  status: pending
ticket:
  error_code: G01
  category: game
---
<!-- answer:en -->
This is not a bug — it's a game feature to increase difficulty.
<!-- next -->
---
id: game-upgrade-max
group: Game
response_mode: EXACT_TEMPLATE
priority: 476
source: SKILL.md L257
match:
  keywords:
    - upgrade
    - không nâng cấp
    - MAX item
  examples:
    - không nâng cấp
    - MAX item
sets_context:
  issue: Không nâng cấp được item
  status: pending
ticket:
  error_code: G03
  category: game
---
<!-- answer:en -->
Items marked MAX cannot be upgraded further.
Tap once and wait — don't tap continuously, it will lag.
