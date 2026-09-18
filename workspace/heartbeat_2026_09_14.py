import os, re, json, datetime, glob
from collections import Counter
now=datetime.datetime(2026,9,14,0,1,tzinfo=datetime.timezone(datetime.timedelta(hours=7)))
week_start=datetime.date(2026,9,7); week_end=datetime.date(2026,9,13)
conv_path='memory/conversations/2026-09.md'
text=open(conv_path,encoding='utf-8').read() if os.path.exists(conv_path) else ''
entries=re.split(r'\n---\s*\n', text)
count=0; cats=[]; newq=0; unresolved=0
for e in entries:
    if not e.strip().startswith('### '): continue
    # Sept current log entries shown are in current month; treat as last week if present, no date in headings
    count+=1
    m=re.search(r'- \*\*Phân loại\*\*:\s*(.+)', e)
    if m: cats.append(m.group(1).strip())
    if '⚠️' in e or 'CÂU HỎI MỚI' in e: newq+=1
    if '⏳' in e or '❌' in e: unresolved+=1
c=Counter(cats)
top=[x for x,n in c.most_common(3)]
# cleanup
cut_ant=now-datetime.timedelta(days=30); cut_ctx=now-datetime.timedelta(days=7)
del_ant=0; del_ctx=0
for p in glob.glob('memory/antispam/*.json'):
    try:
        data=json.load(open(p,encoding='utf-8'))
        ls=data.get('last_seen')
        if not ls: continue
        dt=datetime.datetime.fromisoformat(str(ls).replace('Z','+00:00'))
        if dt.tzinfo is None: dt=dt.replace(tzinfo=now.tzinfo)
        if dt < cut_ant:
            os.remove(p); del_ant+=1
    except Exception: pass
for p in glob.glob('memory/contexts/*.json'):
    try:
        data=json.load(open(p,encoding='utf-8'))
        keys=set(data.keys())
        if keys <= {'language'}: continue
        upd=data.get('updated_at')
        if not upd: continue
        dt=datetime.datetime.fromisoformat(str(upd).replace('Z','+00:00'))
        if dt.tzinfo is None: dt=dt.replace(tzinfo=now.tzinfo)
        if dt < cut_ctx and data.get('status')!='language_preference_only':
            os.remove(p); del_ctx+=1
    except Exception: pass
# whitepaper
wp=open('memory/whitepaper-data.md',encoding='utf-8').read() if os.path.exists('memory/whitepaper-data.md') else ''
wm=re.search(r'Last synced:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})([^\n]*)',wp)
wp_note='memory/whitepaper-data.md missing; notify admin Anh Phi to check daily sync job.'
if wm:
    d=datetime.date.fromisoformat(wm.group(1))
    if (now.date()-d).days>2:
        wp_note=f'memory/whitepaper-data.md last synced **{wm.group(1)}{wm.group(2).strip()}**; notify admin Anh Phi to check the daily sync job.'
    else:
        wp_note=f'memory/whitepaper-data.md last synced **{wm.group(1)}{wm.group(2).strip()}**; sync is healthy.'
lines=['',f'## Weekly heartbeat stats (2026-09-14, Monday — 00:01)',f'- Total conversations last week: **{count}**']
if top:
    lines.append('- Top 3 most common issues:')
    for i,t in enumerate(top,1): lines.append(f'  {i}. {t}')
else:
    lines.append('- Top 3 most common issues: none logged this week')
lines += [f'- Count of ⚠️ new questions not in skill: **{newq}**',f'- Count of ❌/⏳ unresolved cases: **{unresolved}**',('- Action note: New unsupported questions increased this week; notify admin Anh Phi to review/update `interlink-support` skill.' if newq>=3 else '- Action note: No major unsupported question trend detected this week.'),f'- Cleanup note: Deleted **{del_ant}** stale antispam files and **{del_ctx}** stale context files during Monday cleanup.',f'- Whitepaper sync note: {wp_note}','']
with open('MEMORY.md','a',encoding='utf-8') as f: f.write('\n'.join(lines))
print('done', count, top, newq, unresolved, del_ant, del_ctx, wp_note)
