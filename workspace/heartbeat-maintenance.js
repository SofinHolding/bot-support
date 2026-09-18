const fs=require('fs'),p=require('path');
const now=new Date('2026-09-14T03:35:00+07:00');
function walk(dir){try{return fs.readdirSync(dir).map(f=>p.join(dir,f)).filter(f=>f.endsWith('.json'))}catch{return[]}}
function parseDate(v){let d=v?new Date(v):null; return d&&isFinite(d)?d:null}
let ant=0, ctx=0;
for(const f of walk('memory/antispam')){let j={}; try{j=JSON.parse(fs.readFileSync(f,'utf8'))}catch{} let d=parseDate(j.last_seen); if(d && now-d>30*864e5){fs.unlinkSync(f); ant++;}}
for(const f of walk('memory/contexts')){let j={}; try{j=JSON.parse(fs.readFileSync(f,'utf8'))}catch{} let keys=Object.keys(j).filter(k=>!['_comment'].includes(k)); let languageOnly=keys.length===1&&keys[0]==='language'; let d=parseDate(j.updated_at); if(!languageOnly && j.status!=='language_preference_only' && d && now-d>7*864e5){fs.unlinkSync(f); ctx++;}}
let log=''; try{log=fs.readFileSync('memory/conversations/2026-09.md','utf8')}catch{}
const lines=log.split(/\r?\n/); let entries=[]; let current=null;
for(const line of lines){
  let m=line.match(/^- (\d{4}-\d{2}-\d{2}) .*?\|.*?issue: (.*?) \| category: (.*?) \| status: (.*?) \|/);
  if(m) entries.push({date:m[1],cat:m[3],status:m[4],newq:/⚠️|new question/i.test(line)});
  let h=line.match(/^### \[(.*?)\] .*?— (.*)/);
  if(h){current={date:'2026-09-14',cat:h[2].includes('Withdraw')?'FAQ / Withdraw':'Other',status:'resolved',newq:false}; entries.push(current);}
  if(current){let c=line.match(/\*\*Phân loại\*\*: (.*)/); if(c) current.cat=c[1]; let s=line.match(/\*\*Đã giải quyết\*\*: (.*)/); if(s) current.status=/✅|Có/i.test(s[1])?'resolved':'pending';}
}
const start=new Date('2026-09-07T00:00:00+07:00'), end=new Date('2026-09-14T00:00:00+07:00');
const last=entries.filter(e=>{let d=new Date(e.date+'T00:00:00+07:00'); return d>=start&&d<end});
const counts={}; for(const e of last){let k=(e.cat||'Other').split('/')[0].trim(); counts[k]=(counts[k]||0)+1}
const top=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3);
const unresolved=last.filter(e=>!/resolved|✅|có/i.test(e.status||'')).length;
const newq=last.filter(e=>e.newq).length;
let wp='unknown'; try{wp=fs.readFileSync('memory/whitepaper-data.md','utf8').match(/Last synced: (.*)/)?.[1]?.trim()||'unknown'}catch{}
const topText=top.length?top.map(([k,v])=>`${k} (${v})`).join(', '):'none logged for last week in current monthly log';
const mem=`\n## Weekly heartbeat stats (2026-09-14, Monday — 03:35)\n- Total conversations last week (2026-09-07..13): **${last.length}**\n- Top 3 most common issues: ${topText}\n- Count of ⚠️ new questions not in skill: **${newq}**\n- Count of ❌/⏳ unresolved cases: **${unresolved}** (⏳/❌ combined)\n- Action note: ${newq>3?'New unsupported questions increased this week; notify admin Anh Phi to review/update interlink-support skill.':'No new unsupported question trend detected from this week’s logged cases.'}\n- Cleanup note: Deleted **${ant}** stale antispam files and **${ctx}** stale context files during Monday cleanup.\n- Whitepaper sync note: memory/whitepaper-data.md last synced **${wp.replace(/\*\*/g,'')}**; ${/2026-09-14|2026-09-13/.test(wp)?'sync is healthy.':'sync may have failed and daily sync job should be checked.'}\n`;
fs.appendFileSync('MEMORY.md',mem);
console.log(JSON.stringify({lastWeek:last.length,top,newq,unresolved,ant,ctx,wp},null,2));
