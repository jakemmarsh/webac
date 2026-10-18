#!/bin/bash
# The commit a service's image is tagged with (docs/aws-hosting.md, "Images").
#
#   image-source.sh <repo> <web|bridge> <commit>   → prints a full commit sha
#
# It is the newest commit at or before <commit> (first-parent history) that changed a
# file matching the service's railway.json watchPatterns, read at <commit> (`**` spans
# directories, `*` stays inside one: the rule Railway used). Two commits with the same
# answer build the same image, so tools/build-push-images.sh builds each image once and
# gives every later commit's tag to that same image.
set -euo pipefail
[ $# -eq 3 ] || { echo "usage: image-source.sh <repo> <web|bridge> <commit>" >&2; exit 2; }
case "$2" in
  web) watch=deploy/web/railway.json ;;
  bridge) watch=services/ws-tcp-bridge/railway.json ;;
  *) echo "image-source.sh: unknown service $2" >&2; exit 2 ;;
esac
python3 - "$1" "$3" "$watch" <<'PY'
import json, re, subprocess, sys
repo, commit, watch = sys.argv[1:4]
pats = json.loads(subprocess.check_output(["git", "-C", repo, "show", f"{commit}:{watch}"]))["build"]["watchPatterns"]
def rx(p):
    out, i = "", 0
    while i < len(p):
        if p.startswith("**", i): out += ".*"; i += 2
        elif p[i] == "*": out += "[^/]*"; i += 1
        else: out += re.escape(p[i]); i += 1
    return re.compile(out + r"\Z")
rs = [rx(p) for p in pats]
log = subprocess.Popen(
    ["git", "-C", repo, "log", "--first-parent", "--diff-merges=first-parent", "--name-only",
     "--format=%x00%H", commit],
    stdout=subprocess.PIPE, text=True)
cur = None
for line in log.stdout:
    line = line.rstrip("\n")
    if line.startswith("\0"):
        cur = line[1:]
    elif line and cur and any(r.match(line) for r in rs):
        print(cur)
        log.kill()
        sys.exit(0)
log.wait()
sys.exit(f"image-source.sh: no commit at or before {commit} changes {watch}'s watchPatterns")
PY
