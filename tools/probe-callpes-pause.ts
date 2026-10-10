/**
 * probe-callpes-pause — DECOMP.callpes-random-pause live check. A CallPES
 * hook plays its nested script after Random::RollDice(0, pause) on the
 * object's clock (CPhysicsObj::CallPES @ 00511af0 queues a CALL_PES FPHook;
 * FPHook::Execute @ 0051baa0 fires CallPESInternal @ 00511ac0 at fraction 1),
 * so a self-calling loop such as a portal's hum (0x330006DA) recurs at
 * irregular intervals, not in lockstep every `pause` seconds.
 *
 * Patches PhysicsScriptPlayer.prototype (the module instance the client runs,
 * via Vite's dev-server URL) to record every CallPES wait the player queues
 * (hook duration vs the DAT pause) and every time a queued CallPES fires.
 * Then stands at the POI and checks the waits lie in [0, pause], spread out
 * rather than all equal to the pause.
 *
 * Portal hums (0x330006DA) and the lifestone (0x330003CC) CallPES with pause 0,
 * so they loop in lockstep in retail too; spawn a paused loop with --create.
 *
 *   npx tsx tools/probe-callpes-pause.ts [--poi holtburg|none] [--create 7473] [--ms 60000] [--out verification/callpes-pause]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, telepoi, adminCommand, shot } from './lib/game-session.js';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const POI = arg('poi') ?? 'holtburg';
const MS = Number(arg('ms') ?? 60000);
const OUT = arg('out') ?? 'verification/callpes-pause';
/** A weenie to `@create` beside the player, e.g. 7473 firespurt11 (Setup 0x020006A9 → 0x33000788: CallPES itself at 4 s, pause 11). */
const CREATE = arg('create');

const HOOK = `(async () => {
  const mod = await import('/src/effects/PhysicsScriptPlayer.ts');
  const rec = window.__cp = { queued: [], fired: [] };
  const P = mod.PhysicsScriptPlayer.prototype;
  rec.plays = {};
  const origPlay = P.play;
  P.play = function (script, anchor) {
    const k = '0x' + (script.id >>> 0).toString(16);
    rec.plays[k] = (rec.plays[k] || 0) + 1;
    return origPlay.call(this, script, anchor);
  };
  const origFp = P.processFpHook;
  P.processFpHook = function (anchor, h, value) {
    if (h.kind === 'callPES') {
      const st = this.states.get(anchor);
      if (!h.__seen) {
        h.__seen = true;
        rec.queued.push({ anchor: anchor.uuid, name: anchor.name || '', pes: '0x' + (h.script.id >>> 0).toString(16),
          wait: +h.duration.toFixed(4), created: +h.created.toFixed(3) });
      }
      if (value >= 1) rec.fired.push({ anchor: anchor.uuid, pes: '0x' + (h.script.id >>> 0).toString(16),
        clock: st ? +st.clock.toFixed(3) : null, t: performance.now() });
    }
    return origFp.call(this, anchor, h, value);
  };
  return true;
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'probe-callpes-pause', settleMs: 5000, createCharacter: arg('create-char') ?? 'Callpesprobe' });
  const { page } = s;
  await page.evaluate(HOOK);
  if (POI !== 'none') await telepoi(page, POI);
  if (CREATE) await adminCommand(page, `@create ${CREATE}`);
  await page.waitForTimeout(MS);
  await shot(page, `${OUT}/scene.png`);
  const rec = await page.evaluate('window.__cp') as { plays: Record<string, number>; queued: Array<{ anchor: string; pes: string; wait: number }>; fired: Array<{ anchor: string; pes: string; t: number }> };
  const byPes = new Map<string, number[]>();
  for (const q of rec.queued) { const a = byPes.get(q.pes) ?? []; a.push(q.wait); byPes.set(q.pes, a); }
  const perScript = [...byPes].map(([pes, w]) => {
    const sorted = [...w].sort((a, b) => a - b);
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    return { pes, n: w.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1],
      mean: +mean.toFixed(4), distinct: new Set(w).size };
  });
  // Interval between consecutive firings of the same loop on one anchor (wall clock).
  const lastT = new Map<string, number>(); const intervals: number[] = [];
  for (const f of rec.fired) { const k = f.anchor + f.pes; const p = lastT.get(k); if (p !== undefined) intervals.push((f.t - p) / 1000); lastT.set(k, f.t); }
  const summary = { poi: POI, create: CREATE ?? null, ms: MS, queued: rec.queued.length, fired: rec.fired.length,
    anchors: new Set(rec.queued.map((q) => q.anchor)).size, perScript,
    plays: rec.plays,
    loopIntervals: intervals.length ? { n: intervals.length, min: +Math.min(...intervals).toFixed(3), max: +Math.max(...intervals).toFixed(3) } : null };
  writeFileSync(`${OUT}/result.json`, JSON.stringify({ summary, queued: rec.queued, fired: rec.fired }, null, 2));
  console.log(JSON.stringify(summary, null, 1));
  await s.browser.close();
  process.exit(rec.queued.length > 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
