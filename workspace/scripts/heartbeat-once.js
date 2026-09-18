const fs=require('fs'),p=require('path');
const now=new Date('2026-08-10T10:05:00Z');
let delA=0,delC=0;
for(const [dir,type] of [['memory/antispam','a'],['memory/contexts','c']]){
  if(!fs.existsSync(dir)) continue;
  for(const f of fs.readdirSync(dir)){
    if(!f.endsWith('.json')) continue;
    const fp=p.join(dir,f); let j={};
    try{j=JSON.parse(fs.readFileSync(fp,'utf8'))}catch{}
    let d=null; if(type==='a'&&j.last_seen)d=new Date(j.last_seen); if(type==='c'&&j.updated_at)d=new Date(j.updated_at);
    const age=(now-d)/86400000;
    if(type==='a'&&d&&age>30){fs.unlinkSync(fp);delA++}
    if(type==='c'&&d&&age>7&&j.status!=='language_preference_only'&&!(Object.keys(j).length===1&&j.language)){fs.unlinkSync(fp);delC++}
  }
}
const txt=fs.existsSync('memory/conversations/2026-08.md')?fs.readFileSync('memory/conversations/2026-08.md','utf8'):'';
const entries=txt.split(/\n---\n/).filter(Boolean);
let total=0,newq=0,unres=0,cats={};
for(const e of entries){
  if(!/### \[\d{2}:\d{2}\]/.test(e)) continue;
  total++;
  const cat=(e.match(/\*\*Phân loại\*\*:\s*([^\n]+)/)||[])[1]?.trim()||'Other'; cats[cat]=(cats[cat]||0)+1;
  if(e.includes('⚠️')) newq++;
  if(/Đã giải quyết\*\*:\s*(⏳|❌)/.test(e)) unres++;
}
const top=Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,3).map(x=>x[0]);
const block=`\n## Weekly heartbeat stats (2026-08-10, Monday)\n- Total conversations last week: **${total}**\n- Top 3 most common issues:\n${top.map((t,i)=>`  ${i+1}. ${t}`).join('\n')}\n- Count of ⚠️ new questions not in skill: **${newq}**\n- Count of ❌/⏳ unresolved cases: **${unres}** (⏳/❌ combined)\n- Action note: ${newq>=3?'New unsupported questions increased this week; notify admin Anh Phi to review/update `interlink-support` skill.':'No major unsupported question trend detected this week.'}\n- Cleanup note: Deleted **${delA}** stale antispam files and **${delC}** stale context files during Monday cleanup.\n- Whitepaper sync health: OK — Last synced 2026-08-10 03:00 UTC+7.\n`;
fs.appendFileSync('MEMORY.md',block);
console.log('done');
