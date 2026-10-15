"""Trykkeriet: copies new encrypted messages from the ntfy topic into data/events.json
(and attachments into data/files/) so they persist beyond ntfy's 12h cache."""
import json, os, sys, urllib.request
TOPIC = os.environ["TOPIC"]
UA = {"User-Agent": "padel-posten-sync/1.0"}
def get(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()
path = "data/events.json"
db = json.load(open(path)) if os.path.exists(path) else {"v": 1, "events": []}
known = {e["id"]: e for e in db["events"]}
raw = get(f"https://ntfy.sh/{TOPIC}/json?poll=1&since=all").decode()
os.makedirs("data/files", exist_ok=True)
added = 0
for line in raw.splitlines():
    if not line.strip():
        continue
    m = json.loads(line)
    if m.get("event") != "message":
        continue
    msg = m.get("message", "")
    if not (msg.startswith("E1:") or msg == "BIG") or len(msg) > 5000:
        continue
    att = m.get("attachment")
    ex = known.get(m["id"])
    if ex and (ex.get("file") or not att):
        continue
    rec = ex or {"id": m["id"], "time": m["time"], "msg": msg}
    if att and att.get("size", 0) <= 16_000_000:
        try:
            data = get(att["url"])
            fn = f"data/files/{m['id']}.bin"
            open(fn, "wb").write(data)
            rec["file"] = fn
        except Exception as e:
            print("attachment failed", m["id"], e, file=sys.stderr)
    if not ex:
        db["events"].append(rec)
        known[m["id"]] = rec
    added += 1
db["events"].sort(key=lambda e: (e["time"], e["id"]))
json.dump(db, open(path, "w"), separators=(",", ":"))
print(f"added/updated {added}, total {len(db['events'])}")
