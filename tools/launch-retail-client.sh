#!/usr/bin/env bash
# launch-retail-client.sh — run the real end-of-retail acclient.exe under Wine
# on a NATIVE x86_64 Linux host (no Docker), headless on Xvfb, against a local
# ACE server. First verified end-to-end 2026-09-08 in a Claude Code web
# container: the client logged into ACE (password verified, DDD interrogation
# passed) and rendered the retail character-select screen. Full write-up:
# docs/retail-client-hosting-findings.md ("2026-09-08 native x86_64" section).
#
# Prereqs (tools/provision-remote-env.sh + tools/provision-ace-stack.sh):
#   reference/client-eol/eor/acclient.exe   (EoR build 00.00.11.6096)
#   dat/client_portal.dat, dat/client_cell_1.dat, dat/client_local_English.dat
#   ACE listening on udp://127.0.0.1:9000 with the testacjs account
#
# Usage:
#   bash tools/launch-retail-client.sh                 # install + prefix + launch
#   AC_SCREENSHOT=/tmp/cs.png AC_WAIT=45 bash tools/launch-retail-client.sh
#   AC_HOST=127.0.0.1 AC_PORT=9000 AC_ACCOUNT=testacjs AC_PASSWORD=testacjs
#   AC_RESOLUTION=1600x900 (default) — in-world frame size; see step 4
#   AC_ENTER_WORLD=1 AC_TELELOC="0xA9B40019 84 7.1 94" AC_SCREENSHOT=/tmp/world.png \
#     bash tools/launch-retail-client.sh        # char-select → in-world → frame
#
# Relaunching while a previous client session is still live on ACE (kill via
# wineserver -k leaves it up until DefaultSessionTimeout) makes ACE boot the
# old session AND reject the new one ("Cannot have two accounts logged on");
# just relaunch once more — the second attempt logs straight in.
#
# HARD REQUIREMENT: genuine x86_64. Wine's ntdll aborts under QEMU user-mode
# emulation (Docker on Apple Silicon) — see the findings doc. This script
# refuses to run anywhere else.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="${AC_RUN_DIR:-$HOME/ac-run}"
export WINEARCH=win32 WINEPREFIX="${WINEPREFIX:-$HOME/.wine32}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-$(id -u)}"; mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
export DISPLAY="${DISPLAY:-:99}"
AC_HOST="${AC_HOST:-127.0.0.1}"; AC_PORT="${AC_PORT:-9000}"
AC_ACCOUNT="${AC_ACCOUNT:-testacjs}"; AC_PASSWORD="${AC_PASSWORD:-testacjs}"
AC_WAIT="${AC_WAIT:-40}"
AC_RESOLUTION="${AC_RESOLUTION:-1600x900}"
RES_W="${AC_RESOLUTION%x*}"; RES_H="${AC_RESOLUTION#*x}"

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "[retail-client] refusing: $(uname -m) is not x86_64 (Wine needs non-emulated x86_64)" >&2
  [[ "$(uname -s)" == Darwin ]] && echo "[retail-client] on a Mac use tools/launch-retail-client-mac.sh (native Wine, real GPU)" >&2
  exit 1
fi
if [[ -d /proc/sys/fs/binfmt_misc ]] && ls /proc/sys/fs/binfmt_misc/ 2>/dev/null | grep -qi qemu; then
  echo "[retail-client] refusing: qemu binfmt handlers registered — this looks like an emulated container" >&2; exit 1
fi

# AC_EXE overrides the binary (e.g. reference/client-eol/acclient.exe, the
# ac1_sep13 build the decomp came from); AC_DAT_DIR a directory holding the
# three DATs (e.g. a copy with a patched layout property, for A/B probes).
EXE="${AC_EXE:-$REPO/reference/client-eol/eor/acclient.exe}"
[[ -f "$EXE" ]] || EXE="$REPO/reference/client-eol/acclient.exe"
DAT_DIR="${AC_DAT_DIR:-$REPO/dat}"
[[ -f "$EXE" ]] || { echo "[retail-client] acclient.exe missing — run tools/provision-remote-env.sh" >&2; exit 1; }
for f in client_portal.dat client_cell_1.dat client_local_English.dat; do
  [[ -f "$DAT_DIR/$f" ]] || { echo "[retail-client] $DAT_DIR/$f missing — run tools/provision-remote-env.sh" >&2; exit 1; }
done

# --- 1. Wine (WineHQ stable, i386 multiarch) + Xvfb + Mesa software GL --------
if ! command -v wine >/dev/null 2>&1; then
  echo "[retail-client] installing winehq-stable (i386 multiarch)…"
  export DEBIAN_FRONTEND=noninteractive
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-noble}")"
  dpkg --add-architecture i386
  apt-get update -qq
  apt-get install -y -qq wget gnupg2 ca-certificates curl
  mkdir -pm755 /etc/apt/keyrings
  wget -q -O /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key
  wget -qNP /etc/apt/sources.list.d/ "https://dl.winehq.org/wine-builds/ubuntu/dists/$CODENAME/winehq-$CODENAME.sources"
  apt-get update -qq
  if ! apt-get install -y -qq --install-recommends winehq-stable; then
    # Multiarch needs libgd3:amd64 and libgd3:i386 at the SAME version. The
    # Claude web container ships a deb.sury.org libgd3 (for php-gd) with no
    # i386 twin; pin both to the distro version (verified 2026-09-08).
    GD_VER="$(apt-cache policy libgd3:i386 | awk '/Candidate:/{print $2}')"
    echo "[retail-client] retrying with libgd3 pinned to $GD_VER on both arches…"
    apt-get install -y -qq --allow-downgrades "libgd3=$GD_VER" "libgd3:i386=$GD_VER" winehq-stable
  fi
fi
export DEBIAN_FRONTEND=noninteractive
# Guard on every tool, not just xvfb: the web container pre-installs Xvfb but
# not x11-utils/xdotool/imagemagick, and a bare `dpkg -s xvfb` skipped them all
# (xdpyinfo: command not found, 2026-09-08 world-entry run).
for p in xvfb x11-utils x11-apps imagemagick xdotool; do
  dpkg -s "$p" >/dev/null 2>&1 || apt-get install -y -qq "$p"
done
dpkg -s libgl1-mesa-dri:i386 >/dev/null 2>&1 || apt-get install -y -qq libgl1-mesa-dri mesa-utils libgl1:i386 libgl1-mesa-dri:i386 libglx-mesa0:i386
[[ -f /usr/i686-w64-mingw32/lib/zlib1.dll ]] || apt-get install -y -qq libz-mingw-w64
echo "[retail-client] $(wine --version)"

# --- 2. 32-bit prefix (the decisive step that dies under QEMU) ---------------
if [[ ! -f "$WINEPREFIX/system.reg" ]]; then
  echo "[retail-client] creating win32 prefix at $WINEPREFIX…"
  # mscoree/mshtml off: otherwise wineboot pops the Wine Mono / Gecko
  # installer dialogs, which sit on the Xvfb screen over the client
  # (2026-10-05, Wine 11.0).
  WINEDLLOVERRIDES="mscoree,mshtml=" WINEDEBUG=-all wineboot --init </dev/null >/dev/null 2>&1
fi

# --- 3. Xvfb with GLX (llvmpipe) --------------------------------------------
if ! xdpyinfo >/dev/null 2>&1; then
  echo "[retail-client] starting Xvfb on $DISPLAY…"
  Xvfb "$DISPLAY" -screen 0 "${AC_RESOLUTION}x24" +extension GLX >/tmp/xvfb.log 2>&1 &
  sleep 2
  xdpyinfo >/dev/null
fi

# --- 4. Stage the client dir: exe + zlib1.dll + DATs + windowed prefs ----------
# zlib1.dll shipped in the retail install dir and is NOT in the reference
# bundle; the mingw build is a drop-in. corestrings.dll (retail's string-
# resource DLL) is also absent: error dialogs then show "<corestrings.dll not
# found. Tried to print stringID N>" instead of text — harmless once running.
mkdir -p "$RUN_DIR"
cp -f "$EXE" "$RUN_DIR/acclient.exe"
cp -f /usr/i686-w64-mingw32/lib/zlib1.dll "$RUN_DIR/zlib1.dll"
for f in client_portal.dat client_cell_1.dat client_local_English.dat; do ln -sfn "$DAT_DIR/$f" "$RUN_DIR/$f"; done
#
# Display (re-verified 2026-09-25, findings doc "resolution control"): the
# client reads and rewrites %USERPROFILE%\Documents\Asheron's Call\
# UserPreferences.ini — NOT a file next to the exe — and stores the mode as a
# string (`Resolution=1024x768`, its default; `FullScreen=True`). The
# resolution must be a mode d3d9 enumerates, and Xvfb exposes exactly one (its
# screen size), so fullscreen dies with error strings 11 then 128
# (RenderDeviceD3D::DetectDisplayFormats / SetupDisplayInfo) as soon as the
# pre-world screen asks for 800x600. A Wine virtual desktop the size of the
# Xvfb screen advertises the standard mode list: pre-world then runs 800x600
# and the world comes up fullscreen at AC_RESOLUTION, filling the frame with
# the full HUD. (Windowed also runs, but its 29 px title bar pushes the HUD's
# bottom rows off an Xvfb screen of the same size.)
if [[ -n "$(xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2}' | grep -vx "$AC_RESOLUTION")" ]]; then
  echo "[retail-client] warning: Xvfb on $DISPLAY is not $AC_RESOLUTION — the world frame will not fill it" >&2
fi
WINEDEBUG=-all wine reg add 'HKCU\Software\Wine\Explorer' /v Desktop /d Default /f </dev/null >/dev/null 2>&1
WINEDEBUG=-all wine reg add 'HKCU\Software\Wine\Explorer\Desktops' /v Default /d "$AC_RESOLUTION" /f </dev/null >/dev/null 2>&1
PREFS_DIR="$WINEPREFIX/drive_c/users/$(id -un)/Documents/Asheron's Call"
mkdir -p "$PREFS_DIR"
if [[ -f "$PREFS_DIR/UserPreferences.ini" ]]; then
  sed -i "s/^Resolution=.*/Resolution=$AC_RESOLUTION/; s/^FullScreen=.*/FullScreen=True/" "$PREFS_DIR/UserPreferences.ini"
else
  printf '[Display]\r\nResolution=%s\r\nFullScreen=True\r\n' "$AC_RESOLUTION" > "$PREFS_DIR/UserPreferences.ini"
fi

# --- 5. Launch -----------------------------------------------------------------
# Flags per the client's own usage text (printed when launched with no args):
#   -h host  -p port  -a account  -v password  --rodat (open DATs read-only)
# (Client::BuildCommandLineArgs @ 004120c0 registers the same set.) The DATs
# are symlinks into dat/: a 2026-09-25 run saw the client bump the mtimes of
# client_portal.dat / client_local_English.dat on its first launches even
# with -rodat, contents byte-identical to the bundle zip (cmp) — harmless, but
# restore the mtimes if a tool keys on them.
echo "[retail-client] launching against $AC_HOST:$AC_PORT as $AC_ACCOUNT…"
cd "$RUN_DIR"
# </dev/null + the redirect: Wine's wineserver / explorer.exe (virtual
# desktop) daemons otherwise inherit this script's stdout, so a caller piping
# it (`| tail`) blocks forever after the script exits.
# The virtual desktop is requested on the command line (explorer /desktop):
# Wine 9+ ignores the Explorer\Desktop registry key above for a plain
# `wine app.exe`, and WineHQ stable is 11.0 since 2026-10. Without the desktop
# the client sees only Xvfb's one mode and dies with error string 128
# (2026-10-05). The key stays for older Wines; the flag works on all of them.
WINEDEBUG="${WINEDEBUG:--all}" wine explorer "/desktop=Default,$AC_RESOLUTION" ./acclient.exe -h "$AC_HOST" -p "$AC_PORT" -a "$AC_ACCOUNT" -v "$AC_PASSWORD" --rodat < /dev/null > "$RUN_DIR/acclient.stdout" 2>&1 &
sleep "$AC_WAIT"
# `wine explorer` hands the client to the desktop process and returns, so the
# launched pid says nothing; the client is alive while acclient.exe runs.
if ! pgrep -x acclient.exe >/dev/null; then
  echo "[retail-client] client exited early; output:"; cat "$RUN_DIR/acclient.stdout"; exit 1
fi
WID="$(xdotool search --name "^Asheron's Call$" | head -1 || true)"
echo "[retail-client] window id: ${WID:-none}"

# --- 6. Optional: drive char-select → in-world (AC_ENTER_WORLD=1) -------------
# Verified 2026-09-08 (findings doc, "world entry" section). Click coordinates
# are window-relative in the 800x600 pre-world window: the first row of the
# Characters list, then the ENTER disc. The account's first character is used;
# create one beforehand with `-r <name>` or ACE's console if the shard is empty.
# On world entry the client re-creates its window at AC_RESOLUTION (step 4;
# before 2026-09-25 this was pinned at 1024x768 because the prefs were staged
# in the wrong file).
#   AC_WORLD_WAIT   max seconds to wait for the in-world window after ENTER (default 120)
#   AC_WORLD_SETTLE seconds to let it settle once it is up (default 10)
#   AC_TELELOC      "cell x y z" — typed as @teleloc into chat (admin account)
#   AC_TELEPOI      a POI name (e.g. Yaraq) — typed as @telepoi, after AC_TELELOC
#   AC_DISMISS_WELCOME=0 to skip clicking OK on the first-login welcome popup
if [[ "${AC_ENTER_WORLD:-0}" == "1" && -n "$WID" ]]; then
  echo "[retail-client] entering world…"
  xdotool mousemove --window "$WID" 120 221 click 1; sleep 1
  xdotool mousemove --window "$WID" 343 393 click 1
  # Wait for the in-world window: it comes up at AC_RESOLUTION once the
  # landblock has loaded. A fixed 20 s was too short for llvmpipe on a cold
  # container (the window was still the 800x600 pre-world one, 2026-10-05).
  # World entry may DESTROY the pre-world window and create a new one (new XID,
  # BadWindow on the old one under set -e, 2026-09-25), or resize it in place
  # (inside an `explorer /desktop`), so re-find it on every poll.
  deadline=$((SECONDS + ${AC_WORLD_WAIT:-120}))
  while :; do
    WID="$(xdotool search --onlyvisible --name "^Asheron's Call$" | head -1 || true)"
    if [[ -n "$WID" ]] && xdotool getwindowgeometry "$WID" 2>/dev/null | grep -q "Geometry: ${RES_W}x${RES_H}"; then break; fi
    if (( SECONDS >= deadline )); then
      echo "[retail-client] no ${AC_RESOLUTION} in-world window after ENTER; output:"; tail -20 "$RUN_DIR/acclient.stdout"; exit 1
    fi
    sleep 2
  done
  sleep "${AC_WORLD_SETTLE:-10}"   # the first frames after the resize are still streaming terrain
  if [[ "${AC_DISMISS_WELCOME:-1}" == "1" ]]; then
    # First login only (ACE WorldManager: TotalLogins <= 1) shows a modal
    # "Welcome to Asheron's Call!" popup; its OK sits at (W/2-1, H/2+44):
    # (511,428) at 1024x768, (799,494) at 1600x900 (both measured). When the popup is absent the click lands on whatever
    # is under it — usually the player model, which merely selects it (the
    # toolbar then shows the self-target); set AC_DISMISS_WELCOME=0 to avoid.
    xdotool mousemove --window "$WID" $((RES_W / 2 - 1)) $((RES_H / 2 + 44)) click 1; sleep 1
  fi
  # Park the cursor over open sky, clear of the HUD and the player: left on the
  # player (the welcome click above) it hovers retail's name tag over every
  # later frame, which ours, whose cursor is not there, never draws (2026-10-05).
  xdotool mousemove --window "$WID" $((RES_W * 5 / 8)) $((RES_H / 12))
  if [[ -n "${AC_TELELOC:-}" ]]; then
    xdotool key Return; sleep 1   # Return focuses the chat entry at any size
    xdotool type --delay 40 "@teleloc $AC_TELELOC"; xdotool key Return
    sleep 15   # landblock load + teleport particle fade
  fi
  if [[ -n "${AC_TELEPOI:-}" ]]; then
    xdotool key Return; sleep 1
    xdotool type --delay 40 "@telepoi $AC_TELEPOI"; xdotool key Return
    sleep 25   # llvmpipe needs longer than @teleloc's 15 s for a town's first frame
  fi
  echo "[retail-client] in-world window: $(xdotool getwindowgeometry "$WID" | tr '\n' ' ')"
fi

if [[ -n "${AC_SCREENSHOT:-}" && -n "$WID" ]]; then
  # Grab the root window, cropped to the client: `import -window <client>`
  # hung indefinitely on the virtual-desktop child window (2026-09-25).
  read -r GX GY GW GH < <(xdotool getwindowgeometry --shell "$WID" | awk -F= '/^X=/{x=$2}/^Y=/{y=$2}/^WIDTH=/{w=$2}/^HEIGHT=/{h=$2}END{print x, y, w, h}')
  import -window root -crop "${GW}x${GH}+${GX}+${GY}" +repage "$AC_SCREENSHOT"
  echo "[retail-client] screenshot: $AC_SCREENSHOT"
fi
echo "[retail-client] client running. Stop with: WINEPREFIX=$WINEPREFIX wineserver -k"
