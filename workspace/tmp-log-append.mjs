import fs from 'node:fs';
const p = 'memory/conversations/2026-08.md';
const entry = `
### [19:48] @mudhakk888 — Wallet recovery with seed phrase

- **Vấn đề**: User had seed phrase but entered wrong passcode and wallet was reset; asked if recovery is still possible.
- **Phân loại**: Wallet
- **Ngôn ngữ**: EN
- **Đã giải quyết**: ✅ Có
- **Tóm tắt trao đổi**:
  - User: Asked whether wallet can be recovered after reset if they still have the seed phrase.
  - Bot: Explained that the wallet can be restored using the seed phrase, advised setting a new passcode carefully, and warned never to share the seed phrase.
  - User: Confirmed with "Ok".
- **Ghi chú**: Không có

---
`;
fs.appendFileSync(p, entry);
