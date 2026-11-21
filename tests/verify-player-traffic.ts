/**
 * tools/player-traffic.py --json, the data behind the /player-count skill (2026-11-21). Runs the real script on
 * saved bridge log lines (aws-logs text, the shape CloudWatch returns) and checks each count it reports.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../tools/player-traffic.py');
const COLDEVE = '26d9ec3d-9fbf-4fda-95f9-8d87e005ae3a';
const AC1999 = 'ac1999-world';
const line = (t: string, rest: string) => `${t.slice(0, 19)} [INFO]  t="${t}" ${rest}`;
const pre = (t: string, ip: string, outcome: string, extra = '') => line(t, `event="client_preworld" ip="${ip}" outcome="${outcome}" ${extra}`);
const enter = (t: string, ip: string, era: string, server: string) => pre(t, ip, 'enter_ok', `era="${era}" server="${server}"`);
const open = (t: string, ip: string, active: number) => line(t, `event="session_open" session=1 ip="${ip}" server=null active=${active}`);
const close = (t: string, ip: string, server: string | null, ms: number, active: number) =>
  line(t, `event="session_close" session=2 ip="${ip}" server=${server ? `"${server}"` : 'null'} reason="ws_close" durationMs=${ms} active=${active}`);

function report(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'player-traffic-'));
  try {
    const input = join(dir, 'lines.txt');
    writeFileSync(input, lines.join('\n') + '\n');
    const r = spawnSync('python3', [SCRIPT, '--input', input, '--no-archive', '--json'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return { json: JSON.parse(r.stdout), raw: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('player-traffic.py --json (the /player-count skill)', () => {
  const lines = [
    // day 1: A enters End of Retail on Coldeve, B only reaches the launcher
    open('2026-11-20T10:00:00.000Z', '1.1.1.1', 1),
    pre('2026-11-20T10:00:05.000Z', '1.1.1.1', 'char_list'),
    enter('2026-11-20T10:00:09.000Z', '1.1.1.1', 'eor', COLDEVE),
    pre('2026-11-20T11:00:00.000Z', '2.2.2.2', 'world_list'),
    close('2026-11-20T12:00:00.000Z', '1.1.1.1', COLDEVE, 2 * 3_600_000, 3),
    close('2026-11-20T12:00:01.000Z', '2.2.2.2', null, 5_000, 2), // a launcher session: not a game session
    // day 2: A comes back (AC1999), C is new (a Dark Majesty profile), our own address is left out
    enter('2026-11-21T21:00:00.000Z', '1.1.1.1', 'ac1999-retail', AC1999),
    enter('2026-11-21T21:05:00.000Z', '3.3.3.3', 'classic-dereth-1-0', COLDEVE),
    enter('2026-11-21T21:06:00.000Z', '70.20.41.171', 'eor', COLDEVE),
    enter('2026-11-21T21:05:00.000Z', '3.3.3.3', 'classic-dereth-1-0', COLDEVE), // a duplicate line counts once
    close('2026-11-21T22:00:00.000Z', '3.3.3.3', COLDEVE, 30 * 60_000, 4),
    close('2026-11-21T22:00:01.000Z', '3.3.3.3', COLDEVE, 30_000, 1), // under a minute: not a game session
  ];

  it('per-day visitors, new, returning, connected, entered, peak sessions and play time', () => {
    const { json } = report(lines);
    expect(json.days).toEqual([
      { day: '2026-11-20', visitors: 2, new: 2, returning: 0, connected: 1, entered: 1, peakSessions: 3, gameSessions: 1, playHours: 2, medianSessionMin: 120 },
      { day: '2026-11-21', visitors: 2, new: 1, returning: 1, connected: 0, entered: 2, peakSessions: 4, gameSessions: 1, playHours: 0.5, medianSessionMin: 30 },
    ]);
  });

  it('players by era group, by day and by world; entries by UTC hour; days played', () => {
    const { json } = report(lines);
    expect(json.byEra).toEqual({ 'End of Retail': 1, AC1999: 1, 'Dark Majesty': 1 });
    expect(json.eraByDay).toEqual([
      { day: '2026-11-20', era: 'End of Retail', players: 1 },
      { day: '2026-11-21', era: 'AC1999', players: 1 },
      { day: '2026-11-21', era: 'Dark Majesty', players: 1 },
    ]);
    // --input reads no live world list, so worlds are their id's first 8 characters
    expect(json.byWorld).toEqual([{ world: '26d9ec3d', players: 2 }, { world: 'ac1999-w', players: 1 }]);
    expect(json.enteredByUtcHour['10']).toBe(1);
    expect(json.enteredByUtcHour['21']).toBe(2);
    expect(json.daysPlayed).toEqual({ 1: 1, 2: 1 });
    expect(json.totals).toEqual({ players: 2, visitors: 3, playHours: 2.5 });
  });

  it('never prints an address', () => {
    expect(report(lines).raw).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
