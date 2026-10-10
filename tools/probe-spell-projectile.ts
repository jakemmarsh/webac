/**
 * probe-spell-projectile — how a war-magic bolt flies on our client vs what
 * the server says (BUG.spell-projectile-physics).
 *
 * Records, in the page, for every Missile object the server creates:
 *  - its CreateObject (physicsState, velocity, omega, rendered position),
 *  - per-frame rendered position/visibility + the local body's state bits
 *    (sampled on rAF),
 *  - SetState / VectorUpdate / DeleteObject arrivals and local contacts,
 * plus how many client-invented (SpellEffects) projectiles are alive, so a
 * doubled / always-hits stand-in would show in the log.
 *
 * Scenarios (the character is teleported with @telexyz, facing north):
 *  1. hit     — Flame Bolt VI (85) at a no-aggro drudge ~18 m north.
 *  2. dodge   — the same bolt at a fresh drudge; the moment the bolt's
 *               CreateObject lands the caster @telexyz's 6 m east of the
 *               drudge and `@movetome`s it (it was appraised): the drudge
 *               leaves the lane sideways and the bolt must fly on past its
 *               old spot, not bend toward it.
 *  3. wall    — an untargeted bolt fired north at the nearest building from
 *               20 m south of its centre: it must stop at the wall.
 * VERIFY.spell-projectile-arc-ring-dungeon — one scenario per remaining
 * ACE ProjectileSpellType (spells in SPELL below), each at a fresh drudge:
 *  arc, streak, blast, volley, ring, wallspell — and `dungeon`: untargeted
 *  bolts in four headings + an untargeted arc inside the Holtburg Dungeon
 *  (the cell BSP must stop them at walls / the floor).
 * Every missile's first LOCAL contact is logged (`local-contact`: where, what,
 * normal) next to the server's SetState verdict (`setstate`, with where our
 * object was when it arrived).
 * Each scenario is screencast (CDP) to verification/spell-projectile/.
 *
 * Usage (never on testacjs — Jake plays on it):
 *   AC_ACCOUNT=plantprobe AC_PASSWORD=plantprobe AC_BASE=http://localhost:3057/ \
 *     npx tsx tools/probe-spell-projectile.ts [--gpu] [--only arc,ring,dungeon]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { enterWorld, adminCommand, sessionArgs } from './lib/game-session.js';
import { DUNGEON_STONE } from './capture-scenes.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.js';
import { resolveCastTarget, inqSpellTargetType } from '../packages/shared/src/magic/CastTargeting.js';
import { REPO } from './lib/game-session.js';

const OUT = 'verification/spell-projectile';

const HOOK = `(() => {
  const ac = window.__ac, som = ac.serverObjectManager;
  const rec = window.__proj = { log: [], samples: {}, t0: performance.now(), fakeMax: 0 };
  const t = () => Math.round(performance.now() - rec.t0);
  const tracked = new Set();
  const oc = som.createObject.bind(som);
  som.createObject = (d) => {
    const r = oc(d);
    if (d.physicsState & 0x40) {
      tracked.add(d.guid);
      rec.log.push({ t: t(), ev: 'create', guid: d.guid.toString(16), name: d.name, state: d.physicsState.toString(16),
        v: [d.velocityX, d.velocityY, d.velocityZ].map((x) => +x.toFixed(2)),
        w: [d.omegaX || 0, d.omegaY || 0, d.omegaZ || 0].map((x) => +x.toFixed(2)),
        pos: r ? [r.worldX, r.worldY, r.worldZ].map((x) => +x.toFixed(2)) : null,
        radius: som.getMissileBody && som.getMissileBody(d.guid) ? +som.getMissileBody(d.guid).radius.toFixed(3) : null });
    }
    return r;
  };
  const ss = som.setPhysicsState.bind(som);
  // The creature nearest a point (gap to its collision cylinder's side, m) —
  // what a server impact our flight had no local contact for could have hit.
  const nearestCreature = (x, y, z) => { let best = null;
    for (const c of som.objects.values()) { if (!(c.itemType & 0x10) || tracked.has(c.guid)) continue;
      const gap = Math.hypot(c.worldX - x, c.worldZ - z) - (c.collisionRadius || 0);
      if (!best || gap < best.gap) best = { guid: c.guid.toString(16), name: c.name, gap: +gap.toFixed(2), dz: +(y - c.worldY).toFixed(2),
        r: +(c.collisionRadius || 0).toFixed(2), h: +(c.collisionHeight || 0).toFixed(2), eth: !!(c.physicsState & 4) }; }
    return best; };
  som.setPhysicsState = (g, s, q) => { if (tracked.has(g)) { const o = som.objects.get(g);
    rec.log.push({ t: t(), ev: 'setstate', guid: g.toString(16), state: s.toString(16), at: o ? [o.worldX, o.worldY, o.worldZ].map((x) => +x.toFixed(2)) : null,
      near: o ? nearestCreature(o.worldX, o.worldY, o.worldZ) : null }); } return ss(g, s, q); };
  const vu = som.applyVectorUpdate.bind(som);
  som.applyVectorUpdate = (g, ...a) => { if (tracked.has(g)) rec.log.push({ t: t(), ev: 'vector', guid: g.toString(16), v: a.slice(0, 3).map((x) => +x.toFixed(2)) }); return vu(g, ...a); };
  const del = som.deleteObject.bind(som);
  som.deleteObject = (g) => { if (tracked.has(g)) rec.log.push({ t: t(), ev: 'delete', guid: g.toString(16) }); return del(g); };
  // Every missile's FIRST local contact (world or creature), per guid: where
  // (THREE axes, like the samples) and what it hit.
  const contacted = new Set();
  const sweepFor = som.missileSweepFor.bind(som);
  som.missileSweepFor = (guid) => { const sw = sweepFor(guid); return (from, to, r) => { const c = sw(from, to, r);
    if (c && !contacted.has(guid)) { contacted.add(guid); rec.log.push({ t: t(), ev: 'local-contact', guid: guid.toString(16),
      hit: c.objectGuid !== undefined ? 'obj ' + c.objectGuid.toString(16) : 'env',
      n: c.normal ? [c.normal.x, c.normal.z, c.normal.y].map((x) => +x.toFixed(2)) : null,
      at: [from.x + (to.x - from.x) * c.t, from.z + (to.z - from.z) * c.t, from.y + (to.y - from.y) * c.t].map((x) => +x.toFixed(2)) }); }
    return c; }; };
  window.__resetContact = () => contacted.clear();
  const prevScript = som.onMissileDefaultScript;
  som.onMissileDefaultScript = (o) => { rec.log.push({ t: t(), ev: 'local-contact-script', guid: o.guid.toString(16), at: [o.worldX, o.worldY, o.worldZ].map((x) => +x.toFixed(2)) }); if (prevScript) prevScript(o); };
  const sample = () => {
    for (const g of tracked) {
      const o = som.objects.get(g);
      const arr = rec.samples[g.toString(16)] = rec.samples[g.toString(16)] || [];
      if (!o || !o.mesh) { if (arr.length && arr[arr.length - 1].gone) continue; arr.push({ t: t(), gone: true }); continue; }
      const b = som.getMissileBody ? som.getMissileBody(g) : null;
      arr.push({ t: t(), p: [o.mesh.position.x, o.mesh.position.y, o.mesh.position.z].map((x) => +x.toFixed(2)), vis: o.mesh.visible,
        st: b ? b.state.toString(16) : '' });
    }
    const fake = ac.spellEffects.activeProjectiles ? ac.spellEffects.activeProjectiles.length : 0;
    if (fake > rec.fakeMax) rec.fakeMax = fake;
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  return 'hooked';
})()`;

async function dump(page: Page, label: string): Promise<void> {
  const rec = JSON.parse(await page.evaluate('JSON.stringify(window.__proj)') as string);
  // A white world in the screencast with a lost WebGL context is the GPU, not the scene.
  const glLost = await page.evaluate(`(() => { const r = window.__ac.sceneManager && window.__ac.sceneManager.renderer;
    return r ? r.getContext().isContextLost() : null; })()`);
  console.log(`=== ${label}  (client-invented SpellEffects projectiles alive, max: ${rec.fakeMax}; WebGL context lost: ${glLost})`);
  for (const e of rec.log) console.log('  ' + JSON.stringify(e));
  for (const [g, arr] of Object.entries(rec.samples) as [string, { t: number; p?: number[]; vis?: boolean; gone?: boolean; st?: string }[]][]) {
    // Every 5th sample while it moves; a repeated resting sample only once.
    const pick = arr.filter((x, i) => i === arr.length - 1
      || (i % 5 === 0 && !(i > 0 && JSON.stringify(arr[i - 1].p) === JSON.stringify(x.p) && arr[i - 1].vis === x.vis)));
    console.log(`  samples ${g} (${arr.length}): ${pick.map((s) => s.gone ? `t=${s.t} gone` : `t=${s.t} ${s.p!.join(',')}${s.vis ? '' : ' hidden'} st=${s.st}`).join(' | ')}`);
  }
  await page.evaluate('window.__proj.log = []; window.__proj.samples = {}; window.__proj.fakeMax = 0; window.__resetContact()');
}

async function screencast(page: Page, name: string, act: () => Promise<void>, ms: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const frames: { ms: number; data: string }[] = [];
  // Frames are named by PAGE time (the log's t=), so they line up with events.
  const pageT0 = await page.evaluate('Math.round(performance.now() - window.__proj.t0)') as number;
  const t0 = Date.now() - pageT0;
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
    frames.push({ ms: Date.now() - t0, data: f.data });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
  await act();
  await page.waitForTimeout(ms);
  await cdp.send('Page.stopScreencast');
  mkdirSync(OUT, { recursive: true });
  for (const f of frames) writeFileSync(`${OUT}/${name}-${String(f.ms).padStart(6, '0')}.jpg`, Buffer.from(f.data, 'base64'));
  console.log(`screencast ${name}: ${frames.length} frames (named by page t=) → ${OUT}`);
}

/** The @telexyz command for THREE world (x, z) facing north (identity rotation), on the terrain. */
async function teleCommand(page: Page, x: number, z: number): Promise<string> {
  const h = await page.evaluate(`window.__ac.terrainCollision.getHeightAt(${x}, ${z})`) as number | null;
  const lbX = Math.floor(x / 192), lbY = Math.floor(z / 192);
  const lx = x - lbX * 192, ly = z - lbY * 192;
  const cell = ((lbX << 24) | (lbY << 16) | (Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1)) >>> 0;
  return `@telexyz ${cell} ${lx.toFixed(2)} ${ly.toFixed(2)} ${((h ?? 0) + 0.5).toFixed(2)} 0 0 0 1`;
}

async function teleTo(page: Page, x: number, z: number): Promise<void> {
  await adminCommand(page, await teleCommand(page, x, z));
  await page.waitForTimeout(6000);
}

const me = (page: Page) => page.evaluate(`(() => { const c = window.acDebug.collisionState(); return [c.x, c.y, c.z]; })()`) as Promise<number[]>;

async function spawnDrudge(page: Page): Promise<number> {
  const before = await page.evaluate(`JSON.stringify([...window.__ac.serverObjectManager.objects.keys()])`) as string;
  await adminCommand(page, '@create 19257');
  await page.waitForTimeout(3000);
  return await page.evaluate(`(() => { const b = new Set(${before});
    const o = [...window.__ac.serverObjectManager.objects.values()].filter((o) => /drudge/i.test(o.name || '') && !b.has(o.guid)).pop();
    return o ? o.guid : 0; })()`) as number;
}

const objPos = (page: Page, guid: number) => page.evaluate(`(() => { const o = window.__ac.serverObjectManager.objects.get(${guid}); return o ? [o.worldX, o.worldY, o.worldZ] : null; })()`) as Promise<number[] | null>;

/**
 * The war spells the scenarios cast (world DB `spell` rows), one per ACE
 * ProjectileSpellType (SpellProjectile.GetProjectileSpellType):
 *  - bolt   85   Flame Bolt VI           1 projectile, tracking          → Bolt
 *  - arc    2744 Flame Arc VI            1 projectile, non_Tracking      → Arc (Gravity)
 *  - streak 1801 Flame Streak VI         category FlameStreak            → Streak
 *  - blast  118  Flame Blast VI          3 projectiles, spread 90°       → Blast
 *  - volley 146  Flame Volley VI         3 projectiles abreast           → Volley
 *  - ring   1785 Cassius' Ring of Fire   9 projectiles, spread 360°      → Ring
 *  - wall   1841 Slithering Flames       10 projectiles, dims 5×1×2      → Wall
 */
const SPELL = { bolt: 85, arc: 2744, streak: 1801, blast: 118, volley: 146, ring: 1785, wall: 1841 } as const;

/** `--only a,b` runs just those scenarios (hit, dodge, wall, arc, arclong, streak, blast, volley, ring, wallspell, dungeon, door). */
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (name: string) => !ONLY || ONLY.has(name);

/**
 * The wire target the spell bar would send with the drudge selected — the
 * same resolveCastTarget the client's cast path runs on the DAT SpellTable
 * row: untargeted rings / blasts / walls (NonComponentTargetType None) go
 * out untargeted even with a selection (a targeted ring is refused by ACE
 * VerifySpellRange with MissileOutOfRange).
 */
let spellTable: SpellTable | null = null;
function castTargetFor(spellId: number, selected: number): number | null {
  spellTable ??= new SpellTable(new DatReader(new DatDatabase(readFileSync(`${REPO}/dat/client_portal.dat`).buffer).getFileData(0x0e00000e)!));
  const s = spellTable.spells.get(spellId);
  if (!s) return selected;
  const r = resolveCastTarget(s.bitfield, inqSpellTargetType(s.formula), selected, null);
  return r.kind === 'targeted' ? r.targetGuid : null;
}

async function castAtFreshDrudge(page: Page, spot: number[], name: string, spellId: number, dist: number, ms: number, label: string): Promise<void> {
  await teleTo(page, spot[0], spot[1] + 18);
  const d = await spawnDrudge(page);
  const dp = await objPos(page, d);
  console.log(`${name}: drudge`, d.toString(16), JSON.stringify(dp));
  if (!d || !dp) throw new Error(`${name}: no drudge`);
  await teleTo(page, dp[0], dp[2] - dist);
  console.log('me', (await me(page)).map((x) => x.toFixed(1)).join(','));
  await page.evaluate(`window.acDebug.select(${d})`);
  await screencast(page, name, () => page.evaluate(`window.__ac.castSpell(${spellId}, ${castTargetFor(spellId, d)})`) as Promise<void>, ms);
  await dump(page, `${name}: ${label} at a drudge ${dist} m north (drudge at ${dp.map((x) => x.toFixed(1))})`);
}

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'spell-projectile', ...sessionArgs() } as never);
  const page = s.page;
  const verbose = process.argv.includes('--verbose');
  const pageErrors = new Map<string, number>();
  page.on('pageerror', (e) => { const k = String(e.stack || e).slice(0, 400); const n = (pageErrors.get(k) ?? 0) + 1; pageErrors.set(k, n); if (n === 1) console.log('  [pageerror] ' + k); });
  page.on('console', (m) => { const x = m.text(); if (verbose || /fizzl|components|YourProjectile|can.t|cannot|not visible|context lost|webgl|gl_/i.test(x)) console.log('  [page] ' + x.slice(0, 160)); });
  await page.waitForTimeout(4000);
  console.log(await page.evaluate(HOOK));
  await adminCommand(page, '@god');
  await page.waitForTimeout(1500);
  for (const id of Object.values(SPELL)) {
    await adminCommand(page, `@addspell ${id}`);
    await page.waitForTimeout(400);
  }
  // Wield a Practice Wand — the one already wielded, else one from the pack,
  // else a fresh one (each @ci used to pile another wand into the pack).
  const wand = async (where: 'equipped' | 'inventory') => page.evaluate(where === 'equipped'
    ? `JSON.stringify(window.acDebug.equipped() || []).includes('Practice Wand')`
    : `!!(window.__ac.playerState && window.__ac.playerState.inventory.getAll().some((i) => i.name === 'Practice Wand'))`) as Promise<boolean>;
  if (!(await wand('equipped'))) {
    if (!(await wand('inventory'))) {
      await adminCommand(page, '@ci 4799');
      await page.waitForTimeout(2500);
    }
    await page.evaluate(`window.acDebug.equip('Practice Wand', 'Held')`);
    await page.waitForTimeout(2500);
  }
  await page.evaluate(`window.acDebug.combatMode('magic')`);
  await page.waitForTimeout(3500);

  await page.evaluate('window.acDebug.freezeTimeOfDay(0.5)'); // daylight for the screencasts
  const outdoor = ['hit', 'dodge', 'wall', 'arc', 'arclong', 'streak', 'blast', 'volley', 'ring', 'wallspell'].some(want);
  if (outdoor) {
    // The outdoor scenarios' home: the lakeside slope north-east of Holtburg
    // (0xA9B5, where the open lane below was first found) — the character
    // may have logged out in the dungeon.
    await adminCommand(page, '@teleloc 0xA9B5003A [182.46 27.06 32.77] 1 0 0 0');
    await page.waitForTimeout(10000);
    const start = await me(page);
    console.log('start', start.map((x) => x.toFixed(1)).join(','));
    // An open lane: 30 m north from the stand-off point, clear of scenery /
    // statics and above the ground (the collision the missile itself runs).
    let spot: number[] | null = null;
    for (let k = 0; k < 40 && !spot; k++) {
      const x = start[0] + 12 * (k % 8) - 42, z = start[2] + 12 * Math.floor(k / 8) - 24;
      const clear = await page.evaluate(`(() => { const ac = window.__ac, tc = ac.terrainCollision;
        const h0 = tc.getHeightAt(${x}, ${z}), h1 = tc.getHeightAt(${x}, ${z + 30});
        if (h0 == null || h1 == null || Math.abs(h1 - h0) > 2) return false;
        for (let i = 0; i <= 30; i += 3) { const h = tc.getHeightAt(${x}, ${z} + i); if (h == null || h > h0 + 0.6) return false; }
        return !ac.outdoorCollision.sweepSphere({ x: ${x}, y: h0 + 1.2, z: ${z} }, { x: ${x}, y: h0 + 1.2, z: ${z + 30} }, 1.0); })()`);
      if (clear) spot = [x, z];
    }
    if (!spot) throw new Error('no open lane near the start');
    console.log('open lane at', spot.map((x) => x.toFixed(1)).join(','));

    // 1. hit
    if (want('hit')) await castAtFreshDrudge(page, spot, 'hit', SPELL.bolt, 18, 7000, 'Flame Bolt VI');

    // 2. dodge — a fresh drudge, same lane.
    if (want('dodge')) {
      await teleTo(page, spot[0], spot[1] + 18);
      const d2 = await spawnDrudge(page);
      const dp2 = await objPos(page, d2);
      console.log('drudge 2', d2.toString(16), JSON.stringify(dp2));
      if (!d2 || !dp2) throw new Error('no drudge 2');
      await teleTo(page, dp2[0], dp2[2] - 18);
      await page.evaluate(`window.acDebug.select(${d2})`);
      await page.evaluate(`window.__ac.identifyObject(${d2})`); // last appraised → @movetome's subject
      await page.waitForTimeout(1500);
      await page.evaluate(`(() => {
        const som = window.__ac.serverObjectManager, oc = som.createObject.bind(som);
        window.__wantMove = false;
        som.createObject = (d) => { const r = oc(d); if ((d.physicsState & 0x40) && !window.__wantMoveDone) { window.__wantMoveDone = true; window.__wantMove = true; } return r; };
      })()`);
      const sideTele = await teleCommand(page, dp2[0] + 6, dp2[2]);
      await screencast(page, 'dodge', async () => {
        await page.evaluate(`window.__ac.castSpell(${SPELL.bolt}, ${d2})`);
        for (let i = 0; i < 300; i++) {
          if (await page.evaluate('!!window.__wantMove')) {
            // Step 6 m east of the drudge and pull it there: it leaves the bolt's lane sideways.
            await adminCommand(page, sideTele);
            await adminCommand(page, '@movetome');
            break;
          }
          await page.waitForTimeout(20);
        }
      }, 9000);
      console.log('drudge 2 after', JSON.stringify(await objPos(page, d2)));
      await dump(page, `dodge: drudge pulled 6 m east right after launch (was at ${dp2.map((x) => x.toFixed(1))})`);
    }

    // 4. arc — Flame Arc VI: Gravity set, a lobbed ballistic solution
    //    (Trajectory.solve_ballistic_arc_lateral) that lands on the drudge.
    if (want('arc')) await castAtFreshDrudge(page, spot, 'arc', SPELL.arc, 18, 7000, 'Flame Arc VI');
    // …and from 35 m, where the solution is a visible lob (~1 s of flight).
    if (want('arclong')) await castAtFreshDrudge(page, spot, 'arclong', SPELL.arc, 35, 7000, 'Flame Arc VI (long lob)');
    // 5. streak, blast, volley, ring, wall spell.
    if (want('streak')) await castAtFreshDrudge(page, spot, 'streak', SPELL.streak, 18, 7000, 'Flame Streak VI');
    if (want('blast')) await castAtFreshDrudge(page, spot, 'blast', SPELL.blast, 12, 7000, 'Flame Blast VI (3 × 90° spread)');
    if (want('volley')) await castAtFreshDrudge(page, spot, 'volley', SPELL.volley, 12, 7000, 'Flame Volley VI (3 abreast)');
    if (want('ring')) await castAtFreshDrudge(page, spot, 'ring', SPELL.ring, 8, 7000, "Cassius' Ring of Fire (9 × 360°)");
    if (want('wallspell')) await castAtFreshDrudge(page, spot, 'wallspell', SPELL.wall, 12, 12000, 'Slithering Flames (5 × 2 wall)');

    // 3. wall — nearest building.
    if (want('wall')) {
      const bld = await page.evaluate(`(() => {
        const cells = window.__ac.outdoorCollision.cells, c = window.acDebug.collisionState();
        let best = null;
        for (const [k, v] of cells) { if (typeof k !== 'string' || !k.startsWith('bl:')) continue;
          const x = v.origin.x + v.blockOffsetX, z = v.origin.y + v.blockOffsetY, d = Math.hypot(x - c.x, z - c.z);
          if (!best || d < best.d) best = { k, x, z, d }; }
        return best; })()`) as { k: string; x: number; z: number; d: number } | null;
      console.log('nearest building', JSON.stringify(bld));
      if (bld) {
        await page.evaluate('window.acDebug.select && window.acDebug.select(0)');
        await teleTo(page, bld.x, bld.z - 20);
        console.log('me', (await me(page)).map((x) => x.toFixed(1)).join(','));
        await screencast(page, 'wall', () => page.evaluate(`window.__ac.castSpell(${SPELL.bolt}, null)`) as Promise<void>, 8000);
        await dump(page, `wall: untargeted bolt north at building ${bld.k} (centre ${bld.x.toFixed(1)},${bld.z.toFixed(1)})`);
      }
    }
  }

  // 6. dungeon — Holtburg Dungeon (capture-scenes DUNGEON_STONE drop point):
  //    untargeted bolts in the four compass headings must stop at the cell
  //    BSP's walls; an untargeted arc must fall onto the cell floor.
  if (want('dungeon')) {
    const m = /^@teleloc (\S+) \[([^\]]+)\]/.exec(DUNGEON_STONE)!;
    const cell = m[1], xyz = m[2];
    await page.evaluate('window.acDebug.select && window.acDebug.select(0)');
    for (const [i, yawDeg] of [0, 90, 180, 270].entries()) {
      const h = (yawDeg * Math.PI) / 360;
      await adminCommand(page, `@teleloc ${cell} [${xyz}] ${Math.cos(h).toFixed(4)} 0 0 ${Math.sin(h).toFixed(4)}`);
      await page.waitForTimeout(i === 0 ? 14000 : 5000);
      console.log('me', (await me(page)).map((x) => x.toFixed(2)).join(','), 'yaw', yawDeg);
      // The server objects around (doors, chests, creatures): a missile
      // collides with any non-ethereal one (OBJECTINFO::missile_ignore).
      if (i === 0) console.log('objects within 30 m', await page.evaluate(`(() => { const c = window.acDebug.collisionState();
        return JSON.stringify([...window.__ac.serverObjectManager.objects.values()].filter((o) => o.mesh && Math.hypot(o.worldX - c.x, o.worldZ - c.z) < 30)
          .map((o) => ({ g: o.guid.toString(16), n: o.name, it: o.itemType, st: o.physicsState.toString(16), setup: o.setupId.toString(16),
            p: [o.worldX, o.worldY, o.worldZ].map((x) => +x.toFixed(2)) }))); })()`));
      await screencast(page, `dungeon-bolt-${yawDeg}`, () => page.evaluate(`window.__ac.castSpell(${SPELL.bolt}, null)`) as Promise<void>, 6000);
      await dump(page, `dungeon: untargeted Flame Bolt VI, heading ${yawDeg}° (${cell})`);
    }
    // The arc leaves level at 40 m/s and drops ½·9.8·(d/40)²: it reaches the
    // floor ~1.8 m down after ~24 m, so face the longest clear corridor
    // (the heading whose level sweep through the cell BSP runs furthest).
    const lane = await page.evaluate(`(() => { const dc = window.__ac.dungeonCollision, c = window.acDebug.collisionState();
      let best = null;
      for (let a = 0; a < 360; a += 5) { const r = a * Math.PI / 180, dx = -Math.sin(r), dz = Math.cos(r);
        const f = { x: c.x + dx * 1.2, y: c.y + 1.84, z: c.z + dz * 1.2 }, to = { x: f.x + dx * 40, y: f.y, z: f.z + dz * 40 };
        const h = dc.sweepSphere(f, to, 0.1), len = h ? h.t * 40 : 40;
        if (!best || len > best.len) best = { a, len }; }
      return best; })()`) as { a: number; len: number };
    console.log('longest dungeon lane', JSON.stringify(lane));
    const ha = (lane.a * Math.PI) / 360;
    await adminCommand(page, `@teleloc ${cell} [${xyz}] ${Math.cos(ha).toFixed(4)} 0 0 ${Math.sin(ha).toFixed(4)}`);
    await page.waitForTimeout(5000);
    await screencast(page, 'dungeon-arc', () => page.evaluate(`window.__ac.castSpell(${SPELL.arc}, null)`) as Promise<void>, 6000);
    await dump(page, `dungeon: untargeted Flame Arc VI (gravity) down the ${lane.len.toFixed(1)} m lane at heading ${lane.a}° — must land on the cell floor`);
  }

  // 7. door — a closed dungeon door is a solid weenie object (world DB
  //    landblock_instance: `door` wcid 278 at 0x01F60131 [110 −205.245 −18],
  //    identity rotation): an untargeted bolt fired north at it from 4 m
  //    south must stop at the door leaf on this client (its Setup part BSP),
  //    not only when the server's SetState arrives.
  if (want('door')) {
    await page.evaluate('window.acDebug.select && window.acDebug.select(0)');
    await adminCommand(page, '@teleloc 0x01F60131 [110 -209.2 -18] 1 0 0 0');
    await page.waitForTimeout(14000);
    console.log('me', (await me(page)).map((x) => x.toFixed(2)).join(','));
    console.log('objects within 12 m', await page.evaluate(`(() => { const c = window.acDebug.collisionState();
      return JSON.stringify([...window.__ac.serverObjectManager.objects.values()].filter((o) => o.mesh && Math.hypot(o.worldX - c.x, o.worldZ - c.z) < 12)
        .map((o) => ({ g: o.guid.toString(16), n: o.name, it: o.itemType, st: o.physicsState.toString(16), setup: o.setupId.toString(16),
          p: [o.worldX, o.worldY, o.worldZ].map((x) => +x.toFixed(2)) }))); })()`));
    await screencast(page, 'door', () => page.evaluate(`window.__ac.castSpell(${SPELL.bolt}, null)`) as Promise<void>, 6000);
    await dump(page, 'door: untargeted Flame Bolt VI north at the closed door 4 m ahead (0x01F60131)');
  }

  await s.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
