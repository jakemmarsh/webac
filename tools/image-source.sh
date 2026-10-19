#!/bin/bash
# The commit a service's image is tagged with (docs/aws-hosting.md, "Images").
#
#   image-source.sh <repo> <web|bridge> <commit>   → prints a full commit sha
#   image-source.sh --same-inputs <repo> <web|bridge> <src> <commit>
#       → exit 0 when no file the service is built from differs between <src> and
#         <commit>; else prints those files and exits 1 (tools/build-push-images.sh runs
#         it before giving <commit> the tag of <src>'s image)
#
# It is the newest commit at or before <commit> (first-parent history) that changed a
# file matching the service's railway.json watchPatterns, read at <commit> (`**` spans
# directories, `*` stays inside one: the rule Railway used). Two commits with the same
# answer build the same image, so tools/build-push-images.sh builds each image once and
# gives every later commit's tag to that same image.
#
# Renames count as a delete plus an add (--no-renames): with git's default rename
# detection, moving a watched file to an unwatched path lists only the new name, and the
# image that still had the old file would be retagged.
set -euo pipefail
MODE=source
if [ "${1:-}" = --same-inputs ]; then MODE=same; shift; [ $# -eq 4 ] || { echo "usage: image-source.sh --same-inputs <repo> <web|bridge> <src> <commit>" >&2; exit 2; }
else [ $# -eq 3 ] || { echo "usage: image-source.sh <repo> <web|bridge> <commit>" >&2; exit 2; }; fi
case "$2" in
  web) watch=deploy/web/railway.json ;;
  bridge) watch=services/ws-tcp-bridge/railway.json ;;
  *) echo "image-source.sh: unknown service $2" >&2; exit 2 ;;
esac
repo="$1"; shift 2
python3 - "$MODE" "$repo" "$watch" "$@" <<'PY'
import json, re, subprocess, sys
mode, repo, watch = sys.argv[1:4]
def patterns(commit):
    return json.loads(subprocess.check_output(["git", "-C", repo, "show", f"{commit}:{watch}"]))["build"]["watchPatterns"]
def rx(p):
    out, i = "", 0
    while i < len(p):
        if p.startswith("**", i): out += ".*"; i += 2
        elif p[i] == "*": out += "[^/]*"; i += 1
        else: out += re.escape(p[i]); i += 1
    return re.compile(out + r"\Z")

if mode == "same":
    src, commit = sys.argv[4:6]
    # Patterns at either end: a file either image is built from.
    rs = [rx(p) for p in set(patterns(src)) | set(patterns(commit))]
    names = subprocess.check_output(
        ["git", "-C", repo, "diff", "--no-renames", "--name-only", src, commit], text=True).split("\n")
    changed = [n for n in names if n and any(r.match(n) for r in rs)]
    if changed:
        print("\n".join(changed))
        sys.exit(1)
    sys.exit(0)

commit = sys.argv[4]
rs = [rx(p) for p in patterns(commit)]
log = subprocess.Popen(
    ["git", "-C", repo, "log", "--first-parent", "--diff-merges=first-parent", "--no-renames", "--name-only",
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
