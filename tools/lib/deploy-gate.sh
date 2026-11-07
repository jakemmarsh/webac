# The deploy gates' pass stamps (sourced by tools/ci-local.sh, tools/live-gate.sh, tools/deploy-aws.sh,
# tools/deploy-web-cf.sh, tools/build-push-images.sh and tools/githooks/pre-push; docs/aws-hosting.md,
# "The gate").
#
# CI is out of minutes and Jake won't pay for more, so tools/ci-local.sh is the test gate: a commit may
# be built or deployed only after ci-local.sh passed on exactly that commit. A pass writes
# <git common dir>/acjs-gate/<full sha> (shared by every worktree of the clone) holding the UTC time and
# the mode, plus acjs-gate/trees/<packages tree>-<services tree> (the pre-push guard's key: a commit on
# top that changed neither, e.g. a progress.md line, keeps the pass).
#
# tools/live-gate.sh is the live gate (2026-11-07): the first-hour play-through in each era and the
# screen regression, on local servers, in two tiers. The FULL tier (every step) writes
# acjs-gate/<full sha>.live on a pass and acjs-gate/<full sha>.live-full-fail on a failure; the FAST tier
# (`--fast`: the smoke plus what the diff touches, tools/lib/live-gate-scope.ts) writes
# acjs-gate/<full sha>.live-fast. Each file: the UTC time and the tier, then one line per step that ran.
# Every result is also a line in the git note on the commit (refs/notes/live-gate, `live-gate <tier>
# <pass|fail> <UTC> …`), pushed to origin when the run can, so a run made elsewhere (a cloud routine)
# counts here: live_check fetches origin's notes into refs/notes/live-gate-origin and reads both.
#
# A deploy (live_check) passes when THAT commit has a fast or a full pass (Jake, 2026-11-07: deploys block
# on the quick checks; the full run is a nightly routine). A full-tier failure does not block deploys: it
# is a monitor finding (tools/monitor/live-gate-full.sh, from tools/monitor/check.sh: the newest full FAIL
# not yet followed by a full PASS), fixed the same day; live_check also prints it as a warning. Deploys
# need both gates; --skip-gate / --skip-live "<reason>" override, loudly, and every override is appended
# to docs/deploy-overrides.md (commit it).
#
# In GitHub Actions the workflow's own test job is the gate (GITHUB_ACTIONS=true skips both checks: CI
# can't run the live gate, so the ci-green path is not live-gated).

# The stamp directory for the clone that holds <repo>.
gate_dir() { # repo
  local common
  common="$(git -C "$1" rev-parse --git-common-dir)"
  case "$common" in /*) ;; *) common="$1/$common" ;; esac
  echo "$common/acjs-gate"
}

# "<packages tree>-<services tree>" of <sha> ("none" for a directory the commit doesn't have).
gate_tree_key() { # repo sha
  local p s
  # (`<rev>:<path>` names the tree itself; a `^{tree}` suffix would be read as part of the path.)
  p="$(git -C "$1" rev-parse -q --verify "$2:packages" 2>/dev/null || echo none)"
  s="$(git -C "$1" rev-parse -q --verify "$2:services" 2>/dev/null || echo none)"
  echo "$p-$s"
}

# Record a ci-local pass for <sha>.
gate_stamp() { # repo sha mode
  local dir
  dir="$(gate_dir "$1")"
  mkdir -p "$dir/trees"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" > "$dir/$2"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" > "$dir/trees/$(gate_tree_key "$1" "$2")"
}

# 0 when <sha>, or a commit with the same packages/ and services/ trees, passed ci-local.sh. The tree
# index covers stamps made since 2026-11-07; for older ones the last 30 ancestors' stamps are compared.
gate_stamped_tree() { # repo sha
  local repo="$1" sha="$2" dir key a
  dir="$(gate_dir "$repo")"
  [ -s "$dir/$sha" ] && return 0
  key="$(gate_tree_key "$repo" "$sha")"
  [ -s "$dir/trees/$key" ] && return 0
  for a in $(git -C "$repo" rev-list --max-count=30 "$sha" 2>/dev/null); do
    [ -s "$dir/$a" ] || continue
    [ "$(gate_tree_key "$repo" "$a")" = "$key" ] && return 0
  done
  return 1
}

# Append an override to docs/deploy-overrides.md (once per kind + commit per process tree: deploy-aws.sh
# runs build-push-images.sh, which checks again).
gate_log_override() { # repo flag sha reason
  local repo="$1" flag="$2" sha="$3" reason="$4" key log
  key="$flag:$sha"
  case " ${ACJS_GATE_LOGGED:-} " in *" $key "*) return 0 ;; esac
  export ACJS_GATE_LOGGED="${ACJS_GATE_LOGGED:-} $key"
  log="${ACJS_DEPLOY_OVERRIDE_LOG:-$repo/docs/deploy-overrides.md}"
  if [ ! -s "$log" ]; then
    mkdir -p "$(dirname "$log")"
    printf '%s\n' '# Deploy gate overrides' '' \
      'Every deploy or image build that went out past a gate: `--skip-gate` (no tools/ci-local.sh pass) or' \
      '`--skip-live "<reason>"` (no tools/live-gate.sh pass). tools/lib/deploy-gate.sh appends a row; commit it.' '' \
      '| UTC | script | commit | override | reason | who |' '|---|---|---|---|---|---|' > "$log"
  fi
  printf '| %s | %s | %s | %s | %s | %s |\n' "$(date -u +%Y-%m-%dT%H:%MZ)" "$(basename "${0:-?}")" "${sha:0:12}" \
    "$flag" "$(printf '%s' "$reason" | tr '|\n' '/ ')" "$(id -un 2>/dev/null || echo ?)@$(hostname -s 2>/dev/null || echo ?)" >> "$log"
  echo "[gate] override logged in ${log#"$repo"/} (commit it)" >&2
}

# 0 when <sha> has a pass stamp (or this is CI, or skip=1, with a loud warning);
# otherwise prints how to gate it and returns 1.
gate_check() { # repo sha skip
  local repo="$1" sha="$2" skip="${3:-0}" stamp head
  if [ "${GITHUB_ACTIONS:-}" = true ]; then return 0; fi
  stamp="$(gate_dir "$repo")/$sha"
  if [ -s "$stamp" ]; then
    echo "[gate] ${sha:0:12} passed tools/ci-local.sh at $(cut -d' ' -f1 "$stamp")"
    return 0
  fi
  if [ "$skip" = 1 ]; then
    echo "[gate] ################################################################" >&2
    echo "[gate] WARNING: --skip-gate: ${sha:0:12} has NOT passed tools/ci-local.sh." >&2
    echo "[gate] It goes out untested. Say so wherever this deploy is reported." >&2
    echo "[gate] ################################################################" >&2
    gate_log_override "$repo" --skip-gate "$sha" "(no reason: --skip-gate takes none)"
    return 0
  fi
  head="$(git -C "$repo" rev-parse HEAD)"
  echo "[gate] ${sha:0:12} has not passed the local gate (CI is out, so tools/ci-local.sh is the gate)." >&2
  if [ "$head" = "$sha" ]; then
    echo "[gate] Run:  bash $repo/tools/ci-local.sh" >&2
  else
    echo "[gate] Run it on exactly that commit:" >&2
    echo "[gate]   git -C $repo worktree add --detach /tmp/acjs-gate-${sha:0:12} $sha" >&2
    echo "[gate]   bash /tmp/acjs-gate-${sha:0:12}/tools/ci-local.sh --ci-shape" >&2
    echo "[gate]   git -C $repo worktree remove --force /tmp/acjs-gate-${sha:0:12}" >&2
  fi
  echo "[gate] Or pass --skip-gate to deploy it untested (loudly)." >&2
  return 1
}

# ── The live gate's results: local stamp files + the git note (refs/notes/live-gate) ──

# The file a tier's result goes to: full pass .live, fast pass .live-fast, full failure .live-full-fail.
live_stamp_file() { # repo sha tier result
  case "$3:$4" in
    full:pass) echo "$(gate_dir "$1")/$2.live" ;;
    fast:pass) echo "$(gate_dir "$1")/$2.live-fast" ;;
    full:fail) echo "$(gate_dir "$1")/$2.live-full-fail" ;;
    *) return 1 ;;
  esac
}

live_has_origin() { git -C "$1" remote get-url origin >/dev/null 2>&1; }

# Origin's notes into refs/notes/live-gate-origin (best effort; LIVE_GATE_NO_FETCH=1 skips).
live_fetch_notes() { # repo
  [ -z "${LIVE_GATE_NO_FETCH:-}" ] && live_has_origin "$1" || return 0
  git -C "$1" fetch -q origin "+refs/notes/live-gate:refs/notes/live-gate-origin" >/dev/null 2>&1 || true
}

# Merge origin's notes into ours (line union) and push them (best effort; LIVE_GATE_NO_PUSH=1 skips).
live_push_notes() { # repo
  local repo="$1"
  [ -z "${LIVE_GATE_NO_PUSH:-}" ] && live_has_origin "$repo" || return 0
  live_fetch_notes "$repo"
  if git -C "$repo" rev-parse -q --verify refs/notes/live-gate-origin >/dev/null 2>&1; then
    git -C "$repo" notes --ref=live-gate merge -q -s cat_sort_uniq refs/notes/live-gate-origin >/dev/null 2>&1 || true
  fi
  if git -C "$repo" push -q origin refs/notes/live-gate >/dev/null 2>&1; then
    echo "[live-gate] result pushed to origin (refs/notes/live-gate)"
  else
    echo "[live-gate] could not push refs/notes/live-gate (the result is local only). Later: git -C $repo push origin refs/notes/live-gate" >&2
  fi
}

# Record a live-gate result for <sha>: the stamp file and a line in the commit's git note, then push the
# note. <steps> is one line per step ("<step> <result> <secs>s <report>", plus "base <sha12>").
live_record() { # repo sha tier result steps
  local repo="$1" sha="$2" tier="$3" result="$4" steps="${5:-}" file t names
  file="$(live_stamp_file "$repo" "$sha" "$tier" "$result")" || return 1
  t="${LIVE_GATE_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" # LIVE_GATE_NOW: tests pin the order
  mkdir -p "$(dirname "$file")"
  { printf '%s %s %s\n' "$t" "$tier" "$result"; [ -z "$steps" ] || printf '%s\n' "$steps"; } > "$file"
  names="$(printf '%s\n' "$steps" | awk '$1 != "base" && NF >= 2 {printf "%s%s:%s", (n++ ? "," : ""), $1, $2}')"
  git -C "$repo" notes --ref=live-gate append -m "live-gate $tier $result $t by=$(id -un 2>/dev/null || echo ?)@$(hostname -s 2>/dev/null || echo ?) steps=${names:-none}" "$sha" >/dev/null 2>&1 \
    || echo "[live-gate] could not write the git note on ${sha:0:12} (the local stamp stands)" >&2
  live_push_notes "$repo"
}

# Back-compat: a full pass.
live_stamp() { live_record "$1" "$2" full pass "${3:-}"; } # repo sha steps

# Every live-gate result on <sha> and its ancestors (the last LIVE_FULL_WINDOW commits, default 2000):
# "<UTC> <tier> <pass|fail> <commit> <source>" lines, unsorted. Sources: local, note:live-gate,
# note:live-gate-origin. A stamp from before the tiers ("<UTC> live") is a full pass.
live_records() { # repo sha
  local repo="$1" sha="$2" dir anc f b c ref
  dir="$(gate_dir "$repo")"
  anc="$(mktemp "${TMPDIR:-/tmp}/acjs-live-anc.XXXXXX")"
  git -C "$repo" rev-list --max-count="${LIVE_FULL_WINDOW:-2000}" "$sha" > "$anc" 2>/dev/null
  for f in "$dir"/*.live "$dir"/*.live-fast "$dir"/*.live-full-fail; do
    [ -s "$f" ] || continue
    b="$(basename "$f")"; c="${b%%.*}"
    grep -qxF "$c" "$anc" || continue
    case "$b" in
      *.live) echo "$(head -1 "$f" | cut -d' ' -f1) full pass $c local" ;;
      *.live-fast) echo "$(head -1 "$f" | cut -d' ' -f1) fast pass $c local" ;;
      *.live-full-fail) echo "$(head -1 "$f" | cut -d' ' -f1) full fail $c local" ;;
    esac
  done
  for ref in live-gate live-gate-origin; do
    git -C "$repo" notes --ref="$ref" list 2>/dev/null | while read -r _ c; do
      grep -qxF "$c" "$anc" || continue
      git -C "$repo" notes --ref="$ref" show "$c" 2>/dev/null \
        | awk -v c="$c" -v r="$ref" '$1 == "live-gate" && ($2 == "full" || $2 == "fast") && ($3 == "pass" || $3 == "fail") {print $4, $2, $3, c, "note:" r}'
    done
  done
  rm -f "$anc"
}

# The newest record matching an awk condition over live_records' fields ($1 UTC … $5 source). The same
# result is usually both a local stamp and a note: the local one is named.
live_newest() { # records cond
  printf '%s\n' "$1" | awk "NF >= 5 && ($2)" | sort -k1,1 -k2,2 -k3,3 -k4,4 -k5,5r | tail -1
}

# Every full-tier result on record, any commit: "<UTC> full <pass|fail> <commit> <source> <steps>" lines
# from refs/notes/live-gate-origin and refs/notes/live-gate (and this clone's local stamp files).
live_full_results() { # repo
  local repo="$1" dir f b c ref
  dir="$(gate_dir "$repo")"
  for f in "$dir"/*.live "$dir"/*.live-full-fail; do
    [ -s "$f" ] || continue
    b="$(basename "$f")"; c="${b%%.*}"
    case "$b" in
      *.live) echo "$(head -1 "$f" | cut -d' ' -f1) full pass $c local -" ;;
      *.live-full-fail) echo "$(head -1 "$f" | cut -d' ' -f1) full fail $c local $(tail -n +2 "$f" | awk '$2 == "fail" {printf "%s%s:fail", (n++ ? "," : ""), $1}')" ;;
    esac
  done
  for ref in live-gate-origin live-gate; do
    git -C "$repo" notes --ref="$ref" list 2>/dev/null | while read -r _ c; do
      git -C "$repo" notes --ref="$ref" show "$c" 2>/dev/null \
        | awk -v c="$c" -v r="$ref" '$1 == "live-gate" && $2 == "full" && ($3 == "pass" || $3 == "fail") {
            st = "-"; for (i = 5; i <= NF; i++) if ($i ~ /^steps=/) st = substr($i, 7); print $4, $2, $3, c, "note:" r, st }'
    done
  done
}

# The newest full-tier result: by time; at one time a pass over a fail, and the local stamp over its note.
live_full_newest() { # repo
  live_full_results "$1" | awk 'NF >= 5' | sort -k1,1 -k3,3r -k5,5r | tail -1
}

# The newest full-tier FAIL not yet followed (in time) by a full PASS, as "<UTC> full fail <commit> <source>
# <steps>"; nothing when the newest full result is a pass (or there is none). The monitor reports it.
live_open_full_failure() { # repo
  local newest
  newest="$(live_full_newest "$1")"
  [ "$(echo "$newest" | cut -d' ' -f3)" = fail ] && echo "$newest"
  return 0
}

# 0 when <sha> may be deployed by the live gate: it has a fast or a full pass of its own (or this is CI, or
# a skip reason was given, loudly and logged); prints which result let it through, and warns (never
# blocks) about an open full-tier failure. Otherwise prints why not and how to get a pass, returns 1.
live_check() { # repo sha skip-reason
  local repo="$1" sha="$2" reason="${3:-}" head recs own fast open why=""
  if [ "${GITHUB_ACTIONS:-}" = true ]; then return 0; fi
  live_fetch_notes "$repo"
  recs="$(LIVE_FULL_WINDOW=1 live_records "$repo" "$sha")"
  own="$(live_newest "$recs" "\$2 == \"full\" && \$3 == \"pass\" && \$4 == \"$sha\"")"
  fast="$(live_newest "$recs" "\$2 == \"fast\" && \$3 == \"pass\" && \$4 == \"$sha\"")"
  open="$(live_open_full_failure "$repo")"
  if [ -n "$open" ]; then
    echo "[live-gate] WARNING (not blocking): the newest FULL live-gate run FAILED: $(echo "$open" | awk '{printf "%s at %s (%s), failed: %s", substr($4, 1, 12), $1, $5, $6}'). The monitor reports it; fix it today." >&2
  fi
  if [ -n "$own" ]; then
    echo "[live-gate] ${sha:0:12} let through by its FULL live-gate pass at $(echo "$own" | cut -d' ' -f1) ($(echo "$own" | cut -d' ' -f5))"
    return 0
  elif [ -n "$fast" ]; then
    echo "[live-gate] ${sha:0:12} let through by its FAST live-gate pass at $(echo "$fast" | cut -d' ' -f1) ($(echo "$fast" | cut -d' ' -f5))"
    return 0
  fi
  why="it has not passed the live gate (bash tools/live-gate.sh --fast on it)."
  if [ -n "$reason" ]; then
    echo "[live-gate] ################################################################" >&2
    echo "[live-gate] WARNING: --skip-live: ${sha:0:12} has NOT passed tools/live-gate.sh." >&2
    echo "[live-gate] Reason given: $reason" >&2
    echo "[live-gate] No era was played through on it. Say so wherever this deploy is reported." >&2
    echo "[live-gate] ################################################################" >&2
    gate_log_override "$repo" --skip-live "$sha" "$reason"
    return 0
  fi
  head="$(git -C "$repo" rev-parse HEAD)"
  echo "[live-gate] ${sha:0:12} may not be deployed: $why" >&2
  if [ "$head" = "$sha" ]; then
    echo "[live-gate] Run:  bash $repo/tools/live-gate.sh --fast   (per deploy, ~15-25 min)  or  bash $repo/tools/live-gate.sh   (full, ~1.5-2 h)" >&2
  else
    echo "[live-gate] Check that commit out (clean tree) and run tools/live-gate.sh --fast (or the full tier) there:" >&2
    echo "[live-gate]   git -C $repo worktree add --detach $repo/.claude/worktrees/live-gate-${sha:0:12} $sha" >&2
    echo "[live-gate]   bash $repo/.claude/worktrees/live-gate-${sha:0:12}/tools/live-gate.sh --fast" >&2
  fi
  echo "[live-gate] docs/verification-workflows.md, \"The live gate\"." >&2
  echo "[live-gate] Or pass --skip-live \"<reason>\" to deploy it unplayed (loudly; logged in docs/deploy-overrides.md)." >&2
  return 1
}
