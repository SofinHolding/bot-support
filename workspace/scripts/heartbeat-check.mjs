import fs from 'fs';
import path from 'path';
const cwd=process.cwd();
const now=new Date();
const ym='2026-09';
const conv=path.join(cwd,'memory','conversations',ym+'.md');
const mem=path.join(cwd,'MEMORY.md');
const wp=path.join(cwd,'memory','whitepaper-data.md');
function read(p){try{return fs.readFileSync(p,'utf8')}catch{return ''}}
const text=read(conv);
const start=new Date('2026-08-31T00:00:00+07:00');
const end=new Date('2026-09-07T00:00:00+07:00');
const lines=text.split(/\r?\n/);
const entries=[]; let cur=null;
for(const line of lines){const m=line.match(/^##\s+(\d{4}-\d{2}-\d{2})/); if(m){if(cur)entries.push(cur); cur={date:m[1],body:''};} else if(cur) cur.body+=line+'\n';}
if(cur)entries.push(cur);
const lastWeek=entries.filter(e=>{const d=new Date(e.date+'T00:00:00+07:00'); return d>=start&&d<end});
const issueCounts={}; let newQ=0, unresolved=0;
for(const e of lastWeek){const b=e.body; if(/⚠️/.test(b))newQ++; if(/[❌⏳]/.test(b)||/unresolved|pending|escalat/i.test(b))unresolved++; const m=b.match(/(?:Issue|Case|Topic|Vấn đề)\s*[:：-]\s*(.+)/i); let issue=m?m[1].trim().slice(0,80):null; if(!issue){if(/kyc/i.test(b))issue='KYC'; else if(/withdraw|rút/i.test(b))issue='Withdraw'; else if(/burn|reduce|giảm/i.test(b))issue='ITLG burn/reduce'; else if(/wallet/i.test(b))issue='Wallet'; else if(/login|password|otp/i.test(b))issue='Login/Auth'; else issue='Other';} issueCounts[issue]=(issueCounts[issue]||0)+1;}
const top=Object.entries(issueCounts).sort((a,b)=>b[1]-a[1]).slice(0,3);
const summary=['## Weekly Conversation Stats — 2026-08-31 to 2026-09-06','- Total conversations last week: '+lastWeek.length,'- Top 3 issues: '+(top.length?top.map(([k,v])=>`${k} (${v})`).join(', '):'None'),'- ⚠️ New questions not in skill: '+newQ,'- ❌/⏳ unresolved cases: '+unresolved,''].join('\n');
let memory=read(mem); const marker='## Weekly Conversation Stats — 2026-08-31 to 2026-09-06';
if(memory.includes(marker)) memory=memory.replace(new RegExp(marker+'[\\s\\S]*?(?=\\n## |$)'), summary.trim()); else memory=(memory.trim()?memory.trim()+'\n\n':'')+summary.trim()+'\n';
fs.writeFileSync(mem,memory);
const deleted=[];
function cleanup(dir,kind){const full=path.join(cwd,'memory',dir); if(!fs.existsSync(full))return; for(const f of fs.readdirSync(full)){if(!f.endsWith('.json'))continue; const p=path.join(full,f); let obj={}; try{obj=JSON.parse(fs.readFileSync(p,'utf8'))}catch{} if(kind==='antispam'){const d=obj.last_seen?new Date(obj.last_seen):null; if(d&&(now-d)>30*864e5){fs.unlinkSync(p); deleted.push(dir+'/'+f)}} else {const d=obj.updated_at?new Date(obj.updated_at):null; const langOnly=Object.keys(obj).every(k=>k==='language'); if(d&&(now-d)>7*864e5&&obj.status!=='language_preference_only'&&!langOnly){fs.unlinkSync(p); deleted.push(dir+'/'+f)}}}}
cleanup('antispam','antispam'); cleanup('contexts','contexts');
const wpText=read(wp); const lm=wpText.match(/Last synced\s*[:：-]\s*([^\n]+)/i);
console.log(JSON.stringify({summary,deletedCount:deleted.length,whitepaperLastSynced:lm?lm[1].trim():null,newQ,needsAdmin:newQ>5},null,2));
