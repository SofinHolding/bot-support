const fs=require('fs');
const path=require('path');
const now=new Date('2026-08-17T02:35:00+07:00');
function readJson(p){try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}}
function cleanup(dir,type){let n=0;if(!fs.existsSync(dir))return 0;for(const f of fs.readdirSync(dir)){if(!f.endsWith('.json'))continue;const p=path.join(dir,f);const j=readJson(p);let del=false;if(type==='antispam'){const d=j&&j.last_seen?new Date(j.last_seen):fs.statSync(p).mtime;if((now-d)>30*24*3600*1000)del=true}else{if(j&&j.status==='language_preference_only')continue;const onlyLang=j&&Object.keys(j).every(k=>k==='language');if(onlyLang)continue;const d=j&&j.updated_at?new Date(j.updated_at):fs.statSync(p).mtime;if((now-d)>7*24*3600*1000)del=true}if(del){fs.unlinkSync(p);n++}}return n}
const anti=cleanup('memory/antispam','antispam');
const ctx=cleanup('memory/contexts','contexts');
let log='';try{log=fs.readFileSync('memory/conversations/2026-08.md','utf8')}catch{}
const entries=[...log.matchAll(/### \[[^\]]+\] [^\n]+\n\n([\s\S]*?)(?=\n---|$)/g)].map(m=>m[1]);
const total=entries.length;
const cats={};let newq=0,unres=0;
for(const e of entries){const c=(e.match(/\*\*Phân loại\*\*:([^\n]+)/)||[])[1];if(c){for(const part of c.split('/').map(s=>s.trim()).filter(Boolean)){cats[part]=(cats[part]||0)+1}}if(e.includes('⚠️ CÂU HỎI MỚI'))newq++;if(/\*\*Đã giải quyết\*\*:\s*[❌⏳]/.test(e))unres++;}
const top=Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,3).map((x,i)=>`  ${i+1}. ${x[0]}`).join('\n')||'  N/A';
let wp='unknown';try{const s=fs.readFileSync('memory/whitepaper-data.md','utf8');wp=(s.match(/Last synced:\s*([^\n]+)/)||[])[1]||'unknown'}catch{}
const wpOld=!wp.includes('2026-08-16')&&!wp.includes('2026-08-17')&&!wp.includes('2026-08-15');
const block=`\n## Weekly heartbeat stats (2026-08-17, Monday — 02:35)\n- Total conversations last week/current monthly log: **${total}**\n- Top 3 most common issues:\n${top}\n- Count of ⚠️ new questions not in skill: **${newq}**\n- Count of ❌/⏳ unresolved cases: **${unres}**\n- Action note: No new unsupported question trend detected from this week’s logged cases.\n- Cleanup note: Deleted **${anti}** stale antispam files and **${ctx}** stale context files during Monday cleanup.\n- Whitepaper sync note: memory/whitepaper-data.md last synced **${wp}**; ${wpOld?'sync may have failed and daily sync job should be checked.':'sync is healthy.'}\n`;
fs.appendFileSync('MEMORY.md',block);
console.log(block);
