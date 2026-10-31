/**
 * perf-render-ab — live checks for the render-path perf changes of
 * 2026-10-31 (docs/performance-budgets.md): PERF.hidden-subtree-matrix-skip
 * and PERF.terrain-base-pool. In one session, on the real GPU:
 *   1. matrix invariant: while walking and turning, after every render each
 *      drawn, unfrozen mesh's matrixWorld is compared with the product of its
 *      chain's local transforms (CHECK … bad must be 0);
 *   2. same-frame pixel A/B of the base terrain pool against the per-block
 *      meshes at four headings (render, read pixels, swap, render again in one
 *      task, so nothing else moves between the two);
 *   3. 4× CPU-throttled speed A/B, both changes on vs both off (three's own
 *      updateMatrixWorld + the frozen per-block meshes), 3 interleaved rounds.
 * Usage (env): AC_URL / AC_BASE / AC_BRIDGE as tools/lib/game-session.ts;
 *   CHAR=<name> creates that character when the account has none;
 *   TELE='@telepoi Holtburg' (admin accounts) moves there first.
 *   npx tsx tools/perf-render-ab.ts
 * Era runs: docs/agent-play.md "Eras" (ports, BRIDGE_ERA), e.g. Dark Majesty
 *   BRIDGE_ERA=classicace-customdm bridge on 9200/9201 + &era=classicace-customdm.
 */
import { adminCommand, enterWorld } from './lib/game-session.ts';
const TELE = process.env.TELE;
const { browser, page } = await enterWorld({ gpu: true, createCharacter: process.env.CHAR, timeoutMs: 420000 });
console.log('ENTERED', await page.evaluate('location.search'));
if (TELE) { await adminCommand(page, TELE); }
await page.waitForTimeout(25000);
// 1) matrix invariant while walking
await page.evaluate(`(() => {
  const sm = window.__ac.sceneManager; const scene = sm.scene; const r = sm.renderer;
  const M = scene.matrixWorld.clone(); const L = M.clone();
  const exp = (o) => { const chain = []; for (let n = o; n; n = n.parent) chain.unshift(n); M.identity(); for (const n of chain) { if (n.matrixAutoUpdate) L.compose(n.position, n.quaternion, n.scale); else L.copy(n.matrix); M.multiply(L); } return M; };
  window.__chk = { frames: 0, checked: 0, bad: 0, maxErr: 0, samples: [] };
  const ro = r.render.bind(r);
  r.render = function (s, c) { const out = ro(s, c);
    if (s === scene && window.__chkOn) { const st = window.__chk; st.frames++;
      scene.traverseVisible((o) => { if (!o.isMesh) return;
        for (let n = o; n && n !== scene; n = n.parent) if (n.matrixWorldAutoUpdate === false) return;
        st.checked++; const e = exp(o).elements, a = o.matrixWorld.elements; let err = 0;
        for (let i = 0; i < 16; i++) err = Math.max(err, Math.abs(e[i] - a[i]));
        if (err > 1e-3) { st.bad++; if (st.samples.length < 5) { let n = o; while (n && !n.name) n = n.parent; st.samples.push((n && n.name) + ' ' + err.toFixed(4)); } }
        st.maxErr = Math.max(st.maxErr, err); }); }
    return out; };
})()`);
await page.mouse.click(780, 250);
await page.evaluate('window.__chkOn = true');
for (const [keys, ms] of [[['KeyW'], 5000], [['KeyW','KeyD'], 4000], [['KeyS'], 3000], [['ArrowRight'], 3000], [['KeyW'], 5000]] as const) {
  for (const k of keys) await page.keyboard.down(k); await page.waitForTimeout(ms); for (const k of keys) await page.keyboard.up(k);
}
await page.evaluate('window.__chkOn = false');
console.log('CHECK', JSON.stringify(await page.evaluate('window.__chk')));
// 2) terrain pixel A/B
for (const yaw of [0, 90, 180, 270]) {
  await page.evaluate(`window.acDebug.setPlayerYaw(${yaw * Math.PI / 180})`); await page.waitForTimeout(2500);
  const r = await page.evaluate(`(() => {
    const ac = window.__ac; const sm = ac.sceneManager; const r = sm.renderer; const gl = r.getContext(); const tr = ac.terrainRenderer;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const grab = () => { sm.render(); const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
    const pool = tr.baseTerrainPool.meshes; const recs = []; for (const id of tr.meshes.keys()) recs.push(tr.getMesh(id));
    const a = grab(); for (const m of pool) m.visible = false; for (const m of recs) sm.scene.add(m);
    const b = grab(); for (const m of recs) sm.scene.remove(m); for (const m of pool) m.visible = true;
    let diff = 0, maxD = 0, d1 = 0;
    for (let i = 0; i < a.length; i += 4) { let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i+k] - b[i+k])); if (d) { diff++; if (d === 1) d1++; maxD = Math.max(maxD, d); } }
    return { px: w * h, pool: pool.length, blocks: recs.length, diff, d1, maxD };
  })()`);
  console.log('PX', yaw, JSON.stringify(r));
}
// 3) throttled speed A/B (both vs base)
await page.evaluate(`(() => {
  const ac = window.__ac; const sm = ac.sceneManager; const scene = sm.scene; const r = sm.renderer; const tr = ac.terrainRenderer;
  const skipFn = scene.updateMatrixWorld, baseFn = Object.getPrototypeOf(Object.getPrototypeOf(scene)).updateMatrixWorld;
  window.__setMode = (on) => { scene.updateMatrixWorld = on ? skipFn : baseFn;
    const recs = []; for (const id of tr.meshes.keys()) recs.push(tr.getMesh(id));
    for (const m of tr.baseTerrainPool.meshes) m.visible = on;
    for (const m of recs) { if (on) { if (m.parent) scene.remove(m); } else if (!m.parent) { scene.add(m); m.updateMatrixWorld(true); m.matrixAutoUpdate = false; m.matrixWorldAutoUpdate = false; } } };
  window.__rms = []; window.__calls = []; const ro = r.render;
  r.render = function (a, b) { const t = performance.now(); const o = ro.call(this, a, b); window.__rms.push(performance.now() - t); window.__calls.push(r.info.render.calls); return o; };
  window.__fr = 0; const tick = () => { window.__fr++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
})()`);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.evaluate(`window.acDebug.setPlayerYaw(0)`); await page.waitForTimeout(3000);
const res: Record<string, string[]> = { base: [], both: [] };
for (let round = 0; round < 3; round++) for (const mode of ['base', 'both']) {
  await page.evaluate(`window.__setMode(${mode === 'both'})`); await page.waitForTimeout(1500);
  await page.evaluate('window.__rms = []; window.__calls = []; window.__fr = 0'); await page.waitForTimeout(5000);
  res[mode].push(await page.evaluate('(() => { const a = window.__rms.slice().sort((x,y)=>x-y); const c = window.__calls.slice().sort((x,y)=>x-y); return (window.__fr / 5).toFixed(1) + "fps " + a[Math.floor(a.length/2)].toFixed(1) + "ms " + c[Math.floor(c.length/2)] + "dc"; })()') as string);
}
console.log('AB', JSON.stringify(res));
await page.evaluate('window.__setMode(true)');
await browser.close();
