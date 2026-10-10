/**
 * probe-sweepb-hud — live checks for the SWEEP1006B hud-status fixes, two
 * clients (A fxprobe1 / B fxprobe2) beside the Holtburg lifestone, against ACE:
 *  regen      no client regen prediction: over 30 s with stamina below max
 *             (A jumps to spend it), VitalSystem.regenTick never runs and every
 *             rise of A's stamina follows a server setCurrent (vital update)
 *             — gmVitalsUI::Update only runs from OnQualityChanged.
 *  radar      orbiting the camera (cameraYawOffset; also a held Numpad-4
 *             Rotate Camera) leaves the radar heading, the N/E/S/W token
 *             positions and the disc's pixels (B's blip) unchanged; turning
 *             the character (playerYaw) moves them — gmRadarUI::
 *             UpdateCompassTokens reads CPhysicsObj::get_heading(player).
 *  heart      HandleSelectionChanged @ 004bf380: selecting the Yellow vendor
 *             or the Loom (wcid 19128, not Attackable) sends no QueryHealth
 *             and the heart stays hidden; selecting B (a player) or a drudge
 *             (wcid 7) sends QueryHealth(guid), the heart is hidden at
 *             selection time and shows once ACE's UpdateHealth reply lands.
 *  usebtn     the Use hand follows _useability bit 0 (LAB_004bf795): the
 *             drudge (ItemUseable 1) greys it, the Loom (Remote 0x20) and the
 *             vendor leave it gold, though both are creatures.
 * Writes verification/sweepb-hud/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-sweepb-hud.ts [--only a,b]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, shot } from './lib/game-session.ts';
import { openTwoClients } from './lib/two-client.ts';

const OUT = 'verification/sweepb-hud';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (k: string) => !ONLY || ONLY.has(k);
const QUERY_HEALTH = 0x1bf;
const VENDOR = 'Shopkeeper Renald the Elder';
const VENDOR_SPOT = '0xA9B40019 84.3 1.5 94 0.9969 0 0 -0.0785'; // probe-entry-points' vendor spot
const LOOM_WCID = 19128; // ItemType Creature, ItemUseable 32 (Remote), Attackable False
const DRUDGE_WCID = 7;   // drudgeskulker: Creature, ItemUseable 1, attackable

const ev = <T>(p: Page, js: string): Promise<T> => p.evaluate(js) as Promise<T>;
const findByName = (p: Page, name: string) => ev<number>(p, `(() => { for (const o of window.__ac.serverObjectManager.objects.values()) if (o.name === ${JSON.stringify(name)}) return o.guid; return 0; })()`);
const findDynamic = (p: Page, wcid: number) => ev<number>(p, `(() => { let g = 0; for (const [k, o] of window.__ac.serverObjectManager.getAllObjects()) if (o.weenieClassId === ${wcid} && (k >>> 0) >= 0x80000000) g = k; return g; })()`);
const clearQueries = (p: Page) => ev(p, 'window.__ac.selectionQuerySends = []');
const queries = (p: Page) => ev<Array<{ type: number; guid: number }>>(p, 'window.__ac.selectionQuerySends || []');
/** Select through the real selectTarget path; report the strip state in the same tick. */
const selectNow = (p: Page, guid: number) => ev<{ meter: string; target: number }>(p, `(() => {
  window.acDebug.select(${guid}); const ui = window.__ac.gameUI; ui.updateHUD();
  return { meter: ui.targetMeter.style.display, target: ui.hudState.target ? ui.hudState.target.id : 0 }; })()`);
const strip = (p: Page) => ev<{ meter: string; healthReceived: boolean; health: number; useDisabled: string | undefined }>(p, `(() => {
  const ui = window.__ac.gameUI; ui.updateHUD(); const t = ui.hudState.target;
  return { meter: ui.targetMeter.style.display, healthReceived: !!(t && t.healthReceived), health: t ? t.healthFraction : -1,
    useDisabled: document.getElementById('tb-use') ? document.getElementById('tb-use').dataset.disabled : undefined }; })()`);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 600)}`); };
  const { a, b, close } = await openTwoClients('sweepb-hud');
  const A = a.page;
  try {
    if (want('regen')) {
      // Instrument the live VitalSystem: count regenTick calls and log every
      // server-driven setCurrent; poll stamina for rises with no setCurrent.
      await ev(A, `(() => {
        const v = window.__ac.playerState.vitals; const log = window.__sweepbRegen = { regenTicks: 0, sets: 0, unexplainedRises: [], samples: [] };
        const origTick = v.regenTick.bind(v); v.regenTick = (...args) => { log.regenTicks++; return origTick(...args); };
        const origSet = v.setCurrent.bind(v); v.setCurrent = (...args) => { log.sets++; log.lastSetAt = performance.now(); return origSet(...args); };
        let last = v.getCurrent(2), setsAtLast = 0;
        log.timer = setInterval(() => { const cur = v.getCurrent(2);
          if (cur > last && log.sets === setsAtLast) log.unexplainedRises.push({ from: last, to: cur, t: performance.now() });
          if (cur !== last) log.samples.push(cur); last = cur; setsAtLast = log.sets; }, 50);
      })()`);
      // Spend stamina: a few held jumps (ACE charges stamina per jump).
      await A.locator('canvas').first().click({ position: { x: 5, y: 5 }, force: true }).catch(() => {});
      for (let i = 0; i < 4; i++) { await A.keyboard.down('Space'); await A.waitForTimeout(900); await A.keyboard.up('Space'); await A.waitForTimeout(1500); }
      const before = await ev<{ cur: number; max: number }>(A, '(() => { const v = window.__ac.playerState.vitals; return { cur: v.getCurrent(2), max: v.getMax ? v.getMax(2, window.__ac.playerState.attributes) : -1 }; })()');
      await A.waitForTimeout(30_000);
      const log = await ev<{ regenTicks: number; sets: number; unexplainedRises: unknown[]; samples: number[] }>(A, '(() => { const l = window.__sweepbRegen; clearInterval(l.timer); return { regenTicks: l.regenTicks, sets: l.sets, unexplainedRises: l.unexplainedRises, samples: l.samples.slice(-20) }; })()');
      record('regen', log.regenTicks === 0 && log.unexplainedRises.length === 0, { before, ...log, note: before.cur >= before.max ? 'stamina was full; only regenTicks==0 is meaningful' : undefined });
    }

    if (want('radar')) {
      const dial = () => ev<{ heading: number; tokens: Record<string, string>; disc: string; yaw: number; offset: number }>(A, `(() => {
        const ui = window.__ac.gameUI; const cc = window.__ac.cameraController; ui.updateHUD && ui.updateHUD();
        const tokens = {}; for (const [k, el] of Object.entries(ui.compassTokenEls || {})) tokens[k] = el ? el.style.left + ',' + el.style.top : '';
        const c = document.getElementById('radar-canvas'); let disc = '';
        if (c) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) >>> 0; disc = h.toString(16); }
        return { heading: ui.hudState.headingDegrees, tokens, disc, yaw: cc.playerYaw, offset: cc.cameraYawOffset }; })()`);
      await ev(A, 'window.__ac.cameraController.cameraYawOffset = 0');
      await A.waitForTimeout(500);
      const base = await dial();
      await ev(A, 'window.__ac.cameraController.cameraYawOffset = 1.2');
      await A.waitForTimeout(500);
      const orbit = await dial();
      await shot(A, `${OUT}/radar-orbit.png`);
      // The real Rotate Camera key (retail Numpad 4) in third person.
      await ev(A, 'window.__ac.cameraController.cameraYawOffset = 0');
      await A.waitForTimeout(300);
      await A.keyboard.down('Numpad4'); await A.waitForTimeout(700); await A.keyboard.up('Numpad4');
      await A.waitForTimeout(400);
      const keyOrbit = await dial();
      await ev(A, 'window.__ac.cameraController.cameraYawOffset = 0; window.__ac.cameraController.playerYaw += 0.9');
      await A.waitForTimeout(500);
      const turned = await dial();
      await shot(A, `${OUT}/radar-turned.png`);
      const sameAs = (x: typeof base) => x.heading === base.heading && JSON.stringify(x.tokens) === JSON.stringify(base.tokens);
      record('radar', sameAs(orbit) && orbit.disc === base.disc && sameAs(keyOrbit) && !sameAs(turned),
        { base, orbit, keyOrbit, turned, keyOrbitMovedCamera: keyOrbit.offset !== 0 });
    }

    if (want('heart') || want('usebtn')) {
      await adminCommand(A, `@teleloc ${VENDOR_SPOT}`);
      await A.waitForTimeout(8000);
      await adminCommand(A, `@create ${LOOM_WCID}`);
      await A.waitForTimeout(3000);
      const vendor = await findByName(A, VENDOR);
      const loom = await findDynamic(A, LOOM_WCID);
      const heart: Record<string, unknown> = { vendor, loom };
      let ok = !!vendor && !!loom;
      const use: Record<string, unknown> = {};
      let useOk = true;
      for (const [label, guid] of [['vendor', vendor], ['loom', loom]] as const) {
        if (!guid) continue;
        await clearQueries(A);
        const at = await selectNow(A, guid);
        await A.waitForTimeout(2500);
        const q = await queries(A);
        const s = await strip(A);
        heart[label] = { at, queries: q, strip: s };
        ok = ok && at.meter === 'none' && !q.some((x) => x.type === QUERY_HEALTH && x.guid === guid) && s.meter === 'none';
        use[label] = s.useDisabled;
        useOk = useOk && s.useDisabled === '0';
        await shot(A, `${OUT}/select-${label}.png`);
      }
      // B is a player: QueryHealth, meter on the reply.
      await clearQueries(A);
      await adminCommand(A, `@teletome ${b.name}`);
      await A.waitForTimeout(5000);
      const bAt = await selectNow(A, b.guid);
      await A.waitForTimeout(2500);
      const bq = await queries(A);
      const bs = await strip(A);
      heart.player = { at: bAt, queries: bq, strip: bs };
      ok = ok && bAt.meter === 'none' && bq.some((x) => x.type === QUERY_HEALTH && x.guid === b.guid) && bs.healthReceived && bs.meter === 'block';
      await shot(A, `${OUT}/select-player.png`);
      // An attackable drudge: QueryHealth + meter on the reply; ItemUseable 1 greys Use.
      await adminCommand(A, `@create ${DRUDGE_WCID}`);
      await A.waitForTimeout(3000);
      const drudge = await findDynamic(A, DRUDGE_WCID);
      if (drudge) {
        await clearQueries(A);
        const dAt = await selectNow(A, drudge);
        await A.waitForTimeout(2500);
        const dq = await queries(A);
        const ds = await strip(A);
        heart.drudge = { guid: drudge, at: dAt, queries: dq, strip: ds };
        ok = ok && dAt.meter === 'none' && dq.some((x) => x.type === QUERY_HEALTH && x.guid === drudge) && ds.healthReceived && ds.meter === 'block';
        use.drudge = ds.useDisabled;
        useOk = useOk && ds.useDisabled === '1';
        await shot(A, `${OUT}/select-drudge.png`);
        // ACE @delete takes HealthQueryTarget first — the drudge we just queried.
        await adminCommand(A, '@delete');
      } else {
        ok = false; useOk = false; heart.drudge = 'not spawned';
      }
      if (want('heart')) record('heart', ok, heart);
      if (want('usebtn')) record('usebtn', useOk, use);
      // The Loom is left in place: with no QueryHealth for it, ACE's @delete
      // would fall through to CurrentAppraisalTarget (another object). @create
      // spawns are not persisted, so it goes with the landblock.
    }
  } finally {
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    await close();
  }
  if (fails.length) { console.log(`FAILED: ${fails.join(', ')}`); process.exit(1); }
  console.log('ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
