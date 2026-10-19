#!/usr/bin/env python3
"""Daily player traffic for playwebac.com, from the bridge's own log lines.

Per UTC day: visitors (addresses that reported anything from the page), NEW visitors
(first seen that day since launch), connected (got a character list), entered (reached
the world), and the busiest hours of new visitors. Our own addresses are left out.

Sources: the Railway-era archive (~/webac-archive/railway/bridge/*.jsonl, launch to the
AWS cutover 2026-10-16 22:19Z) and CloudWatch through tools/aws-logs.sh (--json).

  python3 tools/player-traffic.py                # launch to now
  python3 tools/player-traffic.py --since 72h    # CloudWatch window (archive still read for "new")
  python3 tools/player-traffic.py --hours 2026-10-19   # new visitors by hour for one day
"""
import argparse, collections, glob, json, os, subprocess, sys

OURS = {'70.20.41.171', '184.193.176.126', '187.13.182.116'}  # Jake / the AWS host / the cloud loop
ARCHIVE = os.path.expanduser('~/webac-archive/railway/bridge/*.jsonl')
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def events():
    for path in sorted(glob.glob(ARCHIVE)):
        with open(path) as f:
            for line in f:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if 'event' in o and 't' in o:
                    yield o


def cloudwatch(since):
    out = subprocess.run(['bash', os.path.join(REPO, 'tools/aws-logs.sh'), 'bridge', '--since', since, '--json'],
                         capture_output=True, text=True, cwd=REPO)
    if out.returncode != 0:
        sys.exit(f'aws-logs failed (expired login? run `aws login --profile webac`):\n{out.stderr[-400:]}')
    for line in out.stdout.splitlines():
        i = line.find('{')
        if i < 0:
            continue
        try:
            o = json.loads(line[i:])
        except ValueError:
            continue
        if 'event' in o and 't' in o:
            yield o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default='4d', help='CloudWatch window (AWS since 2026-10-16 22:19Z)')
    ap.add_argument('--hours', help='YYYY-MM-DD: new visitors by UTC hour that day')
    a = ap.parse_args()

    first_seen = {}
    day = collections.defaultdict(lambda: {'v': set(), 'c': set(), 'e': set()})
    new_by_hour = collections.defaultdict(collections.Counter)
    seen_keys = set()
    for o in [*events(), *cloudwatch(a.since)]:
        ip = o.get('ip')
        if not ip or ip in OURS or ip.startswith('10.') or ip.startswith('127.'):
            continue
        ev, out, t = o.get('event'), o.get('outcome'), o['t']
        key = (t, ev, ip, out)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        if ev not in ('client_preworld', 'client_world', 'session_open'):
            continue
        d = t[:10]
        if ip not in first_seen or t < first_seen[ip]:
            first_seen[ip] = t
        day[d]['v'].add(ip)
        if out == 'char_list':
            day[d]['c'].add(ip)
        if out == 'enter_ok':
            day[d]['e'].add(ip)
    for ip, t in first_seen.items():
        new_by_hour[t[:10]][t[11:13]] += 1

    if a.hours:
        h = new_by_hour.get(a.hours, {})
        print(f'new visitors by UTC hour, {a.hours}: ' + (' '.join(f'{k}h:{v}' for k, v in sorted(h.items())) or 'none'))
        return
    print('day         visitors  new  connected  entered')
    for d in sorted(day):
        new = sum(new_by_hour[d].values())
        print(f'{d}  {len(day[d]["v"]):8}  {new:3}  {len(day[d]["c"]):9}  {len(day[d]["e"]):7}')


if __name__ == '__main__':
    main()
