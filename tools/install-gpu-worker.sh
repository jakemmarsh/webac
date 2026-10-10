#!/usr/bin/env bash
# Install (or remove with --uninstall) the launchd job that runs
# tools/gpu-worker.sh (the real-GPU job queue, docs/gpu-worker.md) every 30 min.
# launchd does not run it while the Mac sleeps; the next interval after wake does.
# Log: ~/Library/Logs/acjs/gpu-worker.log (per-job logs in gpu-worker/)
#
# launchd runs ~/Applications/ACJS GPU Worker.app (tools/gpu-worker-host.swift),
# not /bin/bash, so retail-ab jobs can be granted Accessibility, Screen
# Recording and Automation (System Events) without granting them to every bash
# script. Grant the first two in System Settings → Privacy & Security, then run
# --probe-retail at the Mac: it asks for Automation (click OK) and checks all three.
#   bash tools/install-gpu-worker.sh [--uninstall | --probe-retail]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.acjs.gpu-worker
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

APP="$HOME/Applications/ACJS GPU Worker.app"
HOST="$APP/Contents/MacOS/acjs-gpu-worker"

if [[ "${1:-}" == "--probe-retail" ]]; then
  # One-shot launchd job running the host with --probe: the same process chain
  # (launchd → app → child) a retail-ab job gets. ACJS_ASK_AUTOMATION makes
  # the driver raise the Automation consent dialog instead of only checking:
  # unattended jobs must never raise it (nobody answers; 2026-10-04).
  out="$(mktemp)"; probe="$HOME/Library/LaunchAgents/com.acjs.gpu-worker-probe.plist"
  cat >"$probe" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.acjs.gpu-worker-probe</string>
  <key>ProgramArguments</key><array><string>$HOST</string><string>$REPO</string><string>--probe</string></array>
  <key>StandardOutPath</key><string>$out</string><key>StandardErrorPath</key><string>$out</string>
  <key>EnvironmentVariables</key><dict><key>ACJS_ASK_AUTOMATION</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST_EOF
  launchctl bootstrap "gui/$(id -u)" "$probe"
  for _ in $(seq 1 120); do [[ -s "$out" ]] && break; sleep 1; done
  launchctl bootout "gui/$(id -u)/com.acjs.gpu-worker-probe" 2>/dev/null || true; rm -f "$probe"
  echo "retail driver under launchd: $(cat "$out")"; grep -qx ok "$out"; exit $?
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$PLIST"; echo "removed $LABEL"; exit 0
fi

# The host app. An ad-hoc signature's identity is its code hash, which covers
# Info.plist too, so a rebuild drops the privacy grants: rebuild only when the
# source or the Info.plist below changes.
# NSAppleEventsUsageDescription: without it macOS denies the Automation request
# (System Events, used to raise the retail client) silently, with no dialog
# (2026-10-04: every retail-ab job died "client is not frontmost").
SRC="$REPO/tools/gpu-worker-host.swift"
# The source hash lives outside the bundle: codesign refuses a stray file in Contents/.
SUM_FILE="$HOME/Library/Caches/acjs/gpu-worker-host.sha256"
INFO_PLIST='<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.acjs.gpu-worker-host</string>
  <key>CFBundleName</key><string>ACJS GPU Worker</string>
  <key>CFBundleExecutable</key><string>acjs-gpu-worker</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Brings the retail Asheron&apos;s Call client to the front for retail A/B captures.</string>
</dict></plist>'
SUM="$( { cat "$SRC"; printf '%s' "$INFO_PLIST"; } | shasum -a 256 | cut -d' ' -f1)"
if [[ ! -x "$HOST" || "$(cat "$SUM_FILE" 2>/dev/null)" != "$SUM" ]]; then
  rm -f "$APP/Contents/source.sha256"; mkdir -p "$APP/Contents/MacOS" "$(dirname "$SUM_FILE")"
  swiftc -O "$SRC" -o "$HOST"
  printf '%s\n' "$INFO_PLIST" >"$APP/Contents/Info.plist"
  codesign --force --sign - --identifier com.acjs.gpu-worker-host "$APP"
  echo "$SUM" >"$SUM_FILE"
  echo "built $APP: grant it Accessibility + Screen Recording, then run --probe-retail at the Mac for Automation"
fi

# launchd starts jobs with a bare PATH (no nvm/fnm/homebrew), so bake in the
# directories of the node, docker and git this shell resolves right now.
JOB_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
for tool in node docker git; do
  d="$(dirname "$(command -v "$tool" 2>/dev/null || echo /usr/bin/x)")"
  case ":$JOB_PATH:" in *":$d:"*) ;; *) JOB_PATH="$d:$JOB_PATH" ;; esac
done

mkdir -p "$(dirname "$PLIST")"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$HOST</string><string>$REPO</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$JOB_PATH</string><key>HOME</key><string>$HOME</string></dict>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/acjs/gpu-worker.launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/acjs/gpu-worker.launchd.log</string>
</dict>
</plist>
EOF
mkdir -p "$HOME/Library/Logs/acjs"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (every 30 min) → $PLIST; run now with: launchctl kickstart gui/$(id -u)/$LABEL"
