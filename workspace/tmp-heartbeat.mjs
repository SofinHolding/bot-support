import fs from 'fs';
import path from 'path';
const now = new Date('2026-09-14T00:35:00+07:00');
const safeRead = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const listJson = (dir) => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)); } catch { return []; } };
const parseDate = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
let antDel = 0, ctxDel = 0;
for (const p of listJson('memory/antispam')) {
  try { const j = JSON.parse(safeRead(p) || '{}'); const d = parseDate(j.last_seen); if (d && now - d > 30*24*3600*1000) { fs.unlinkSync(p); antDel++; } } catch {}
}
for (const p of listJson('memory/contexts')) {
  try {
    const j = JSON.parse(safeRead(p) || '{}');
    const keys = Object.keys(j).filter(k => j[k] !== undefined && j[k] !== null && j[k] !== '');
    const onlyLang = keys.length === 1 && keys[0] === 'language';
    const d = parseDate(j.updated_at);
    if (!onlyLang && j.status !== 'language_preference_only' && d && now - d > 7*24*3600*1000) { fs.unlinkSync(p); ctxDel++; }
  } catch {}
}
const log = safeRead('memory/conversations/2026-09.md');
const entries = log.split(/^---\s*$/m).map(s => s.trim()).filter(s => s.startsWith('###'));
const total = entries.length;
const cats = {}; let newq = 0, unresolved = 0;
for (const e of entries) {
  const cat = (e.match(/\*\*Phân loại\*\*:\s*([^\n]+)/) || [])[1]?.trim() || 'Other';
  cats[cat] = (cats[cat] || 0) + 1;
  if (e.includes('⚠️ CÂU HỎI MỚI')) newq++;
  if (/\*\*Đã giải quyết\*\*:\s*(⏳|❌)/.test(e)) unresolved++;
}
const top = Object.entries(cats).sort((a,b) => b[1] - a[1]).slice(0,3).map(([k,v],i) => `  ${i+1}. ${k} (${v})`).join('\n') || 'N/A';
const white = safeRead('memory/whitepaper-data.md');
const last = (white.match(/Last synced:\s*([^\n]+)/) || [])[1]?.trim() || 'unknown';
const block = `\n## Weekly heartbeat stats (2026-09-14, Monday — 00:35)\n- Total conversations last week/current monthly log: **${total}**\n- Top 3 most common issues:\n${top}\n- Count of ⚠️ new questions not in skill: **${newq}**\n- Count of ❌/⏳ unresolved cases: **${unresolved}** (⏳/❌ combined)\n- Action note: ${newq > 1 ? 'New unsupported questions logged; notify admin Anh Phi to review/update `interlink-support` skill.' : 'No major unsupported question trend detected from this week’s logged cases.'}\n- Escalation alert: **534** messages sent to @interlink_technicalsupport today (received 2026-09-14 00:01 UTC+7); admin Anh Phi should review support load/escalation volume.\n- Cleanup note: Deleted **${antDel}** stale antispam files and **${ctxDel}** stale context files during Monday cleanup.\n- Whitepaper sync note: memory/whitepaper-data.md last synced **${last}**; sync may have failed and daily sync job should be checked.\n`;
fs.appendFileSync('MEMORY.md', block);
console.log(JSON.stringify({ total, top, newq, unresolved, antDel, ctxDel, last }, null, 2));
