import json, datetime, re

target1 = "I'm sorry, I don't have enough information to answer this question."
target2 = "Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance."
tz = datetime.timezone(datetime.timedelta(hours=7))
start = datetime.datetime(2026,9,16,0,0,tzinfo=tz)
end = datetime.datetime(2026,9,17,0,0,tzinfo=tz)
count=0

def parse_dt(ts):
    try:
        if isinstance(ts,(int,float)):
            return datetime.datetime.fromtimestamp(ts/1000 if ts>1e12 else ts, datetime.timezone.utc)
        if isinstance(ts,str):
            s=ts.replace('Z','+00:00')
            dt=datetime.datetime.fromisoformat(s)
            if dt.tzinfo is None: dt=dt.replace(tzinfo=datetime.timezone.utc)
            return dt
    except Exception: return None

def collect(x,out):
    if isinstance(x,str): out.append(x)
    elif isinstance(x,dict):
        for k in ('text','content','message','value'):
            if k in x: collect(x[k],out)
    elif isinstance(x,list):
        for y in x: collect(y,out)

for fn in open('today_files.txt',encoding='utf-8'):
    fn=fn.strip()
    if not fn: continue
    try:
      with open(fn,encoding='utf-8') as f:
        for line in f:
          if target1 not in line and target2 not in line and 'assistant' not in line: continue
          try: obj=json.loads(line)
          except Exception: continue
          role=obj.get('role') or obj.get('speaker') or (obj.get('message') or {}).get('role')
          if role!='assistant': continue
          ts=obj.get('timestamp') or obj.get('ts') or obj.get('createdAt') or obj.get('created_at') or obj.get('time')
          dt=parse_dt(ts)
          if not dt or not (start <= dt.astimezone(tz) < end): continue
          texts=[]; collect(obj.get('text'),texts); collect(obj.get('content'),texts); collect(obj.get('message'),texts)
          txt='\n'.join(texts)
          if target1 in txt and target2 in txt: count+=1
    except Exception: pass
print(f'🚨 Escalation alert (today): {count} messages sent to @interlink_technicalsupport.' if count>100 else 'NO_REPLY')
