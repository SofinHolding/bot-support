const fs=require('fs'), path=require('path');
const dir='C:/Users/admin/.openclaw/agents/main/sessions';
const start=new Date('2026-09-10T17:00:00.000Z').getTime();
const end=new Date('2026-09-11T17:00:00.000Z').getTime();
const line1="I'm sorry, I don't have enough information to answer this question.";
const line2="Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance.";
let count=0;
function textOf(v){
  if(typeof v==='string') return v;
  if(Array.isArray(v)) return v.map(textOf).join('');
  if(v&&typeof v==='object'){
    if(typeof v.text==='string') return v.text;
    if(typeof v.content==='string') return v.content;
    return Object.values(v).map(textOf).join('');
  }
  return '';
}
for(const f of fs.readdirSync(dir)){
  if(!f.endsWith('.jsonl')||f.includes('.checkpoint')) continue;
  const p=path.join(dir,f);
  const lines=fs.readFileSync(p,'utf8').split(/\r?\n/);
  for(const ln of lines){
    if(!ln.trim()) continue;
    let o; try{o=JSON.parse(ln)}catch{continue}
    const role=o.role||o.message?.role||o.data?.role||o.item?.role;
    if(role!=='assistant') continue;
    const ts=o.created_at||o.timestamp||o.time||o.message?.created_at||o.data?.created_at||o.item?.created_at;
    let ms;
    if(typeof ts==='number') ms=ts<1e12?ts*1000:ts;
    else if(typeof ts==='string') ms=Date.parse(ts);
    else continue;
    if(!(ms>=start&&ms<end)) continue;
    const txt=textOf(o.content||o.message?.content||o.data?.content||o.item?.content||o.text||'');
    if(txt.includes(line1)&&txt.includes(line2)) count++;
  }
}
console.log(count>100?`🚨 Escalation alert (today): ${count} messages sent to @interlink_technicalsupport.`:'NO_REPLY');
