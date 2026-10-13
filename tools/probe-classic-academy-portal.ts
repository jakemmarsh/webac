/**
 * STREAM.rebuild-kills-part-emitters / BLDG.portal-face-drawn-over-interior
 * live probe: log a classic-era character in through the launcher (the era
 * reload included), @teleloc it next to something, face it, and screenshot
 * three camera angles. Prints the Training Academy portal's emitter state
 * (PORTALSTATE: its particle systems should be live, not done) and every
 * Door's draw state. HIDES=1 also screenshots the view once per hidden
 * top-level scene group (find which group draws a stray pixel).
 *
 * Needs a local ClassicACE Infiltration (CLASSICACE_RULESET=Infiltration
 * bash tools/classicace/start-classicace.sh) behind its own bridge, and an
 * admin account with a character (probe-era-switch.ts --create makes one).
 *
 *   ACCT=infprobe2 BRIDGE=ws://localhost:9192 BASE=http://localhost:3021/ \
 *     EXTRA="eraDatSet=classicace-infiltration:https://dats.playwebac.com/v1/sets/classicace-infiltration-1.9.json&" \
 *     YAW=3.14159 LOC='@teleloc 0xA5B4002A [131.0 42.0 52.0] 1 0 0 0' \
 *     npx tsx tools/probe-classic-academy-portal.ts <outdir>
 *
 * EXTRA streams the era's DATs as production does (dev server only; omit it
 * for the whole-DAT path). The LOC above is 11 m south of the Holtburg West
 * Outpost Training Academy portal; '@teleloc 0xA5B40033 [148.0 62.0 51.0]
 * 1 0 0 0' with YAW=1.2 faces the academy pyramid's doorway.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createRunProfile } from './lib/temp-profile.js';
import { shot, waitFor, chatLine, AT_CHAR_SELECT_JS, IN_CHARGEN_JS, IN_WORLD_JS, SWIFTSHADER_ARGS } from './lib/game-session.js';
const out = process.argv[2]; const base = process.env.BASE ?? 'http://localhost:3021/'; const bridge = process.env.BRIDGE ?? 'ws://localhost:9192';
// PROFILE=<dir> reuses (and keeps) a warm profile; otherwise a fresh one, deleted at exit / signal / crash.
const profile = createRunProfile('acjs-infil-', { persistDir: process.env.PROFILE, tool: 'probe-classic-academy-portal' });
const browser = await chromium.launchPersistentContext(profile.dir, { args: SWIFTSHADER_ARGS, viewport: { width: 1280, height: 720 } });
profile.setCloser(() => browser.close());
const page = browser.pages()[0] ?? await browser.newPage();
page.setDefaultTimeout(120_000);
const logs: string[] = [];
page.on('console', (m) => logs.push(m.text()));
const ev = <T = unknown>(js: string): Promise<T> => page.evaluate(js) as Promise<T>;
await page.goto(`${base}?${process.env.EXTRA ?? ""}ace&debug&bridge=${encodeURIComponent(bridge)}`, { waitUntil: 'commit' });
await waitFor(page, `!!document.querySelector('.launcher-world-row')`, { timeoutMs: 180_000, reloadEveryMs: 0 });
await page.locator('input.launcher-account').fill(process.env.ACCT ?? 'infprobe2');
await page.locator('input.launcher-password').fill(process.env.PASSWORD ?? `${process.env.ACCT ?? 'infprobe2'}pw`);
await ev(`document.querySelector('.launcher-enter').click()`);
await waitFor(page, `(${AT_CHAR_SELECT_JS}) || (${IN_CHARGEN_JS})`, { timeoutMs: 300_000, reloadEveryMs: 0 });
await page.waitForTimeout(1500);
await ev(`(() => { const el = [...document.querySelectorAll('[data-ac-press]')].find(e => e.dataset.acPress.toLowerCase().includes('100003a2') && e.offsetParent !== null); el && el.click(); })()`);
console.log('inworld', await waitFor(page, IN_WORLD_JS, { timeoutMs: 300_000, reloadEveryMs: 0 }));
await page.waitForTimeout(4000);
await chatLine(page, process.env.LOC ?? '@teleloc 0xA5B4002A [133.5 40.0 52.0] 1 0 0 0');
await page.waitForTimeout(15000);
const yaw = Number(process.env.YAW ?? 0);
await ev(`window.__ac.cameraController.playerYaw = ${yaw}`);
await page.waitForTimeout(3000);
for (const [n, off] of [['a', 0], ['b', 0.5], ['c', -0.5]] as const) {
  await ev(`window.__ac.cameraController.cameraYawOffset = ${off}`);
  await page.waitForTimeout(1500); await shot(page, join(out, `view-${n}.png`));
}
console.log(JSON.stringify(await ev(`(() => { const p = window.__ac.playerModel.position; return [p.x, p.y, p.z]; })()`)));
const pst = await ev(`(() => { const ac = window.__ac; const psp = ac.physicsScriptPlayer; const som = ac.serverObjectManager; let o; som.getAllObjects().forEach(x => { if (/Training Academy Portal/.test(x.name)) o = x; });
  if (!o) return 'no portal'; const sys = psp.objectSystems.get(o.mesh); const st = psp.states.get(o.mesh);
  return { systems: sys ? [...sys].map(s => ({ done: s.isDone, disp: s.isDisposed, n: s.particles && s.particles.length, id: s.emitterInfo && s.emitterInfo.id.toString(16) })) : null, suspended: psp.isAnchorSuspended(o.mesh), hidden: psp.hiddenAnchors && psp.hiddenAnchors.has(o.mesh), queued: st ? st.scripts.map(x => x.script.id && x.script.id.toString(16)) : null, clock: st && st.clock, parent: !!o.mesh.parent }; })()`);
console.log('PORTALSTATE', JSON.stringify(pst));
const door = await ev(`(() => { const som = window.__ac.serverObjectManager; const r = []; som.getAllObjects().forEach((o, g) => { if (!/Door/.test(o.name)) return; const m = o.mesh; let vis = true; let p = m; while (p) { if (!p.visible) vis = false; p = p.parent; }
  r.push({ g: g.toString(16), name: o.name, wcid: o.weenieClassId, setup: o.setupId.toString(16), ps: (o.physicsState||0).toString(16), mvis: m && m.visible, vis, pos: m && [m.position.x.toFixed(1), m.position.y.toFixed(1), m.position.z.toFixed(1)], cell: (o.cellId||0).toString(16), objCell: (o.objCellId||0).toString(16), ud: m && JSON.stringify(m.userData).slice(0,300), motion: o.motionState && JSON.stringify(o.motionState).slice(0,200) }); }); return r; })()`);
console.log(JSON.stringify(door, null, 1));
if (process.env.HIDES) {
  await ev(`window.__ac.cameraController.cameraYawOffset = 0`);
  const names = await ev<string[]>(`(() => { const sc = window.__ac.sceneManager.scene; const s = new Set(); sc.children.forEach(c => s.add((c.name || c.type).replace(/_[0-9a-f]+$/i, '').replace(/^server_.*/, 'server'))); return [...s]; })()`);
  console.log('GROUPS', JSON.stringify(names));
  for (const g of names) {
    await ev(`window.__ac.sceneManager.scene.children.forEach(c => { const n = (c.name || c.type).replace(/_[0-9a-f]+$/i, '').replace(/^server_.*/, 'server'); c.visible = n !== ${JSON.stringify(g)}; })`);
    await page.waitForTimeout(700);
    await shot(page, join(out, `hide-${g.replace(/[^a-z0-9-]/gi, '_')}.png`), { x: 760, y: 40, w: 220, h: 230 });
  }
  await ev(`window.__ac.sceneManager.scene.children.forEach(c => { c.visible = true; })`);
}
if (process.env.WALK) {
  // Walk into landblocks whose files the login gate never prefetched.
  await ev(`window.__ac.cameraController.cameraYawOffset = 0`);
  await page.mouse.click(640, 300);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(Number(process.env.WALK));
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(4000);
  await shot(page, join(out, 'after-walk.png'));
}
if (process.env.CHECK_COMPONENTS) {
  // Magic → Components on a cold profile: every carried component's icon must fill in.
  for (const w of [686, 689, 691, 774, 782, 20631]) { await chatLine(page, `@ci ${w} 5`); await page.waitForTimeout(700); }
  await page.waitForTimeout(3000);
  await ev(`(() => { const ui = window.__ac.gameUI; ui.magicPanelTab = 'components'; ui.setMagicPanelShown(true); })()`);
  const icons = () => ev<{ rows: number; withIcon: number }>(`(() => { const els = [...document.querySelectorAll('[data-element-id="0x10000468"]')].filter(e => e.offsetParent !== null);
    return { rows: els.length, withIcon: els.filter(e => e.style.backgroundImage.includes('url(')).length }; })()`);
  const first = await icons();
  await page.waitForTimeout(5000);
  const later = await icons();
  console.log('COMPONENTS', JSON.stringify({ first, later }));
  await shot(page, join(out, 'components.png'));
}
if (process.env.CHECK_DUNGEON) {
  // Inside an interior landblock: its collision + streamed cells, and whether we stand on its floor.
  const d = () => ev<Record<string, unknown>>(`(() => { const c = window.__dungeonCollision; const ac = window.__ac; const p = ac.playerModel.position;
    return { cells: c ? c.cellCount : null, cyl: c ? c.cylinderCount : null, sph: c ? c.sphereCount : null, streamCells: ac.dungeonRenderer.streamCellCount, y: +p.y.toFixed(2) }; })()`);
  const a = await d();
  await page.waitForTimeout(3000);
  const b = await d();
  console.log('DUNGEON', JSON.stringify({ a, b }));
}
if (process.env.CHECK_ANIM) {
  // Every creature in view: does it have a running animation, and do its parts move?
  const snap = () => ev<Record<string, { name: string; animated: boolean; defaultAnim: boolean; q: number[] }>>(`(() => {
    const som = window.__ac.serverObjectManager; const out = {};
    som.getAllObjects().forEach((o, g) => {
      if (!(o.itemType & 0x10) || !o.mesh || g === window.__ac.charGuid) return;
      const p = o.mesh.children.find(c => /^part_/.test(c.name));
      out[g.toString(16)] = { name: o.name, animated: som.animatedObjects.has(g), defaultAnim: som.defaultAnims.has(g), q: p ? p.quaternion.toArray().map(v => +v.toFixed(4)) : [] };
    });
    return out; })()`);
  const a = await snap();
  await page.waitForTimeout(1500);
  const b = await snap();
  const rows = Object.entries(b).map(([g, v]) => ({ g, name: v.name, animated: v.animated, defaultAnim: v.defaultAnim, moved: JSON.stringify(a[g]?.q) !== JSON.stringify(v.q) }));
  console.log('ANIMCHECK', JSON.stringify(rows));
}
if (process.env.HOLD) await page.waitForTimeout(Number(process.env.HOLD));
writeFileSync(join(out, 'console.txt'), logs.join('\n'));
await browser.close();
await profile.dispose();
