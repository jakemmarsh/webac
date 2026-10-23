#!/usr/bin/env bash
# TELEMETRY.refusal-events — print each refusal (era, code) pair the bridge logged that this
# state file has not seen yet: a refusal players hit that we never saw before.
#
#   bash tools/watch-refusals.sh <state-file>                 # the last 10 minutes of bridge logs
#   bash tools/watch-refusals.sh <state-file> --since 1d      # seed / catch up
#   bash tools/watch-refusals.sh <state-file> --input x.jsonl # offline: `aws-logs.sh bridge --json` output
#
# As a monitor (one line per new pair; nothing when nothing is new):
#   while true; do bash tools/watch-refusals.sh /tmp/acjs-refusals.tsv --since 10m; sleep 300; done
#
# Reads `client_refusal` lines (services/ws-tcp-bridge/src/clientRefusal.ts, renderer
# telemetry/RefusalReporter.ts). The state file is TSV: era, code, first seen (UTC). Each new
# pair prints once with the window's total count, its sources / contexts / servers and the text.
# A line the bridge printed that is not JSON is skipped.
set -euo pipefail
state="${1:?usage: watch-refusals.sh <state-file> [--since 10m] [--input file.jsonl]}"; shift
since=10m input=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) since="$2"; shift 2 ;;
    --input) input="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
touch "$state"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "$input" ]; then
  src=(cat "$input")
else
  src=(bash "$here/aws-logs.sh" bridge --since "$since" --filter '{ $.event = "client_refusal" }' --json)
fi

"${src[@]}" | STATE="$state" python3 -I -c '
import json, os, sys, datetime
state = os.environ["STATE"]
seen = set()
with open(state, encoding="utf-8") as f:
    for row in f:
        p = row.rstrip("\n").split("\t")
        if len(p) >= 2: seen.add((p[0], p[1]))
new = {}
order = []
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        o = json.loads(line)
    except ValueError:
        continue
    if not isinstance(o, dict) or o.get("event") != "client_refusal": continue
    key = (str(o.get("era") or "unknown"), str(o.get("code") or ""))
    if not key[1] or key in seen: continue
    a = new.get(key)
    if a is None:
        a = new[key] = {"count": 0, "source": set(), "context": set(), "server": set(), "text": None, "action": None}
        order.append(key)
    a["count"] += int(o.get("count") or 1)
    for k in ("source", "context", "server"):
        if o.get(k): a[k].add(str(o[k]))
    if a["text"] is None and o.get("text"): a["text"] = str(o["text"])
    if a["action"] is None and o.get("action") is not None: a["action"] = o["action"]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
with open(state, "a", encoding="utf-8") as f:
    for key in order:
        a = new[key]
        j = lambda s: ",".join(sorted(s)) or "-"
        act = "" if a["action"] is None else " action=0x%x" % int(a["action"])
        print("NEW refusal era=%s code=%s source=%s context=%s servers=%s count=%d%s text=%s" % (
            key[0], key[1], j(a["source"]), j(a["context"]), j(a["server"]), a["count"], act, json.dumps(a["text"])))
        f.write("%s\t%s\t%s\n" % (key[0], key[1], now))
'
