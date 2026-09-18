const fs=require('fs'),path=require('path');
const now=new Date('2026-08-31T09:35:00Z');
let ad=0,cd=0;
function rmOld(dir,kind){
  if(!fs.existsSync(dir))return;
  for(const f of fs.readdirSync(dir)){
    if(!f.endsWith('.json'))continue;
    const p=path.join(dir,f); let j={};
    try{j=JSON.parse(fs.readFileSync(p,'utf8'))}catch{}
    if(kind==='anti'){
      const t=j.last_seen?new Date(j.last_seen):fs.statSync(p).mtime;
      if(now-t>30*864e5){fs.unlinkSync(p);ad++;}
    } else {
      const keys=Object.keys(j); const onlyLang=keys.length===1&&keys[0]==='language';
      const t=j.updated_at?new Date(j.updated_at):fs.statSync(p).mtime;
      if(!onlyLang&&j.status!=='language_preference_only'&&now-t>7*864e5){fs.unlinkSync(p);cd++;}
    }
  }
}
rmOld('memory/antispam','anti'); rmOld('memory/contexts','ctx');
const conv='memory/conversations/2026-08.md';
let txt=fs.existsSync(conv)?fs.readFileSync(conv,'utf8'):'';
const entries=txt.split(/\n(?=- Time: )/).filter(e=>/- Time: /.test(e));
const start=new Date('2026-08-25T00:00:00+07:00'), end=new Date('2026-09-01T00:00:00+07:00');
const week=entries.filter(e=>{const m=e.match(/- Time: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC\+7/); if(!m)return false; const d=new Date(m[1].replace(' ','T')+'+07:00'); return d>=start&&d<end;});
const cats={}; let newq=0,unres=0;
for(const e of week){const cat=(e.match(/- Category: (.*)/)||[])[1]||'Other'; cats[cat]=(cats[cat]||0)+1; if(e.includes('⚠️'))newq++; const st=(e.match(/- Status: (.*)/)||[])[1]||''; if(st.includes('⏳')||st.includes('❌'))unres++;}
const top=Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k} (${v})`).join(', ')||'N/A';
const wp=fs.existsSync('memory/whitepaper-data.md')?fs.readFileSync('memory/whitepaper-data.md','utf8').match(/Last synced: ([^\n]+)/)?.[1]:'missing';
const healthy=wp&&wp.includes('2026-08-31')?'sync is healthy':'sync may have failed and daily sync job should be checked';
const action=newq>3?'New unsupported questions increased this week; notify admin Anh Phi to review/update `interlink-support` skill.':'No new unsupported question trend detected from this week’s logged cases.';
const block=`\n## Weekly heartbeat stats (2026-08-31, Monday — 16:35)\n- Total conversations last week/current monthly log: **${week.length}**\n- Top 3 most common issues: ${top}\n- Count of ⚠️ new questions not in skill: **${newq}**\n- Count of ❌/⏳ unresolved cases: **${unres}**\n- Action note: ${action}\n- Cleanup note: Deleted **${ad}** stale antispam files and **${cd}** stale context files during Monday cleanup.\n- Whitepaper sync note: memory/whitepaper-data.md last synced **${wp||'unknown'}**; ${healthy}.\n`;
fs.appendFileSync('MEMORY.md',block); console.log(block);
