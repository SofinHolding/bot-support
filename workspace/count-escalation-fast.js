const fs=require('fs'), path=require('path'), readline=require('readline');
const dir='C:/Users/admin/.openclaw/agents/main/sessions';
const start=Date.parse('2026-09-10T17:00:00.000Z');
const end=Date.parse('2026-09-11T17:00:00.000Z');
const line1="I'm sorry, I don't have enough information to answer this question.";
const line2="Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance.";
let count=0;
function textOf(v){
  if(typeof v==='string') return v;
  if(Array.isArray(v)) return v.map(textOf).join('');
  if(v&&typeof v==='object'){
    if(typeof v.text==='string') return v.text;
    if(typeof v.content==='string') return v.content;
    let s=''; for(const x of Object.values(v)) s+=textOf(x); return s;
  }
  return '';
}
function getTime(o){
 const ts=o.created_at||o.timestamp||o.time||o.message?.created_at||o.data?.created_at||o.item?.created_at;
 if(typeof ts==='number') return ts<1e12?ts*1000:ts;
 if(typeof ts==='string') return Date.parse(ts);
 return NaN;
}
(async()=>{
 const files=fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl')&&!f.includes('.checkpoint')).map(f=>path.join(dir,f));
 for(const file of files){
   const rl=readline.createInterface({input:fs.createReadStream(file,{encoding:'utf8',highWaterMark:1<<20}), crlfDelay:Infinity});
   for await (const ln of rl){
     if(!ln) continue;
     if(!ln.includes('assistant') || !ln.includes('@interlink_technicalsupport')) continue;
     let o; try{o=JSON.parse(ln)}catch{continue}
     const role=o.role||o.message?.role||o.data?.role||o.item?.role;
     if(role!=='assistant') continue;
     const ms=getTime(o);
     if(!(ms>=start&&ms<end)) continue;
     const txt=textOf(o.content||o.message?.content||o.data?.content||o.item?.content||o.text||'');
     if(txt.includes(line1)&&txt.includes(line2)) { count++; if(count>100){ console.log(`🚨 Escalation alert (today): ${count} messages sent to @interlink_technicalsupport.`); process.exit(0); } }
   }
 }
 console.log('NO_REPLY');
})().catch(e=>{console.error(e); process.exit(1)});
