/**
 * BOOT.side-tables-off-critical-path — the weenie side-files no longer
 * serialize boot (production telemetry 2026-10-13: a cold-edge visitor sat
 * ~25 s in boot stage `side_tables`). Drives the real boot/WeenieSideTables
 * module with fake fetches that resolve, 404, hang and land late, and the
 * era DAT probe plan (EraBoot.planEraDats) that now probes roles in parallel.
 */
import { describe, it, expect } from 'vitest';
import {
  startWeenieSideTables, skippedWeenieSideTables, WEENIE_SIDE_TABLES, SIDE_TABLE_WAIT_MS,
} from '../packages/renderer/src/boot/WeenieSideTables';
import { planEraDats } from '../packages/renderer/src/era/EraBoot';
import { ERA_PROFILES, ownRoles } from '../packages/renderer/src/era/EraProfiles';
import { unsupportedFeatures } from '../packages/renderer/src/era/EraFeatures';
import { resolveRuntimeConfig, assetUrl } from '../packages/renderer/src/config/RuntimeConfig';
import { BOOT_STAGES } from '../packages/renderer/src/telemetry/PreworldReporter';
import { BOOT_STAGES as BRIDGE_BOOT_STAGES } from '../services/ws-tcp-bridge/src/clientPreworld';

type FakeResp = { ok: boolean; status: number; json: () => Promise<unknown> };
const ok = (body: unknown): FakeResp => ({ ok: true, status: 200, json: async () => body });
const notFound: FakeResp = { ok: false, status: 404, json: async () => { throw new Error('no body'); } };

const BODIES: Record<string, unknown> = {
  '/weenie-combat-styles.json': { 306: 0x10, 30310: 0x20 },
  '/weenie-attack-types.json': { 1: 2, 2: 4, 3: 6 },
  '/weenie-weapon-time.json': { 1: 35 },
};

/** A fetch whose answer per URL the test controls; records call order. */
function controlledFetch() {
  const calls: string[] = [];
  const resolvers = new Map<string, (r: FakeResp) => void>();
  const fetchFn = (url: string) => {
    calls.push(url);
    return new Promise<FakeResp>((res) => resolvers.set(url, res));
  };
  return { calls, fetchFn, answer: (url: string, r: FakeResp) => resolvers.get(url)!(r) };
}

const quietLog = () => {
  const lines: string[] = [];
  return { lines, log: { log: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`) } };
};
const url = (p: string) => `https://dats.example/v1/raw/set${p}`;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('BOOT.side-tables-off-critical-path: weenie side-tables', () => {
  it('starts all three fetches at once, before any answers (parallel, not serial)', async () => {
    const f = controlledFetch();
    const { log } = quietLog();
    const t = startWeenieSideTables({ url, fetchFn: f.fetchFn, log });
    expect(f.calls).toEqual(WEENIE_SIDE_TABLES.map((s) => url(s.path)));
    for (const s of WEENIE_SIDE_TABLES) f.answer(url(s.path), ok(BODIES[s.path]));
    expect(await t.waitForBoot()).toBe(true);
    expect(t.combatStyles.get(306)).toBe(0x10);
    expect(t.combatStyles.get(30310)).toBe(0x20);
    expect(t.attackTypes.size).toBe(3);
    expect(t.weaponTimes.get(1)).toBe(35);
    expect(t.status()).toEqual({ combatStyles: 'loaded', attackTypes: 'loaded', weaponTimes: 'loaded' });
  });

  it('a hung table stops holding boot at the bound; it applies to the same Map when it lands late', async () => {
    const f = controlledFetch();
    const q = quietLog();
    const t = startWeenieSideTables({ url, fetchFn: f.fetchFn, log: q.log });
    f.answer(url('/weenie-combat-styles.json'), ok(BODIES['/weenie-combat-styles.json']));
    f.answer(url('/weenie-weapon-time.json'), ok(BODIES['/weenie-weapon-time.json']));
    const attackTypes = t.attackTypes; // the reference main() closes over
    const t0 = Date.now();
    expect(await t.waitForBoot(40)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(t.status().attackTypes).toBe('pending');
    expect(attackTypes.get(1)).toBeUndefined(); // the lookup's default applies meanwhile
    expect(q.lines.some((l) => l.startsWith('WARN') && l.includes('weenie-attack-types.json') && l.includes('thrust/slash'))).toBe(true);
    // Lands after boot moved on.
    f.answer(url('/weenie-attack-types.json'), ok(BODIES['/weenie-attack-types.json']));
    await t.settled;
    expect(attackTypes.get(1)).toBe(2);
    expect(t.status().attackTypes).toBe('loaded');
    expect(q.lines.some((l) => l.includes('attackType entries') && l.includes('applied now'))).toBe(true);
  });

  it('the bound counts from when the fetches began: a boot past it does not wait at all', async () => {
    let clock = 0;
    const f = controlledFetch();
    const { log } = quietLog();
    const timers: number[] = [];
    const t = startWeenieSideTables({
      url, fetchFn: f.fetchFn, log, now: () => clock,
      setTimer: (fn, ms) => { timers.push(ms); return setTimeout(fn, ms); },
    });
    clock = SIDE_TABLE_WAIT_MS + 12_000; // a 20 s cold patch download
    expect(await t.waitForBoot()).toBe(false);
    expect(timers).toEqual([0]);
    clock = 0;
    const f2 = controlledFetch();
    const timers2: number[] = [];
    const t2 = startWeenieSideTables({ url, fetchFn: f2.fetchFn, log, now: () => clock, setTimer: (fn, ms) => { timers2.push(ms); return setTimeout(fn, ms); } });
    clock = 3000; // a warm boot reached side_tables 3 s in: at most 5 s more
    const waiting = t2.waitForBoot();
    expect(timers2).toEqual([SIDE_TABLE_WAIT_MS - 3000]);
    for (const s of WEENIE_SIDE_TABLES) f2.answer(url(s.path), ok(BODIES[s.path]));
    expect(await waiting).toBe(true);
  });

  it('a 404 or a network error is "missing" with the old fallback, and does not hold boot', async () => {
    const q = quietLog();
    const t = startWeenieSideTables({
      url, log: q.log,
      fetchFn: async (u) => {
        if (u.endsWith('combat-styles.json')) return notFound;
        if (u.endsWith('attack-types.json')) throw new TypeError('Failed to fetch');
        return ok(BODIES['/weenie-weapon-time.json']);
      },
    });
    expect(await t.waitForBoot()).toBe(true);
    expect(t.status()).toEqual({ combatStyles: 'missing', attackTypes: 'missing', weaponTimes: 'loaded' });
    expect(t.combatStyles.size).toBe(0);
    expect(q.lines).toContain('WARN [AC] weenie-combat-styles.json not loaded (HTTP 404) — bow/crossbow routing will fall back to RightHand');
    expect(q.lines.some((l) => l.includes('weenie-attack-types.json not loaded (Failed to fetch)'))).toBe(true);
  });

  it('a body that is not JSON is missing, not a boot failure', async () => {
    const { log } = quietLog();
    const t = startWeenieSideTables({ url, log, fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }) });
    expect(await t.waitForBoot()).toBe(true);
    expect(Object.values(t.status())).toEqual(['missing', 'missing', 'missing']);
  });

  it('every era: end of retail and the classic eras fetch from the end-of-retail asset base; AC1999 skips them', async () => {
    const cfg = resolveRuntimeConfig({ assetBase: 'https://dats.playwebac.com/v1/raw/eor-2072' }, '', false);
    expect(assetUrl(cfg, WEENIE_SIDE_TABLES[0].path)).toBe('https://dats.playwebac.com/v1/raw/eor-2072/weenie-combat-styles.json');
    for (const id of Object.keys(ERA_PROFILES)) {
      const skip = unsupportedFeatures(ERA_PROFILES[id]).has('eolWcidTables');
      expect(skip, id).toBe(ERA_PROFILES[id].login.protocol === 'ac1999');
    }
    const s = skippedWeenieSideTables();
    expect(await s.waitForBoot()).toBe(true);
    expect(s.combatStyles.size + s.attackTypes.size + s.weaponTimes.size).toBe(0);
    expect(s.status().combatStyles).toBe('skipped');
  });

  it('side_tables stays a boot stage on the client and the bridge (old builds still send it)', () => {
    expect(BOOT_STAGES).toContain('side_tables');
    expect([...BRIDGE_BOOT_STAGES]).toEqual([...BOOT_STAGES]);
  });
});

describe('BOOT.side-tables-off-critical-path sweep: era DAT probes run per role in parallel', () => {
  it('every role\'s first HEAD is in flight before any answers; results keep role order and preference order', async () => {
    const p = ERA_PROFILES['classic-dereth'];
    const cfg = resolveRuntimeConfig({ eraAssetBases: { 'classic-dereth': 'https://cd.example.org/files/' } }, '', false);
    const pending: { u: string; res: (v: boolean) => void }[] = [];
    const plan = planEraDats(p, cfg, { headOk: (u) => new Promise<boolean>((res) => pending.push({ u, res })) });
    await tick();
    const roles = ownRoles(p);
    expect(roles.length).toBeGreaterThan(1);
    expect(pending.map((x) => x.u)).toEqual(roles.map(() => expect.stringContaining('https://cd.example.org/files/')));
    // The configured host misses for the first role only: that role falls back to /sets/.
    pending[0].res(false);
    for (const x of pending.slice(1)) x.res(true);
    await tick();
    const fallback = pending.find((x) => x.u.includes('/sets/classic-dereth/'))!;
    expect(fallback).toBeTruthy();
    fallback.res(false);
    const done = await plan;
    expect(done).toMatchObject({ missing: [roles[0]] });
    // All miss: missing names the roles in ownRoles order.
    expect(await planEraDats(p, cfg, { headOk: async () => false })).toMatchObject({ missing: roles });
  });
});
