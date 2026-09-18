const fs=require('fs'), path=require('path'), readline=require('readline');
const dir='C:/Users/admin/.openclaw/agents/main/sessions';
const start=Date.parse('2026-09-14T17:00:00.000Z');
const end=Date.parse('2026-09-15T17:00:00.000Z');
const l1="I'm sorry, I don't have enough information to answer this question.";
const l2="Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance.";
let count=0;
function textOf(v){
  if(typeof v==='string') return v;
  if(Array.isArray(v)) return v.map(textOf).join('');
  let out='';
  if(v&&typeof v==='object'){
    if(typeof v.text==='string') out+=v.text;
    if(typeof v.content==='string') out+=v.content;
    if(v.type==='text'&&typeof v.value==='string') out+=v.value;
    if(Array.isArray(v.parts)) out+=v.parts.map(textOf).join('');
  }
  return out;
}
async function scanFile(p){
  const rl=readline.createInterface({input:fs.createReadStream(p,{encoding:'utf8'}), crlfDelay:Infinity});
  for await (const line of rl){
    if(!line.includes(l1) || !line.includes(l2)) continue;
    let o; try{o=JSON.parse(line)}catch{continue}
    const t=Date.parse(o.timestamp||o.created_at||o.createdAt||o.time||'');
    if(!(t>=start&&t<end)) continue;
    const role=o.role||o.message?.role||o.author?.role||o.type;
    if(role!=='assistant' && o.type!=='assistant' && o.type!=='assistant_message') continue;
    const txt=textOf(o.text??o.content??o.message?.content??o.message?.text??o.response??o);
    if(txt.includes(l1)&&txt.includes(l2)) count++;
  }
}
(async()=>{
  for(const f of fs.readdirSync(dir)){
    if(!f.endsWith('.jsonl')||f.includes('.checkpoint')) continue;
    const p=path.join(dir,f);
    const st=fs.statSync(p);
    if(st.mtimeMs < start) continue;
    await scanFile(p);
  }
  console.log(count);
})();
