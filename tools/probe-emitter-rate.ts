/**
 * probe-emitter-rate — DECOMP.emitter-backlog live check. Retail
 * ParticleEmitter::UpdateParticles @ 0051d180 calls ShouldEmitParticle once
 * per update and emits at most ONE particle, so an emitter whose birthrate
 * interval is shorter than the frame time loses density at low fps instead of
 * bunching a backlog of particles into one frame.
 *
 * Patches ParticleSystem.prototype.update (the module instance the client runs,
 * via Vite's dev-server URL) to record, per update, how many particles the
 * call emitted (totalEmittedCount delta, the constructor's initial burst
 * excluded), plus each emitter's birthrate and the frame dt. Then stands at a
 * POI (a fountain / portal / lifestone) and reports the max emissions per
 * update and, for emitters faster than the frame, emissions per update vs the
 * backlog an "emit dt / birthrate" drain would have made.
 *
 *   npx tsx tools/probe-emitter-rate.ts [--poi holtburg|none] [--ms 30000] [--create-char Name] [--out verification/emitter-rate]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, telepoi, shot } from './lib/game-session.js';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const POI = arg('poi') ?? 'holtburg';
const MS = Number(arg('ms') ?? 30000);
const OUT = arg('out') ?? 'verification/emitter-rate';

const HOOK = `(async () => {
  const mod = await import('/src/effects/ParticleSystem.ts');
  const rec = window.__er = { updates: 0, emissions: 0, maxPerUpdate: 0, multi: 0, fast: { updates: 0, emissions: 0, backlog: 0 }, emitters: {} };
  const P = mod.ParticleSystem.prototype;
  const orig = P.update;
  P.update = function (dt) {
    const before = this.totalEmittedCount;
    const r = orig.call(this, dt);
    if (this.isDegradedOut) return r;
    const n = this.totalEmittedCount - before;
    const info = this.emitterInfo;
    rec.updates++; rec.emissions += n;
    if (n > rec.maxPerUpdate) rec.maxPerUpdate = n;
    if (n > 1) rec.multi++;
    // per-second emitters (EmitterType 1) whose interval is under this frame's dt
    if (info.emitterType === 1 && info.birthrate > 0 && info.birthrate < dt) {
      rec.fast.updates++; rec.fast.emissions += n;
      rec.fast.backlog += Math.floor(dt / info.birthrate);
      const k = '0x' + ((info.id ?? 0) >>> 0).toString(16) + '@' + info.birthrate.toFixed(4);
      const e = rec.emitters[k] || (rec.emitters[k] = { birthrate: info.birthrate, updates: 0, emissions: 0, max: 0 });
      e.updates++; e.emissions += n; if (n > e.max) e.max = n;
    }
    return r;
  };
  rec.t0 = performance.now();
  return true;
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'probe-emitter-rate', settleMs: 5000, createCharacter: arg('create-char') ?? 'Emitterprobe' });
  const { page } = s;
  await page.evaluate(HOOK);
  if (POI !== 'none') await telepoi(page, POI);
  await page.waitForTimeout(MS);
  await shot(page, `${OUT}/scene.png`);
  const rec = await page.evaluate('({ ...window.__er, secs: (performance.now() - window.__er.t0) / 1000 })') as {
    updates: number; emissions: number; maxPerUpdate: number; multi: number; secs: number;
    fast: { updates: number; emissions: number; backlog: number }; emitters: Record<string, { birthrate: number; updates: number; emissions: number; max: number }>;
  };
  const summary = {
    poi: POI, ms: MS, updates: rec.updates, emissions: rec.emissions, maxEmissionsPerUpdate: rec.maxPerUpdate,
    updatesEmittingMoreThanOne: rec.multi,
    fasterThanFrame: { emitters: Object.keys(rec.emitters).length, ...rec.fast },
  };
  writeFileSync(`${OUT}/result.json`, JSON.stringify({ summary, emitters: rec.emitters }, null, 2));
  console.log(JSON.stringify(summary, null, 1));
  await s.browser.close();
  process.exit(rec.updates > 0 && rec.maxPerUpdate <= 1 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
