const fs=require('fs'), path=require('path');
const dir='C:/Users/admin/.openclaw/agents/main/sessions';
const start=Date.parse('2026-09-08T17:00:00.000Z');
const end=Date.parse('2026-09-09T17:00:00.000Z');
const l1="I'm sorry, I don't have enough information to answer this question.";
const l2='Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance.';
let count=0;
function textOf(v){
  if(!v) return '';
  if(typeof v==='string') return v;
  if(Array.isArray(v)) return v.map(textOf).join('\n');
  if(typeof v==='object'){
    if(typeof v.text==='string') return v.text;
    if(v.type==='text' && typeof v.content==='string') return v.content;
    return Object.values(v).map(textOf).join('\n');
  }
  return '';
}
function isAssistant(o){
  return o.role==='assistant'||o.type==='assistant'||o.author?.role==='assistant'||o.message?.role==='assistant'||o.msg?.role==='assistant';
}
function timeMs(o){
  const t=o.timestamp||o.time||o.createdAt||o.created_at||o.date||o.message?.timestamp||o.message?.createdAt;
  if(typeof t==='number') return t<1e12?t*1000:t;
  if(typeof t==='string') { const ms=Date.parse(t); if(!Number.isNaN(ms)) return ms; }
  return NaN;
}
for(const f of fs.readdirSync(dir)){
  if(!f.endsWith('.jsonl')||f.includes('.checkpoint')) continue;
  const lines=fs.readFileSync(path.join(dir,f),'utf8').split(/\r?\n/);
  for(const line of lines){
    if(!line.trim()) continue;
    let o; try{o=JSON.parse(line)}catch{continue}
    const ms=timeMs(o); if(!(ms>=start&&ms<end)) continue;
    if(!isAssistant(o)) continue;
    const txt=textOf(o.text||o.content||o.message?.content||o.message||o.response||o.output||o);
    if(txt.includes(l1)&&txt.includes(l2)) count++;
  }
}
console.log(count>100?`🚨 Escalation alert (today): ${count} messages sent to @interlink_technicalsupport.`:'NO_REPLY');
