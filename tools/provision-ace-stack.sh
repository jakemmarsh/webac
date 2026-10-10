#!/usr/bin/env bash
# provision-ace-stack.sh — stand up a NATIVE (no-Docker) ACE server stack for
# remote/ephemeral dev environments (Claude Code on the web etc.).
#
# The primary dev machine runs ACE + MySQL in Docker (docs/ace-server-ops.md).
# Remote containers have no Docker daemon, so this builds the same stack
# natively. First verified end-to-end 2026-07-04 in a Claude Code web
# container: browser client logged in, created a character over the wire, and
# entered Holtburg against this stack.
#
# Stages (each skipped if already done — safe to re-run):
#   1. MariaDB via apt, .NET SDK 10 via dotnet-install (ACE targets net10.0)
#   1.5 FAST PATH: restore prebuilt ACE.Server + pre-seeded MySQL datadir from
#      the `reference-bundle` branch's ace-stack/ dir (~2 min) — falls through
#      to the slow stages below when the bundle is absent or broken
#   2. Build ACE.Server from reference/ACE (run tools/provision-remote-env.sh
#      first — it clones reference/ACE and fetches the DATs)
#   3. Create ace_auth/ace_shard/ace_world + import base schemas
#   4. Import the world DB from a shallow clone of ACE-World-16PY
#      (git clone works through the proxy; GitHub release-asset URLs do not)
#   5. Write Config.js (binds 127.0.0.1:9000/9001 UDP, DATs from dat/,
#      DefaultSessionTimeout=600 — headless SwiftShader rendering stalls the
#      client's ack loop past ACE's 60s default during world entry)
#   6. Launch ACE with a console FIFO + create the testacjs admin account
#
# `--make-bundle`: after a full provision, snapshot /opt/ace-server + the
# MySQL datadir into ace-stack/ on the reference-bundle branch and push, so
# every later container takes the stage-1.5 fast path. Parts are split <90MB
# (GitHub's 100MB per-file hard limit).
#
# After this: npx tsx services/ws-tcp-bridge/src/bridge.ts, npm run dev, and
# open /?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs
# (do NOT click ENTER in automation — auto-enter is on by default and a manual
# click races it; see progress.md 2026-07-04).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ACE_DIR=/opt/ace-server
SCRATCH="${TMPDIR:-/tmp}/ace-stack"
mkdir -p "$SCRATCH"

# ── 1. System deps ──────────────────────────────────────────────────
if ! command -v mysqld >/dev/null 2>&1 && ! command -v mariadbd >/dev/null 2>&1; then
  echo "[ace-stack] installing mariadb-server…"
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mariadb-server unzip zstd
fi
command -v zstd >/dev/null 2>&1 || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zstd; }
# A wiped /var/lib/mysql (fresh-container sim, broken restore) makes
# `service mariadb start` fail hard ("Can't locate MariaDB data location")
# and set -e aborts before the stage-1.5 fast path can restore the datadir.
# Re-init an empty datadir first; the fast path replaces it wholesale anyway.
if [[ ! -d /var/lib/mysql/mysql ]]; then
  echo "[ace-stack] datadir missing — initializing empty datadir…"
  mkdir -p /var/lib/mysql
  mariadb-install-db --datadir=/var/lib/mysql --auth-root-authentication-method=socket >/dev/null 2>&1 || true
  chown -R mysql:mysql /var/lib/mysql
fi
service mariadb status >/dev/null 2>&1 || service mariadb start

if [[ ! -x /opt/dotnet/dotnet ]]; then
  echo "[ace-stack] installing .NET SDK 10…"
  curl -sSL https://dot.net/v1/dotnet-install.sh -o "$SCRATCH/dotnet-install.sh"
  bash "$SCRATCH/dotnet-install.sh" --channel 10.0 --install-dir /opt/dotnet
fi

# ── 1.5 Bundle fast-path ────────────────────────────────────────────
# The two slow stages are the ACE build (stage 2, ~5 min) and the world DB
# import (stage 4, ~15 min). A prior `--make-bundle` run snapshots both into
# ace-stack/ on the reference-bundle orphan branch (same private in-repo
# transport provision-remote-env.sh already uses for client-eol/images);
# restoring them takes ~2 min. Any failure here falls through to the slow
# stages — the fast path is an optimization, never a requirement.
world_seeded() { [[ "$(mysql -N -e 'SELECT COUNT(*) FROM ace_world.weenie' 2>/dev/null || echo 0)" -ge 10000 ]]; }

BUNDLE_EXTRACTED=""
fetch_stack_bundle() {
  [[ -n "$BUNDLE_EXTRACTED" ]] && return 0
  [[ -d "$SCRATCH/ace-stack" ]] && { BUNDLE_EXTRACTED=1; return 0; }
  git -C "$REPO" fetch --depth 1 origin reference-bundle 2>/dev/null || return 1
  git -C "$REPO" ls-tree --name-only FETCH_HEAD | grep -qx ace-stack || return 1
  echo "[ace-stack] extracting ace-stack bundle from reference-bundle branch…"
  git -C "$REPO" archive --format=tar FETCH_HEAD ace-stack | tar -x -C "$SCRATCH" || return 1
  BUNDLE_EXTRACTED=1
}

restore_ace_server() {
  fetch_stack_bundle || return 1
  ls "$SCRATCH"/ace-stack/ace-server.tar.zst.part-* >/dev/null 2>&1 || return 1
  echo "[ace-stack] fast path: restoring prebuilt ACE.Server from bundle…"
  cat "$SCRATCH"/ace-stack/ace-server.tar.zst.part-* | zstd -d | tar -x -C /opt || { rm -rf "$ACE_DIR"; return 1; }
  [[ -f "$ACE_DIR/ACE.Server.dll" ]]
}

restore_mysql_datadir() {
  fetch_stack_bundle || return 1
  ls "$SCRATCH"/ace-stack/mysql-datadir.tar.zst.part-* >/dev/null 2>&1 || return 1
  echo "[ace-stack] fast path: restoring pre-seeded MySQL datadir from bundle…"
  # Wholesale datadir replacement: only reached when ace_world is absent or
  # incomplete (world_seeded false), i.e. fresh/broken containers. Any shard
  # rows (characters) present alongside a missing world DB are torched with
  # it — acceptable for ephemeral containers, which is the only place this
  # script runs.
  service mariadb stop || true
  rm -rf /var/lib/mysql
  if cat "$SCRATCH"/ace-stack/mysql-datadir.tar.zst.part-* | zstd -d | tar -x -C /var/lib; then
    chown -R mysql:mysql /var/lib/mysql
    service mariadb start && world_seeded && return 0
  fi
  # Broken restore would wedge stages 3-4; re-init an empty datadir so the
  # slow path can rebuild from scratch.
  echo "[ace-stack] WARN: bundle datadir restore failed — re-initializing empty datadir for slow path"
  service mariadb stop || true
  rm -rf /var/lib/mysql && mkdir -p /var/lib/mysql
  mariadb-install-db --datadir=/var/lib/mysql --auth-root-authentication-method=socket >/dev/null 2>&1 || true
  chown -R mysql:mysql /var/lib/mysql
  service mariadb start
  return 1
}

# ── make-bundle mode ────────────────────────────────────────────────
make_bundle() {
  world_seeded || { echo "[ace-stack] --make-bundle: world DB not seeded — run a full provision first"; exit 1; }
  [[ -f "$ACE_DIR/ACE.Server.dll" ]] || { echo "[ace-stack] --make-bundle: no ACE build at $ACE_DIR"; exit 1; }
  local weenies ace_rev out wt
  weenies="$(mysql -N -e 'SELECT COUNT(*) FROM ace_world.weenie')"
  ace_rev="$(git -C "$REPO/reference/ACE" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "[ace-stack] --make-bundle: snapshotting ACE build + datadir ($weenies weenies)…"
  pkill -f 'ACE.Server.dll' 2>/dev/null || true
  sleep 2
  service mariadb stop
  out="$SCRATCH/bundle-out/ace-stack"
  rm -rf "$out" && mkdir -p "$out"
  # Config.js is written per-container by stage 5 (it bakes in $REPO paths);
  # logs and the console fifo are runtime state. Exclude all three.
  tar -C /opt --exclude=ace-server/Config.js --exclude=ace-server/ace.log \
      --exclude=ace-server/console.fifo -cf - ace-server \
    | zstd -T0 -8 | split -b 90m - "$out/ace-server.tar.zst.part-"
  tar -C /var/lib -cf - mysql | zstd -T0 -8 | split -b 90m - "$out/mysql-datadir.tar.zst.part-"
  service mariadb start
  {
    echo "created_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "weenies: $weenies"
    echo "ace_rev: $ace_rev"
    echo "mariadb: $(mariadbd --version 2>/dev/null || mysqld --version)"
    echo "dotnet: $(/opt/dotnet/dotnet --version 2>/dev/null || echo unknown)"
    # Keep the size column: strip only the directory path (first / to last /),
    # not everything up to the last / (which ate the du sizes too).
    du -h "$out"/* | sed 's|/.*/|  |'
  } > "$out/MANIFEST"
  cat "$out/MANIFEST"
  echo "[ace-stack] --make-bundle: pushing to reference-bundle branch…"
  git -C "$REPO" fetch --depth 1 origin reference-bundle
  wt="$SCRATCH/bundle-wt"
  git -C "$REPO" worktree remove --force "$wt" 2>/dev/null || true
  git -C "$REPO" worktree add --detach "$wt" FETCH_HEAD
  rm -rf "$wt/ace-stack"
  cp -R "$out" "$wt/ace-stack"
  # core.hooksPath is neutralized for this push: the repo's commit-msg /
  # client hooks are meaningless for a binary-bundle orphan branch that
  # contains no client code. (No hook runs the test suite any more — CI is
  # the gate, 2026-09-12.)
  (cd "$wt" \
    && git add -A ace-stack \
    && git commit -m "ace-stack bundle: ACE $ace_rev, $weenies weenies, $(date -u +%Y-%m-%d)" \
    && git -c core.hooksPath=/dev/null push origin HEAD:refs/heads/reference-bundle)
  git -C "$REPO" worktree remove --force "$wt"
  echo "[ace-stack] --make-bundle: done"
}
if [[ "${1:-}" == "--make-bundle" ]]; then
  make_bundle
  exit 0
fi

# ── 2. Build ACE ────────────────────────────────────────────────────
if [[ ! -f "$ACE_DIR/ACE.Server.dll" ]]; then
  restore_ace_server || true
fi
if [[ ! -f "$ACE_DIR/ACE.Server.dll" ]]; then
  [[ -d "$REPO/reference/ACE/Source" ]] || { echo "[ace-stack] run tools/provision-remote-env.sh first (needs reference/ACE)"; exit 1; }
  echo "[ace-stack] building ACE.Server…"
  (cd "$REPO/reference/ACE/Source" && /opt/dotnet/dotnet publish ACE.Server/ACE.Server.csproj -c Release -o "$ACE_DIR")
fi

# ── 3. Databases ────────────────────────────────────────────────────
# Fast path first: a restored datadir carries schemas, users, AND the seeded
# world, making stages 3 and 4 both no-ops.
if ! world_seeded; then
  restore_mysql_datadir || true
fi
if ! mysql -N -e "SELECT 1 FROM information_schema.schemata WHERE schema_name='ace_world'" | grep -q 1; then
  echo "[ace-stack] creating databases…"
  mysql <<'SQL'
CREATE DATABASE IF NOT EXISTS ace_auth CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS ace_shard CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS ace_world CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'ace'@'127.0.0.1' IDENTIFIED BY 'ace_pass';
CREATE USER IF NOT EXISTS 'ace'@'localhost' IDENTIFIED BY 'ace_pass';
GRANT ALL ON ace_auth.* TO 'ace'@'127.0.0.1'; GRANT ALL ON ace_shard.* TO 'ace'@'127.0.0.1'; GRANT ALL ON ace_world.* TO 'ace'@'127.0.0.1';
GRANT ALL ON ace_auth.* TO 'ace'@'localhost'; GRANT ALL ON ace_shard.* TO 'ace'@'localhost'; GRANT ALL ON ace_world.* TO 'ace'@'localhost';
FLUSH PRIVILEGES;
SQL
  mysql --default-character-set=utf8mb4 ace_auth < "$REPO/reference/ACE/Database/Base/AuthenticationBase.sql"
  mysql --default-character-set=utf8mb4 ace_shard < "$REPO/reference/ACE/Database/Base/ShardBase.sql"
  for f in "$REPO"/reference/ACE/Database/Updates/Authentication/*.sql; do
    mysql --default-character-set=utf8mb4 ace_auth < "$f" || true
  done
  # Shard updates that JOIN ace_world warn until the world import lands — harmless (fresh shard).
  for f in "$REPO"/reference/ACE/Database/Updates/Shard/*.sql; do
    mysql --default-character-set=utf8mb4 ace_shard < "$f" || true
  done
fi

# ── 4. World DB (~15 min: 545MB SQL, ~30k weenies) ─────────────────
if ! world_seeded; then
  [[ -d "$SCRATCH/ace-world" ]] || git clone --depth 1 https://github.com/ACEmulator/ACE-World-16PY.git "$SCRATCH/ace-world"
  echo "[ace-stack] importing world DB (takes ~15 min)…"
  mysql -e "SET GLOBAL max_allowed_packet=268435456; SET GLOBAL innodb_flush_log_at_trx_commit=0;"
  W="$SCRATCH/ace-world/Database"
  {
    echo "SET SESSION foreign_key_checks=0; SET SESSION unique_checks=0;"
    cat "$W/1-Base/WorldBase.sql"
    find "$W/2-BaseUpdates" -name '*.sql' -print0 | sort -z | xargs -0 cat
    find "$W/3-Core" -name '*.sql' -print0 | sort -z | xargs -0 cat
  } | mysql --default-character-set=utf8mb4 --max-allowed-packet=268435456 ace_world
  echo "[ace-stack] world import done: $(mysql -N -e 'SELECT COUNT(*) FROM ace_world.weenie') weenies"
fi

# ── 5. Config ───────────────────────────────────────────────────────
if [[ ! -f "$ACE_DIR/Config.js" ]]; then
  cp "$ACE_DIR/Config.js.example" "$ACE_DIR/Config.js"
  sed -i 's|"Host": "0.0.0.0"|"Host": "127.0.0.1"|' "$ACE_DIR/Config.js"
  sed -i "s|\"DatFilesDirectory\": \"c:\\\\\\\\ACE\\\\\\\\Dats\\\\\\\\\"|\"DatFilesDirectory\": \"$REPO/dat/\"|" "$ACE_DIR/Config.js"
  sed -i 's|"WorldName": "ACEmulator"|"WorldName": "acjs-dev"|' "$ACE_DIR/Config.js"
  sed -i 's|"Username": "root"|"Username": "ace"|g' "$ACE_DIR/Config.js"
  sed -i 's|"Password": ""|"Password": "ace_pass"|g' "$ACE_DIR/Config.js"
  sed -i 's|"DefaultSessionTimeout": 60,|"DefaultSessionTimeout": 600,|' "$ACE_DIR/Config.js"
  # GitHub API is proxy-blocked for out-of-scope repos — disable auto-updaters.
  sed -i 's|"AutoApplyDatabaseUpdates": true|"AutoApplyDatabaseUpdates": false|' "$ACE_DIR/Config.js"
  sed -i 's|"AutoUpdateWorldDatabase": true|"AutoUpdateWorldDatabase": false|' "$ACE_DIR/Config.js"
fi

# ── 6. Launch + admin account ───────────────────────────────────────
# NOTE: guard on the ACE.Server.dll process itself, not a bare `dotnet` name
# match — leftover `dotnet` MSBuild node-reuse processes from the stage-2
# `dotnet publish` build satisfy `pgrep -x dotnet` too, which silently
# skipped this whole block (script printed "ready" with ACE never actually
# started: no process, no log file, no listening ports — hit 2026-07-18).
if ! pgrep -f 'ACE.Server.dll' >/dev/null; then
  echo "[ace-stack] launching ACE…"
  [[ -p "$ACE_DIR/console.fifo" ]] || mkfifo "$ACE_DIR/console.fifo"
  (cd "$ACE_DIR" && tail -f console.fifo | /opt/dotnet/dotnet ACE.Server.dll > "$ACE_DIR/ace.log" 2>&1 &)
  until grep -aq 'World is now open' "$ACE_DIR/ace.log" 2>/dev/null; do sleep 2; done
  # NOTE: the account table's column is `accountName`, not `account_Name`
  # (2026-07-18 fix) — the old query errored every run and always fell
  # through to accountcreate, which is harmless (ACE no-ops on a dup) but
  # meant this check never actually worked.
  if ! mysql -N -e "SELECT COUNT(*) FROM ace_auth.account WHERE accountName='testacjs'" | grep -q 1; then
    echo "accountcreate testacjs testacjs 5" > "$ACE_DIR/console.fifo"
    sleep 3
  fi
  # testacjs3 is the retail-A/B account (tools/retail-ab-scenes.ts ACCOUNT):
  # its scenes @telepoi/@teleloc, so it must be an admin too. Left to ACE's
  # auto-create it came up at access level 0 and every teleport was ignored.
  if ! mysql -N -e "SELECT COUNT(*) FROM ace_auth.account WHERE accountName='testacjs3'" | grep -q 1; then
    echo "accountcreate testacjs3 testacjs3 5" > "$ACE_DIR/console.fifo"
    sleep 3
  fi
fi
echo "[ace-stack] ready — ACE on udp://127.0.0.1:9000/9001, logs at $ACE_DIR/ace.log"
