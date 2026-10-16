#!/usr/bin/env bash
# Read the webac logs in CloudWatch (docs/aws-hosting.md). Replaces `railway logs`.
#
#   bash tools/aws-logs.sh bridge                       # last hour, every line
#   bash tools/aws-logs.sh bridge --since 3m            # what a monitor loop polls
#   bash tools/aws-logs.sh bridge --since 1d --filter session_close
#   bash tools/aws-logs.sh bridge --follow
#   bash tools/aws-logs.sh host --since 2d --filter deploy   # deploy times (was `railway deployment list`)
#   bash tools/aws-logs.sh bridge --since 7d --json > out.jsonl
#
# Output, by default, is the same text `railway logs` printed, so existing grep
# filters keep working:
#   2026-10-16T20:25:21.890Z [INFO]  t="…" event="client_preworld" ip="…" count=2
# (fields in the order the bridge logged them, strings quoted, numbers and booleans
# bare, nested objects as compact JSON). --json prints each line's JSON object.
# --since spans every container the host ran in that window (deploys, restarts).
#
# --filter takes a CloudWatch filter pattern: a plain term matches anywhere in the
# line; '{ $.event = "session_close" && $.server = "ac1999" }' matches JSON fields.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-webac}" AWS_REGION="${AWS_REGION:-us-east-1}"
svc="${1:?usage: aws-logs.sh bridge|web|host [--since 1h] [--filter pattern] [--follow] [--json]}"; shift
since=1h filter="" follow=() json=0
while [ $# -gt 0 ]; do
  case "$1" in
    --since) since="$2"; shift 2 ;;
    --filter) filter="$2"; shift 2 ;;
    --follow) follow=(--follow); shift ;;
    --json) json=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
args=(logs tail "/webac/$svc" --since "$since" --format short ${follow[@]+"${follow[@]}"})
[ -n "$filter" ] && args+=(--filter-pattern "$filter")

aws "${args[@]}" | JSON="$json" python3 -u -c '
import json, os, sys
as_json = os.environ["JSON"] == "1"
def val(v):
    if isinstance(v, bool): return "true" if v else "false"
    if v is None: return "null"
    if isinstance(v, (int, float)): return json.dumps(v)
    if isinstance(v, str): return json.dumps(v, ensure_ascii=False)
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)
for line in sys.stdin:
    line = line.rstrip("\n")
    ts, _, msg = line.partition(" ")
    try:
        obj = json.loads(msg)
        if not isinstance(obj, dict): raise ValueError
    except ValueError:
        if not as_json: print(line)
        continue
    if as_json:
        print(json.dumps(obj, separators=(",", ":"), ensure_ascii=False)); continue
    level = str(obj.get("level", "info")).upper()
    fields = " ".join(k + "=" + val(v) for k, v in obj.items() if k != "level")
    print(f"{ts} [{level}]  {fields}")
'
