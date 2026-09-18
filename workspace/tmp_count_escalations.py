import glob,json,datetime,os
TZ=datetime.timezone(datetime.timedelta(hours=7))
day=datetime.date(2026,9,13)
line1="I'm sorry, I don't have enough information to answer this question."
line2="Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance."
count=0

def collect(x,texts):
    if isinstance(x,str): texts.append(x)
    elif isinstance(x,list):
        for it in x: collect(it,texts)
    elif isinstance(x,dict):
        for k in ('text','content','message','value'):
            if k in x: collect(x[k],texts)

for path in glob.glob(r'C:/Users/admin/.openclaw/agents/main/sessions/*.jsonl'):
    if '.checkpoint' in os.path.basename(path):
        continue
    try:
        f=open(path,'r',encoding='utf-8')
    except FileNotFoundError:
        continue
    with f:
        for ln in f:
            try: obj=json.loads(ln)
            except Exception: continue
            msg=obj.get('message') if isinstance(obj.get('message'),dict) else {}
            role=obj.get('role') or msg.get('role') or (obj.get('author',{}) if isinstance(obj.get('author'),dict) else {}).get('role')
            if role!='assistant': continue
            ts=obj.get('timestamp') or obj.get('createdAt') or obj.get('time') or obj.get('ts') or msg.get('timestamp')
            if not ts: continue
            try:
                if isinstance(ts,(int,float)):
                    dt=datetime.datetime.fromtimestamp(ts/1000 if ts>1e12 else ts, datetime.timezone.utc)
                else:
                    s=str(ts).replace('Z','+00:00')
                    dt=datetime.datetime.fromisoformat(s)
                    if dt.tzinfo is None: dt=dt.replace(tzinfo=datetime.timezone.utc)
            except Exception:
                continue
            if dt.astimezone(TZ).date()!=day: continue
            texts=[]
            collect(obj.get('content'),texts); collect(obj.get('text'),texts); collect(msg.get('content'),texts)
            txt='\n'.join(texts)
            if line1 in txt and line2 in txt:
                count+=1
print(count)
