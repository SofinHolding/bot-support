const fs = require('fs');
const path = require('path');

const base = 'C:\\Users\\admin\\.openclaw\\workspace';
const conv = path.join(base, 'memory', 'conversations', '2026-07.md');
const mem = path.join(base, 'MEMORY.md');
const whitepaper = path.join(base, 'memory', 'whitepaper-data.md');
const now = new Date('2026-07-13T05:05:00+07:00');

const text = fs.existsSync(conv) ? fs.readFileSync(conv, 'utf8') : '';
const blocks = text.split(/\n---\n/g).filter(b => /### \[/.test(b));
const rows = [];
for (const b of blocks) {
  const cat = (b.match(/- \*\*Phân loại\*\*: (.*)/) || [,'Unknown'])[1].trim();
  const resolved = (b.match(/- \*\*Đã giải quyết\*\*: (.*)/) || [,''])[1].trim();
  const note = (b.match(/- \*\*Ghi chú\*\*: (.*)/) || [,''])[1].trim();
  rows.push({ category: cat, resolved, note });
}

const total = rows.length;
const counts = {};
for (const r of rows) counts[r.category] = (counts[r.category] || 0) + 1;
const top = Object.entries(counts)
  .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
  .slice(0, 3)
  .map(x => x[0]);
const newQ = rows.filter(r => r.note.includes('⚠️')).length;
const unresolved = rows.filter(r => /[⏳❌]/.test(r.resolved)).length;
const action = newQ >= 3
  ? 'Action note: New unsupported questions increased this week; notify admin Anh Phi to review/update `interlink-support` skill.'
  : 'Action note: No major unsupported question trend detected this week (' + newQ + ' new question logged' + (newQ === 1 ? '' : 's') + ').';

const section = [
  '',
  '## Weekly heartbeat stats (2026-07-13, Monday)',
  '- Total conversations last week: **' + total + '**',
  '- Top 3 most common issues:',
  ...(top.length ? top.map((name, i) => '  ' + (i + 1) + '. ' + name) : ['  1. None']),
  '- Count of ⚠️ new questions not in skill: **' + newQ + '**',
  '- Count of ❌/⏳ unresolved cases: **' + unresolved + '** (⏳/❌ combined)',
  '- ' + action,
  ''
].join('\n');

let memText = fs.readFileSync(mem, 'utf8');
if (!memText.includes('## Weekly heartbeat stats (2026-07-13, Monday)')) {
  fs.writeFileSync(mem, memText.replace(/\s*$/, '') + section + '\n');
}

const antispamDir = path.join(base, 'memory', 'antispam');
const contextsDir = path.join(base, 'memory', 'contexts');
const cutoffAnti = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
const cutoffCtx = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
let antiDeleted = 0;
let ctxDeleted = 0;

if (fs.existsSync(antispamDir)) {
  for (const f of fs.readdirSync(antispamDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(antispamDir, f);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const last = j.last_seen ? new Date(j.last_seen) : new Date(fs.statSync(p).mtimeMs);
      if (last < cutoffAnti) {
        fs.unlinkSync(p);
        antiDeleted++;
      }
    } catch {}
  }
}

if (fs.existsSync(contextsDir)) {
  for (const f of fs.readdirSync(contextsDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(contextsDir, f);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const keys = Object.keys(j || {}).filter(k => j[k] !== null && j[k] !== undefined && j[k] !== '');
      const languageOnly = (keys.length === 1 && keys[0] === 'language') || j.status === 'language_preference_only';
      const updated = j.updated_at ? new Date(j.updated_at) : new Date(fs.statSync(p).mtimeMs);
      if (!languageOnly && updated < cutoffCtx) {
        fs.unlinkSync(p);
        ctxDeleted++;
      }
    } catch {}
  }
}

const wp = fs.existsSync(whitepaper) ? fs.readFileSync(whitepaper, 'utf8') : '';
const fresh = /Last synced:\s*(2026-07-13|2026-07-12)/.test(wp);
console.log(JSON.stringify({ total, top, newQ, unresolved, antiDeleted, ctxDeleted, whitepaperFresh: fresh }));
