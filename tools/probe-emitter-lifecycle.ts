/**
 * probe-emitter-lifecycle — live check for RECON.particle-decomp-divergences
 * (DECOMP.blocking-emitter-restarts, DECOMP.invented-emitter-maxage,
 * DECOMP.degraded-emitters-simulate), driven in the running client:
 *
 *  1. blocking — plays 0x33000AEA (CreateBlockingParticle, emitter id 1973,
 *     0x320005F0: 25 particles at 0.04 s) on a static object twice, 0.3 s apart.
 *     ParticleManager::CreateBlockingParticleEmitter @ 0051b8a0 returns 0
 *     while the id is live, so the second play must leave the SAME emitter
 *     running (its elapsed time and emitted count carry on, not reset).
 *  2. per-metre — plays 0x3300001C (emitter id 3, 0x32000026: per-metre,
 *     no time or count bound) on the same static object. ParticleManager::
 *     UpdateParticles @ 0051b800 deletes an emitter only when it is done, so
 *     it must still be live after --hold-ms (the old invented maxAge removed
 *     such trails after ~5 s).
 *  3. degraded — snapshots the persistent emitters around --poi, moves the
 *     player --away metres off with @teleloc, holds, and comes back.
 *     UpdateParticles' degraded-out branch (:276390-400) freezes a
 *     persistent emitter (birthtimes follow the clock), so on return each
 *     one's particle ages must match the snapshot taken when it degraded
 *     out (no catch-up ageing) and no update may emit more than one particle.
 *
 * Hooks the client's own module instances through Vite's dev-server URLs
 * (PhysicsScriptPlayer.prototype.update / play), as probe-emitter-rate does.
 *
 *   npx tsx tools/probe-emitter-lifecycle.ts [--poi holtburg] [--hold-ms 15000] [--away 260]
 *     [--create-char Name] [--out verification/emitter-lifecycle]
 * Exit 0 when all three checks pass.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, telepoi, teleloc, shot } from './lib/game-session.js';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const POI = arg('poi') ?? 'holtburg';
const HOLD_MS = Number(arg('hold-ms') ?? 15000);
const AWAY = Number(arg('away') ?? 260);
const OUT = arg('out') ?? 'verification/emitter-lifecycle';
const CHAR = arg('create-char') ?? 'Emitterprobe';

const BLOCKING_SCRIPT = 0x33000aea;
const BLOCKING_ID = 1973;
const PER_METRE_SCRIPT = 0x3300001c;
const PER_METRE_ID = 3;

const HOOK = `(async () => {
  const psMod = await import('/src/effects/ParticleSystem.ts');
  const pspMod = await import('/src/effects/PhysicsScriptPlayer.ts');
  const rec = window.__el = { psp: null, ids: new WeakMap(), nextId: 1, updates: 0, maxPerUpdate: 0, multi: 0 };
  const P = pspMod.PhysicsScriptPlayer.prototype;
  const origUpdate = P.update;
  P.update = function (dt) { rec.psp = this; return origUpdate.call(this, dt); };
  // CreateBlockingParticle's live-id test: count the times it blocked.
  const origLive = P.hasLiveEmitter;
  rec.blocked = 0;
  P.hasLiveEmitter = function (anchor, id) { const r = origLive.call(this, anchor, id); if (r && id === ${BLOCKING_ID}) rec.blocked++; return r; };
  const S = psMod.ParticleSystem.prototype;
  const origSys = S.update;
  S.update = function (dt) {
    const before = this.totalEmitted;
    const r = origSys.call(this, dt);
    if (!this.isDegradedOut && !rec.counting) return r;
    if (!this.isDegradedOut) {
      const n = this.totalEmitted - before;
      rec.updates++;
      if (n > rec.maxPerUpdate) rec.maxPerUpdate = n;
      if (n > 1) rec.multi++;
    }
    return r;
  };
  rec.tag = (ps) => { let id = rec.ids.get(ps); if (!id) { id = rec.nextId++; rec.ids.set(ps, id); } return id; };
  rec.ages = (ps) => ps.particles.map((p) => +(ps.elapsedTime - p.birth).toFixed(3));
  rec.describe = (ps) => ({
    tag: rec.tag(ps), id: '0x' + ((ps.emitterInfo.id ?? 0) >>> 0).toString(16),
    elapsed: +ps.elapsedTime.toFixed(3), emitted: ps.totalEmitted, live: ps.particles.length,
    degradedOut: ps.isDegradedOut, done: ps.isDone, disposed: ps.isDisposed,
  });
  return true;
})()`;

interface Desc { tag: number; id: string; elapsed: number; emitted: number; live: number; degradedOut: boolean; done: boolean; disposed: boolean }

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'probe-emitter-lifecycle', settleMs: 5000, createCharacter: CHAR });
  const { page } = s;
  const log = (m: string) => console.log(`[emitter-lifecycle] ${m}`);
  await page.evaluate(HOOK);
  if (POI !== 'none') await telepoi(page, POI);
  await page.waitForFunction('!!window.__el.psp', undefined, { timeout: 30_000 });

  // The owner: a static server object with an idle script queue (a portal's
  // own looping script holds the queue — ScriptManager runs scripts in
  // order — so ours would never start). Never moving matters for check 2.
  const candidates = await page.evaluate(`(() => {
    const objs = window.acDebug.listServerObjects().filter((o) => (o.guid >>> 28) !== 5);
    const rank = (o) => /door|sign|well|chest|lifestone/i.test(o.name) ? 0 : /portal/i.test(o.name) ? 2 : 1;
    return objs.sort((x, y) => rank(x) - rank(y)).slice(0, 25).map((o) => ({ guid: o.guid, name: o.name }));
  })()`) as Array<{ guid: number; name: string }>;
  let owner: { guid: number; name: string } | null = null;
  const play = (guid: number, script: number) => page.evaluate(`window.acDebug.playScriptOn(${script}, ${guid})`) as Promise<string>;
  // The owner's anchor by name (server objects are \`server_<guid>_<name>\`):
  // other objects' scripts play in between, so the last-played anchor is not it.
  let ownerGuid = 0;
  const emitterOnOwner = (id: number) => page.evaluate(`(() => {
    const el = window.__el; const pre = 'server_' + (${ownerGuid} >>> 0).toString(16) + '_';
    for (const [a, m] of el.psp.emittersById) if (a.name.startsWith(pre)) { const ps = m.get(${id}); return ps ? el.describe(ps) : null; }
    return null;
  })()`) as Promise<Desc | null>;

  // ── 1. CreateBlockingParticle on a live id does nothing ──────────────────
  let blockBefore: Desc | null = null;
  for (const c of candidates) {
    const r = await play(c.guid, BLOCKING_SCRIPT);
    if (!r.startsWith('script')) continue;
    ownerGuid = c.guid;
    await page.waitForTimeout(300);
    blockBefore = await emitterOnOwner(BLOCKING_ID);
    // An anchor the client is not stepping (an interior object outside the
    // visible cells) never ages its emitter; it is no use as an owner.
    if (blockBefore && blockBefore.elapsed > 0) { owner = c; break; }
    blockBefore = null;
  }
  if (!owner) throw new Error('no object near the POI started the blocking script at once');
  log(`owner ${owner.name} 0x${owner.guid.toString(16)}`);
  const blockedBefore = await page.evaluate('window.__el.blocked') as number;
  await play(owner.guid, BLOCKING_SCRIPT);
  const blockAfter = await emitterOnOwner(BLOCKING_ID);
  const blocked = (await page.evaluate('window.__el.blocked') as number) - blockedBefore;
  // A restart would be a NEW emitter (another tag) at elapsed 0.
  const blockingPass = blocked >= 1 && !!blockAfter && blockAfter.tag === blockBefore!.tag
    && blockAfter.elapsed >= blockBefore!.elapsed && blockAfter.emitted >= blockBefore!.emitted;
  log(`blocking: before ${JSON.stringify(blockBefore)} after ${JSON.stringify(blockAfter)} blocked ${blocked} → ${blockingPass ? 'PASS' : 'FAIL'}`);

  // ── 2. A stationary per-metre emitter lives until its owner stops it ─────
  log(`per-metre: ${await play(owner.guid, PER_METRE_SCRIPT)}`);
  await page.waitForTimeout(500);
  const metreStart = await emitterOnOwner(PER_METRE_ID);
  await page.waitForTimeout(HOLD_MS);
  const metreEnd = await emitterOnOwner(PER_METRE_ID);
  const perMetrePass = !!metreStart && !!metreEnd && metreEnd.tag === metreStart.tag && !metreEnd.disposed
    && metreEnd.elapsed >= metreStart.elapsed + HOLD_MS / 1000 - 1;
  log(`per-metre: start ${JSON.stringify(metreStart)} after ${HOLD_MS} ms ${JSON.stringify(metreEnd)} → ${perMetrePass ? 'PASS' : 'FAIL'}`);
  await shot(page, `${OUT}/at-poi.png`);

  // ── 3. Degraded-out persistent emitters freeze and resume without a burst ─
  const home = await page.evaluate('window.acDebug.collisionState()') as Record<string, unknown>;
  log(`home ${JSON.stringify(home)}`);
  const snapshotJs = `(() => {
    const el = window.__el; const out = [];
    for (const [anchor, set] of el.psp.objectSystems) {
      for (const ps of set) {
        const info = ps.emitterInfo;
        if (!(info.totalParticles <= 0 && info.totalSeconds <= 0) || ps.isDisposed) continue;
        out.push({ ...el.describe(ps), ages: el.ages(ps) });
      }
    }
    return out;
  })()`;
  const before = await page.evaluate(snapshotJs) as Array<Desc & { ages: number[] }>;
  log(`persistent emitters near ${POI}: ${before.length} (${before.filter((d) => !d.degradedOut).length} drawn)`);

  const frame = home.serverFrame as { cellId: number; x: number; y: number; z: number } | null;
  const cell = Number(frame?.cellId ?? home.cellId ?? 0) >>> 0;
  const lx = Number(frame?.x ?? NaN), ly = Number(frame?.y ?? NaN), lz = Number(frame?.z ?? NaN);
  const result: Record<string, unknown> = { poi: POI, owner, blocking: { pass: blockingPass, blocked, before: blockBefore, after: blockAfter },
    perMetre: { pass: perMetrePass, holdMs: HOLD_MS, start: metreStart, end: metreEnd }, home };
  let degradedPass = false;
  if (cell && Number.isFinite(lx) && Number.isFinite(ly) && Number.isFinite(lz)) {
    // Same landblock row, AWAY metres east in the next landblock(s).
    const lb = cell >>> 16;
    const bx = (lb >>> 8) + Math.floor((lx + AWAY) / 192);
    const nx = (lx + AWAY) % 192;
    const awayCell = ((((bx & 0xff) << 8) | (lb & 0xff)) << 16 | (1 + Math.floor(nx / 24) * 8 + Math.floor(ly / 24))) >>> 0;
    const loc = (c: number, x: number, y: number, z: number) => `0x${c.toString(16).padStart(8, '0')} [${x.toFixed(2)} ${y.toFixed(2)} ${(z + 1).toFixed(2)}] 1 0 0 0`;
    // Mark the moment each drawn emitter degrades out with its ages then.
    await page.evaluate(`(() => {
      const el = window.__el; el.outAges = new Map();
      el.watch = setInterval(() => {
        for (const [, set] of el.psp.objectSystems) for (const ps of set) {
          if (ps.isDegradedOut && !el.outAges.has(el.tag(ps))) el.outAges.set(el.tag(ps), el.ages(ps));
        }
      }, 16);
    })()`);
    log(`degraded: @teleloc ${loc(awayCell, nx, ly, lz)}`);
    await teleloc(page, loc(awayCell, nx, ly, lz), 15_000);
    const away = await page.evaluate(snapshotJs) as Array<Desc & { ages: number[] }>;
    const awayTags = new Set(away.filter((d) => d.degradedOut).map((d) => d.tag));
    await page.waitForTimeout(5000);
    const awayLater = await page.evaluate(snapshotJs) as Array<Desc & { ages: number[] }>;
    const frozenWhileAway = awayLater.filter((d) => awayTags.has(d.tag) && d.degradedOut).every((d) => {
      const a = away.find((x) => x.tag === d.tag)!;
      return JSON.stringify(a.ages) === JSON.stringify(d.ages) && d.live === a.live;
    });
    await page.evaluate('window.__el.counting = true');
    await teleloc(page, loc(cell, lx, ly, lz), 15_000);
    await page.evaluate('clearInterval(window.__el.watch)');
    const back = await page.evaluate(snapshotJs) as Array<Desc & { ages: number[] }>;
    const counts = await page.evaluate('({ updates: window.__el.updates, maxPerUpdate: window.__el.maxPerUpdate, multi: window.__el.multi })') as { updates: number; maxPerUpdate: number; multi: number };
    const survivors = back.filter((d) => awayTags.has(d.tag));
    degradedPass = awayTags.size > 0 && frozenWhileAway && counts.maxPerUpdate <= 1 && survivors.length > 0;
    result.degraded = {
      pass: degradedPass, awayCell: `0x${awayCell.toString(16)}`, persistentAtPoi: before.length,
      degradedOutAway: awayTags.size, frozenWhileAway, survivorsBack: survivors.length,
      drawnBack: survivors.filter((d) => !d.degradedOut).length, emissionsPerUpdateBack: counts,
      sample: survivors.slice(0, 5).map((d) => ({ tag: d.tag, id: d.id, live: d.live, awayAges: away.find((x) => x.tag === d.tag)?.ages.slice(0, 5), backAges: d.ages.slice(0, 5) })),
    };
    log(`degraded: ${JSON.stringify(result.degraded)} → ${degradedPass ? 'PASS' : 'FAIL'}`);
    await shot(page, `${OUT}/back-at-poi.png`);
  } else {
    result.degraded = { pass: false, reason: 'collisionState has no serverFrame' };
    log('degraded: collisionState has no serverFrame — skipped');
  }

  writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2));
  await s.browser.close();
  process.exit(blockingPass && perMetrePass && degradedPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
