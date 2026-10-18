# The local test gate's pass stamps (sourced by tools/ci-local.sh, tools/deploy-aws.sh and
# tools/build-push-images.sh; docs/aws-hosting.md, "The gate").
#
# CI is out of minutes and Jake won't pay for more, so tools/ci-local.sh is the gate: a
# commit may be built or deployed only after ci-local.sh passed on exactly that commit.
# A pass writes <git common dir>/acjs-gate/<full sha> (shared by every worktree of the
# clone) holding the UTC time and the mode. In GitHub Actions the workflow's own test job
# is the gate (GITHUB_ACTIONS=true skips the check).

# The stamp directory for the clone that holds <repo>.
gate_dir() { # repo
  local common
  common="$(git -C "$1" rev-parse --git-common-dir)"
  case "$common" in /*) ;; *) common="$1/$common" ;; esac
  echo "$common/acjs-gate"
}

# Record a pass for <sha>.
gate_stamp() { # repo sha mode
  local dir
  dir="$(gate_dir "$1")"
  mkdir -p "$dir"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" > "$dir/$2"
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
