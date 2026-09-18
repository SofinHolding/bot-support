import fs from 'fs';
import path from 'path';
const now = new Date('2026-09-14T02:35:00+07:00');
const safeRead = p => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };
const listJson = dir => { try { return fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>path.join(dir,f)); } catch { return []; } };
const parseDate = v => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
let antDel=0, ctxDel=0;
for (const p of listJson('memory/antispam')) { try { const j=JSON.parse(safeRead(p)||'{}'); const d=parseDate(j.last_seen); if (d && now-d > 30*24*3600*1000) { fs.unlinkSync(p); antDel++; } } catch {} }
for (const p of listJson('memory/contexts')) { try { const j=JSON.parse(safeRead(p)||'{}'); const keys=Object.keys(j).filter(k=>j[k]!==undefined&&j[k]!==null&&j[k]!=='' ); const onlyLang=keys.length===1&&keys[0]==='language'; const d=parseDate(j.updated_at); if (!onlyLang && j.status!=='language_preference_only' && d && now-d > 7*24*3600*1000) { fs.unlinkSync(p); ctxDel++; } } catch {} }
const log=safeRead('memory/conversations/2026-09.md');
let entries=log.split(/^---\s*$/m).map(s=>s.trim()).filter(s=>s.startsWith('###'));
if (!entries.length) entries=log.split(/\n(?=- \d{4}-\d{2}-\d{2})/).map(s=>s.trim()).filter(s=>s.startsWith('- '));
const cats={}; let newq=0, unresolved=0;
for (const e of entries) { const cat=(e.match(/\*\*Phân loại\*\*:\s*([^\n]+)/)||e.match(/category:\s*([^|\n]+)/)||[])[1]?.trim()||'Other'; cats[cat]=(cats[cat]||0)+1; if(e.includes('⚠️ CÂU HỎI MỚI')) newq++; if(/\*\*Đã giải quyết\*\*:\s*(⏳|❌)/.test(e)||/status:\s*(pending|unresolved|escalated)/i.test(e)) unresolved++; }
const total=entries.length;
const top=Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v],i)=>`  ${i+1}. ${k} (${v})`).join('\n')||'N/A';
const last=(safeRead('memory/whitepaper-data.md').match(/Last synced:\s*([^\n]+)/)||[])[1]?.trim()||'unknown';
const block=`\n## Weekly heartbeat stats (2026-09-14, Monday — 02:35)\n- Total conversations last week/current monthly log: **${total}**\n- Top 3 most common issues:\n${top}\n- Count of ⚠️ new questions not in skill: **${newq}**\n- Count of ❌/⏳ unresolved cases: **${unresolved}** (⏳/❌ combined)\n- Action note: ${newq>1?'New unsupported questions logged; notify admin Anh Phi to review/update `interlink-support` skill.':'No major unsupported question trend detected from this week’s logged cases.'}\n- Cleanup note: Deleted **${antDel}** stale antispam files and **${ctxDel}** stale context files during Monday cleanup.\n- Whitepaper sync note: memory/whitepaper-data.md last synced **${last}**; sync may have failed and daily sync job should be checked.\n`;
fs.appendFileSync('MEMORY.md', block);
console.log(JSON.stringify({total,top,newq,unresolved,antDel,ctxDel,last},null,2));
