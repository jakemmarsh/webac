#!/usr/bin/env bash
# mem-watchdog.sh — safety net while agents work unattended (2026-09-30: parallel
# test runs crashed a 36 GB Mac). Every 10 s: read available memory
# (vm_stat free+inactive+speculative+purgeable). Below WARN_GB it logs the top
# memory users; below KILL_GB it kills test/automation processes only — vitest
# workers and Playwright's headless Chromium — never the user's own browser,
# Docker, Vite or the bridge.
#   bash tools/mem-watchdog.sh [KILL_GB=3] [WARN_GB=6]   (log: /tmp/acjs-mem-watchdog.log)
KILL_GB=${1:-3}; WARN_GB=${2:-6}; LOG=/tmp/acjs-mem-watchdog.log
avail_gb() {
  vm_stat | awk '/page size of/ {ps=$8} /Pages free/ {f=$3} /Pages inactive/ {i=$3} /Pages speculative/ {s=$3} /Pages purgeable/ {p=$3}
    END {gsub(/\./,"",f); gsub(/\./,"",i); gsub(/\./,"",s); gsub(/\./,"",p); printf "%.1f", (f+i+s+p)*ps/1073741824}'
}
echo "$(date '+%F %T') watchdog start kill<${KILL_GB}G warn<${WARN_GB}G" >> "$LOG"
while true; do
  a=$(avail_gb)
  if awk "BEGIN{exit !($a < $WARN_GB)}"; then
    echo "$(date '+%F %T') avail ${a}G" >> "$LOG"
    ps -axo rss,pid,command | sort -rn | head -8 | awk '{printf "   %6d MB  %s %s\n", $1/1024, $2, substr($0, index($0,$3), 110)}' >> "$LOG"
  fi
  if awk "BEGIN{exit !($a < $KILL_GB)}"; then
    echo "$(date '+%F %T') avail ${a}G < ${KILL_GB}G — killing vitest + headless chromium" >> "$LOG"
    pkill -f 'node_modules/vitest' ; pkill -f 'chrome-headless-shell' ; pkill -f 'ms-playwright/chromium'
  fi
  sleep 10
done
