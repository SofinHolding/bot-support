const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/admin/.openclaw/agents/main/sessions';
const start = Date.parse('2026-07-27T17:00:00.000Z');
const end = Date.parse('2026-07-28T17:00:00.000Z');
const l1 = "I'm sorry, I don't have enough information to answer this question.";
const l2 = 'Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance.';
let count = 0;
function textOf(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(textOf).join('');
  if (typeof x === 'object') {
    if (typeof x.text === 'string') return x.text;
    if (typeof x.content === 'string') return x.content;
    if (Array.isArray(x.content)) return textOf(x.content);
    if (Array.isArray(x.parts)) return textOf(x.parts);
  }
  return '';
}
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.jsonl') || f.includes('.checkpoint')) continue;
  const p = path.join(dir, f);
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const role = o.role || o.message?.role || o.author?.role || o.type;
    if (role !== 'assistant') continue;
    const ts = o.timestamp || o.createdAt || o.time || o.message?.timestamp || o.message?.createdAt;
    const ms = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
    if (!(ms >= start && ms < end)) continue;
    const txt = textOf(o.content) || textOf(o.message?.content) || textOf(o.text) || textOf(o.response);
    if (txt.includes(l1) && txt.includes(l2)) count++;
  }
}
console.log(count > 100 ? `🚨 Escalation alert (today): ${count} messages sent to @interlink_technicalsupport.` : 'NO_REPLY');
