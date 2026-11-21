#!/usr/bin/env python3
"""Daily player traffic for playwebac.com, from the bridge's own log lines.

Per UTC day: visitors (addresses that reported anything from the page), NEW visitors
(first seen that day since launch), returning (seen on an earlier day), connected (got a
character list), entered (reached the world), peak open bridge sessions, game sessions
and their hours of play, and the busiest hours of new visitors. Our own addresses are
left out. Every count of people is a count of addresses (a household is one, a player
on two networks is two).

Sources: the Railway-era archive (~/webac-archive/railway/bridge/*.jsonl, launch to the
AWS cutover 2026-10-16 22:19Z) and CloudWatch through tools/aws-logs.sh (--json), read
with a filter for only the events counted here.

  python3 tools/player-traffic.py                # launch to now (CloudWatch: last 4 d)
  python3 tools/player-traffic.py --since 72h    # CloudWatch window (archive still read for "new")
  python3 tools/player-traffic.py --hours 2026-10-19   # new visitors by hour for one day
  python3 tools/player-traffic.py --since 30d --json   # everything above, plus by era, by world
                                                       # and by hour, as JSON (the /player-count skill)
  python3 tools/player-traffic.py --input lines.txt --no-archive --json   # from saved log lines (tests)
"""
import argparse, collections, glob, json, os, re, statistics, subprocess, sys, urllib.request
from datetime import datetime, timedelta, timezone

OURS = {'70.20.41.171', '184.193.176.126', '187.13.182.116', '187.14.125.31'}  # Jake / the AWS host / the cloud loop
ARCHIVE = os.path.expanduser('~/webac-archive/railway/bridge/*.jsonl')
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVERS_URL = 'https://bridge.playwebac.com/servers'
SNAPSHOT = os.path.join(REPO, 'tools/site/servers-snapshot.json')
COUNTED = ('client_preworld', 'client_world', 'session_open', 'session_close')
CW_FILTER = '{ ' + ' || '.join(f'$.event = "{e}"' for e in COUNTED) + ' }'


def era_name(era):
    """The era group a player picked: end of retail, the classic (Dark Majesty) profiles, or AC1999."""
    if era == 'eor':
        return 'End of Retail'
    if era.startswith('classic'):
        return 'Dark Majesty'
    if era.startswith('ac1999'):
        return 'AC1999'
    return era


def parse(line):
    """One log line (aws-logs JSON, the archive's JSON, or aws-logs text) as a dict, or None."""
    line = line.strip()
    i = line.find('{')
    if i >= 0:
        try:
            o = json.loads(line[i:])
            return o if 'event' in o and 't' in o else None
        except ValueError:
            pass
    if ' t="' not in line:
        return None
    o = {}
    for k, v in re.findall(r'(\w+)=("(?:[^"\\]|\\.)*"|\S+)', line):
        o[k] = json.loads(v) if v.startswith('"') else (None if v == 'null' else v)
    return o if 'event' in o and 't' in o else None


def archive():
    for path in sorted(glob.glob(ARCHIVE)):
        with open(path) as f:
            for line in f:
                o = parse(line)
                if o:
                    yield o


CACHE = os.path.expanduser('~/webac-archive/aws-traffic')  # outside the repo, like the Railway archive


def seconds(since):
    m = re.fullmatch(r'(\d+)([smhdw])', since)
    if not m:
        sys.exit(f'--since: expected e.g. 30d, 72h, 90m (got {since})')
    return int(m.group(1)) * {'s': 1, 'm': 60, 'h': 3600, 'd': 86400, 'w': 604800}[m.group(2)]


def fetch(since):
    out = subprocess.run(['bash', os.path.join(REPO, 'tools/aws-logs.sh'), 'bridge', '--since', since, '--json',
                          '--filter', CW_FILTER], capture_output=True, text=True, cwd=REPO)
    if out.returncode != 0:
        sys.exit(f'aws-logs failed (expired login? run `aws login --profile webac`):\n{out.stderr[-400:]}')
    return [o for o in map(parse, out.stdout.splitlines()) if o]


def cloudwatch(since, use_cache=True):
    """The counted events since `since`. A 30-day CloudWatch read takes over 10 minutes, so what was read is
    kept in CACHE (events.jsonl + meta.json: the span it covers) and a later run reads only the time after it."""
    now = datetime.now(timezone.utc).timestamp()
    need_from = now - seconds(since)
    events_path, meta_path = os.path.join(CACHE, 'events.jsonl'), os.path.join(CACHE, 'meta.json')
    try:
        meta = json.load(open(meta_path)) if use_cache else None
    except (OSError, ValueError):
        meta = None
    if meta and meta['from'] <= need_from + 3600:
        gap = max(5, int((now - meta['to']) / 60) + 5)  # minutes, with 5 of overlap (duplicates are dropped later)
        fresh = fetch(f'{gap}m')
        cached = [o for o in map(parse, open(events_path)) if o]
        span_from = meta['from']
    else:
        fresh, cached, span_from = fetch(since), [], need_from
    if use_cache:
        os.makedirs(CACHE, exist_ok=True)
        with open(events_path, 'a' if cached else 'w') as f:
            for o in fresh:
                f.write(json.dumps(o, separators=(',', ':')) + '\n')
        json.dump({'from': span_from, 'to': now}, open(meta_path, 'w'))
    start = datetime.fromtimestamp(need_from, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    for o in (*cached, *fresh):
        if str(o['t']) >= start:
            yield o


def server_names():
    """World id -> name: the bridge's live /servers, else the site's saved snapshot."""
    try:
        with urllib.request.urlopen(SERVERS_URL, timeout=10) as r:
            feed = json.load(r)
    except Exception:
        try:
            feed = json.load(open(SNAPSHOT))
        except Exception:
            return {}
    return {s['id'].lower(): s['name'] for s in feed.get('servers', []) if s.get('id')}


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def collect(source, window_start=None):
    """Aggregate the events. window_start (YYYY-MM-DD) limits the per-day rows, not first-seen."""
    first_seen = {}
    day = collections.defaultdict(lambda: {'v': set(), 'c': set(), 'e': set(), 'peak': 0, 'sessions': 0, 'ms': [],
                                           'era': collections.defaultdict(set), 'srv': collections.defaultdict(set)})
    enter_hours = collections.Counter()
    servers_all = collections.defaultdict(set)
    era_all = collections.defaultdict(set)
    entered_days = collections.defaultdict(set)
    seen_keys = set()
    for o in source:
        ip = o.get('ip')
        ev, out, t = o.get('event'), o.get('outcome'), str(o['t'])
        if ev not in COUNTED:
            continue
        key = (t, ev, ip, out, o.get('session'))
        if key in seen_keys:
            continue
        seen_keys.add(key)
        d = t[:10]
        active = num(o.get('active'))
        if active is not None and (not window_start or d >= window_start):
            day[d]['peak'] = max(day[d]['peak'], int(active))  # every session, ours included: the bridge's load
        if not ip or ip in OURS or ip.startswith('10.') or ip.startswith('127.'):
            continue
        if ev == 'session_close':
            if window_start and d < window_start:
                continue
            row = day[d]
            dur = num(o.get('durationMs'))
            if o.get('server') and dur and dur >= 60_000:  # a game session, not a launcher world-list probe
                row['sessions'] += 1
                row['ms'].append(dur)
            continue
        if ip not in first_seen or t < first_seen[ip]:
            first_seen[ip] = t
        if window_start and d < window_start:
            continue
        row = day[d]
        row['v'].add(ip)
        if out == 'char_list':
            row['c'].add(ip)
        if out == 'enter_ok':
            row['e'].add(ip)
            era = era_name(o.get('era') or 'unknown')
            srv = (o.get('server') or '?').lower()
            row['era'][era].add(ip)
            row['srv'][srv].add(ip)
            era_all[era].add(ip)
            servers_all[srv].add(ip)
            entered_days[ip].add(d)
            enter_hours[t[11:13]] += 1
    return first_seen, day, enter_hours, servers_all, era_all, entered_days


def report(first_seen, day, enter_hours, servers_all, era_all, entered_days, names):
    new_by_day = collections.Counter(t[:10] for t in first_seen.values())
    days = []
    for d in sorted(day):
        r = day[d]
        ms = r['ms']
        days.append({
            'day': d, 'visitors': len(r['v']), 'new': new_by_day.get(d, 0),
            'returning': sum(1 for ip in r['v'] if first_seen[ip][:10] < d),
            'connected': len(r['c']), 'entered': len(r['e']), 'peakSessions': r['peak'],
            'gameSessions': r['sessions'], 'playHours': round(sum(ms) / 3_600_000, 1),
            'medianSessionMin': round(statistics.median(ms) / 60_000) if ms else 0,
        })
    era_by_day = [{'day': d, 'era': era, 'players': len(ips)} for d in sorted(day) for era, ips in sorted(day[d]['era'].items())]
    worlds = sorted(({'world': names.get(s, s[:8]), 'players': len(ips)} for s, ips in servers_all.items()),
                    key=lambda w: -w['players'])
    regulars = collections.Counter(min(len(ds), 7) for ds in entered_days.values())
    return {
        'generatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'note': 'people = distinct addresses; peakSessions counts every open bridge session, launcher and ours included; '
                'playHours = the length of the game sessions that ended that day (a long session counts on its last day)',
        'days': days,
        'eraByDay': era_by_day,
        'byEra': {k: len(v) for k, v in sorted(era_all.items(), key=lambda kv: -len(kv[1]))},
        'byWorld': worlds,
        'enteredByUtcHour': {f'{h:02d}': enter_hours.get(f'{h:02d}', 0) for h in range(24)},
        'daysPlayed': {('7+' if n == 7 else str(n)): c for n, c in sorted(regulars.items())},
        'totals': {'players': len(entered_days), 'visitors': len({ip for r in day.values() for ip in r['v']}),
                   'playHours': round(sum(sum(r['ms']) for r in day.values()) / 3_600_000, 1)},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default='4d', help='CloudWatch window (AWS since 2026-10-16 22:19Z)')
    ap.add_argument('--hours', help='YYYY-MM-DD: new visitors by UTC hour that day')
    ap.add_argument('--json', action='store_true', help='the full report as JSON')
    ap.add_argument('--days', type=int, help='with --json: only the last N days of rows (first-seen still uses all)')
    ap.add_argument('--input', help='read log lines from this file instead of CloudWatch')
    ap.add_argument('--no-archive', action='store_true', help='skip the Railway-era archive')
    ap.add_argument('--no-cache', action='store_true', help='read CloudWatch afresh and leave the local cache alone')
    a = ap.parse_args()

    def source():
        if not a.no_archive:
            yield from archive()
        if a.input:
            with open(a.input) as f:
                for line in f:
                    o = parse(line)
                    if o:
                        yield o
        else:
            yield from cloudwatch(a.since, not a.no_cache)

    start = (datetime.now(timezone.utc) - timedelta(days=a.days - 1)).strftime('%Y-%m-%d') if a.days else None
    first_seen, day, enter_hours, servers_all, era_all, entered_days = collect(source(), start)

    if a.hours:
        h = collections.Counter(t[11:13] for t in first_seen.values() if t[:10] == a.hours)
        print(f'new visitors by UTC hour, {a.hours}: ' + (' '.join(f'{k}h:{v}' for k, v in sorted(h.items())) or 'none'))
        return
    if a.json:
        names = {} if a.input else server_names()
        print(json.dumps(report(first_seen, day, enter_hours, servers_all, era_all, entered_days, names), indent=1))
        return
    new_by_day = collections.Counter(t[:10] for t in first_seen.values())
    print('day         visitors  new  connected  entered')
    for d in sorted(day):
        r = day[d]
        if not r['v']:
            continue
        print(f'{d}  {len(r["v"]):8}  {new_by_day.get(d, 0):3}  {len(r["c"]):9}  {len(r["e"]):7}')


if __name__ == '__main__':
    main()
