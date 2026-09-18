const fs=require('fs'),path=require('path'),readline=require('readline');
const dir='C:/Users/admin/.openclaw/agents/main/sessions';
const start=Date.parse('2026-09-12T00:00:00+07:00');
const end=Date.parse('2026-09-13T00:00:00+07:00');
const l1="I'm sorry, I don't have enough information to answer this question.";
const l2="Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance.";
function textOf(v){if(!v)return ''; if(typeof v==='string')return v; if(Array.isArray(v))return v.map(textOf).join('\n'); if(typeof v==='object'){return textOf(v.text??v.content??v.parts??'')} return '';}
(async()=>{let count=0; const files=fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl')&&!f.includes('.checkpoint'));
for(const f of files){const p=path.join(dir,f); const rl=readline.createInterface({input:fs.createReadStream(p,{encoding:'utf8'}),crlfDelay:Infinity});
 for await (const line of rl){ if(!line.includes('@interlink_technicalsupport')||!line.includes("I don't have enough information")) continue; let o; try{o=JSON.parse(line)}catch{continue}; const role=o.role||o.message?.role||o.author?.role||o.type; if(role!=='assistant')continue; const ts=o.createdAt||o.timestamp||o.time||o.date||o.message?.createdAt||o.message?.timestamp; const t=Date.parse(ts); if(!Number.isFinite(t)||t<start||t>=end)continue; const txt=textOf(o.text??o.content??o.message?.content??o.message?.text??o.response); if(txt.includes(l1)&&txt.includes(l2))count++; }}
console.log(count>100?`🚨 Escalation alert (today): ${count} messages sent to @interlink_technicalsupport.`:'NO_REPLY');})().catch(e=>{console.error(e);process.exit(1)});
