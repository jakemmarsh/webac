#!/usr/bin/env bash
# Install (or remove with --uninstall) the launchd job that runs
# tools/local-gpu-perf.sh on this Mac every night at 04:10 local time.
# A run missed while the Mac slept fires on the next wake.
# Log: ~/Library/Logs/acjs/gpu-perf.log
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.acjs.gpu-perf
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$PLIST"; echo "removed $LABEL"; exit 0
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
  <array><string>/bin/bash</string><string>$REPO/tools/local-gpu-perf.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$JOB_PATH</string><key>HOME</key><string>$HOME</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>10</integer></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/acjs/gpu-perf.launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/acjs/gpu-perf.launchd.log</string>
</dict>
</plist>
EOF
mkdir -p "$HOME/Library/Logs/acjs"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (daily 04:10) → $PLIST; run now with: launchctl kickstart gui/$(id -u)/$LABEL"
