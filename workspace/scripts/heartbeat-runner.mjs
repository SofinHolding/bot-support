import fs from 'fs';
import path from 'path';

const base = 'C:/Users/admin/.openclaw/workspace';
const now = new Date('2026-06-01T03:05:00Z');
const tzNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
const yyyy = tzNow.getFullYear();
const mm = String(tzNow.getMonth() + 1).padStart(2, '0');

const convPath = path.join(base, 'memory', 'conversations', `${yyyy}-${mm}.md`);
let conv = '';
if (fs.existsSync(convPath)) conv = fs.readFileSync(convPath, 'utf8');

const sections = conv.split(/\n(?=##\s)/g);
let total = 0;
let unresolved = 0;
let newq = 0;
const issues = new Map();
for (const sec of sections) {
  if (!sec.trim().startsWith('## ')) continue;
  total++;
  const header = sec.split(/\r?\n/)[0].replace(/^##\s+/, '').trim();
  const key = header || 'Unknown';
  issues.set(key, (issues.get(key) || 0) + 1);
  if (/[❌⏳]/.test(sec)) unresolved++;
  if (/⚠️|\u26A0/.test(sec)) newq++;
}
const top = [...issues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

const memPath = path.join(base, 'MEMORY.md');
let mem = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf8') : '';
const stamp = '2026-06-01';
const block = [
  `## Weekly Conversation Stats (${stamp})`,
  `- Total conversations last week: ${total}`,
  `- Top 3 most common issues: ${top.length ? top.map(([k, v]) => `${k} (${v})`).join('; ') : 'N/A'}`,
  `- Count of ⚠️ new questions not in skill: ${newq}`,
  `- Count of ❌/⏳ unresolved cases: ${unresolved}`,
  ''
].join('\n');
if (mem.includes(`## Weekly Conversation Stats (${stamp})`)) {
  mem = mem.replace(new RegExp(`## Weekly Conversation Stats \\(${stamp}\\)[\\s\\S]*?(?=\\n## |$)`), block.trim());
} else {
  mem += (mem.endsWith('\n') ? '' : '\n') + '\n' + block;
}
fs.writeFileSync(memPath, mem, 'utf8');

const antiDir = path.join(base, 'memory', 'antispam');
const ctxDir = path.join(base, 'memory', 'contexts');
let antiDeleted = 0;
let ctxDeleted = 0;
const cutoffAnti = new Date(now);
cutoffAnti.setUTCDate(cutoffAnti.getUTCDate() - 30);
const cutoffCtx = new Date(now);
cutoffCtx.setUTCDate(cutoffCtx.getUTCDate() - 7);

if (fs.existsSync(antiDir)) {
  for (const f of fs.readdirSync(antiDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(antiDir, f);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.last_seen && new Date(j.last_seen) < cutoffAnti) {
        fs.unlinkSync(p);
        antiDeleted++;
      }
    } catch {}
  }
}

if (fs.existsSync(ctxDir)) {
  for (const f of fs.readdirSync(ctxDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(ctxDir, f);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const keys = Object.keys(j || {});
      const languageOnly =
        (keys.length === 1 && keys[0] === 'language') ||
        (keys.length === 2 && keys.includes('language') && keys.includes('status') && j.status === 'language_preference_only');
      const updated = j.updated_at ? new Date(j.updated_at) : new Date(fs.statSync(p).mtime);
      const stale = updated < cutoffCtx;
      if (stale && j.status !== 'language_preference_only' && !languageOnly) {
        fs.unlinkSync(p);
        ctxDeleted++;
      }
    } catch {}
  }
}

const wpPath = path.join(base, 'memory', 'whitepaper-data.md');
let wpStatus = 'missing';
let notifyAdmin = false;
if (fs.existsSync(wpPath)) {
  const w = fs.readFileSync(wpPath, 'utf8');
  const m = w.match(/Last synced\s*[:|-]\s*(\d{4}-\d{2}-\d{2})/i);
  if (m) {
    wpStatus = m[1];
    const d = new Date(`${m[1]}T00:00:00Z`);
    const ageDays = Math.floor((now - d) / 86400000);
    if (ageDays > 2) notifyAdmin = true;
  } else {
    notifyAdmin = true;
  }
} else {
  notifyAdmin = true;
}

console.log(JSON.stringify({ total, top, newq, unresolved, antiDeleted, ctxDeleted, wpStatus, notifyAdmin }));
