/**
 * In-session A/B helpers (PERF passes, docs/perf-pass-2026-11-15.md): a probe installs
 * `window.__abSet(b: boolean)` in the page, switching the scene between its A (false) and
 * B (true) structure, and these measure the two in the same session:
 *  - pixelAB: at each heading, render A, read back, switch, render B, read back, switch, render A
 *    again (the repeat must match A, or the scene was not still), and count differing pixels;
 *  - speedAB: under CDP CPU throttling while the character circles (W+D), the two alternate every
 *    sliceMs; frameStep (window.__ac.framePhases), renderer.render and rAF frame times are kept per side.
 */
import type { Page } from 'playwright';

export interface PixelResult { yaw: number; px: number; nonBlackPct: number; diff: number; maxD: number; sameModeRepeatDiff: number; callsA: number; callsB: number }

export async function pixelAB(page: Page, yaws: number[], log = (s: string) => console.log(s)): Promise<PixelResult[]> {
  const out: PixelResult[] = [];
  for (const yaw of yaws) {
    await page.evaluate(`window.acDebug.setPlayerYaw(${yaw * Math.PI / 180})`);
    await page.waitForTimeout(2500);
    const r = await page.evaluate(`(() => {
      const sm = window.__ac.sceneManager; const gl = sm.renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const grab = () => { sm.render(); const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return { px, calls: sm.renderer.info.render.calls }; };
      // Warm both sides first (a first draw may compile or upload).
      window.__abSet(true); sm.render(); window.__abSet(false); sm.render();
      const a = grab(); window.__abSet(true); const b = grab(); window.__abSet(false); const c = grab();
      let diff = 0, maxD = 0, nonBlack = 0, repeat = 0;
      for (let i = 0; i < a.px.length; i += 4) {
        let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.px[i + k] - b.px[i + k]));
        if (d) { diff++; maxD = Math.max(maxD, d); }
        if (a.px[i] + a.px[i + 1] + a.px[i + 2] > 30) nonBlack++;
        if (a.px[i] !== c.px[i] || a.px[i + 1] !== c.px[i + 1] || a.px[i + 2] !== c.px[i + 2]) repeat++;
      }
      return { px: w * h, nonBlackPct: +(100 * nonBlack / (w * h)).toFixed(1), diff, maxD, sameModeRepeatDiff: repeat, callsA: a.calls, callsB: b.calls };
    })()`) as Omit<PixelResult, 'yaw'>;
    log(`PX ${yaw} ${JSON.stringify(r)}`);
    out.push({ yaw, ...r });
  }
  return out;
}

export interface SideStats { n: number; mean: number; p50: number; p95: number }

export async function speedAB(page: Page, opts: { throttle: number; rounds: number; sliceMs: number; labels: [string, string] }): Promise<Record<string, { frameStep: SideStats; render: SideStats; frame: SideStats }>> {
  const [la, lb] = opts.labels;
  await page.evaluate(`(() => {
    const ac = window.__ac; const r = ac.sceneManager.renderer; const fp = ac.framePhases;
    window.__mode = ${JSON.stringify(la)}; window.__drop = 2;
    window.__ab = { ${JSON.stringify(la)}: { work: [], render: [], frames: [] }, ${JSON.stringify(lb)}: { work: [], render: [], frames: [] } };
    let lastFp = -1, last = -1;
    const ro = r.render; r.render = function (a, b) { const t = performance.now(); const o = ro.call(this, a, b); if (a === ac.sceneManager.scene && window.__drop <= 0) window.__ab[window.__mode].render.push(performance.now() - t); return o; };
    requestAnimationFrame(function tick(t) {
      if (window.__drop > 0) { window.__drop--; last = t; lastFp = fp.frames; requestAnimationFrame(tick); return; }
      if (last >= 0) window.__ab[window.__mode].frames.push(t - last); last = t;
      if (fp.frames !== lastFp) { if (lastFp >= 0) { let w = 0; for (const v of fp.frameMs) w += v; window.__ab[window.__mode].work.push(w); } lastFp = fp.frames; }
      requestAnimationFrame(tick); });
  })()`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.throttle });
  await page.keyboard.down('KeyW'); await page.keyboard.down('KeyD');
  for (let i = 0; i < opts.rounds * 2; i++) {
    const b = i % 2 === 1;
    await page.evaluate(`window.__abSet(${b}); window.__mode = ${JSON.stringify(b ? lb : la)}; window.__drop = 2`);
    await page.waitForTimeout(opts.sliceMs);
  }
  await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const ab = await page.evaluate('window.__ab') as Record<string, { work: number[]; render: number[]; frames: number[] }>;
  const st = (v: number[]): SideStats => { const s = [...v].sort((a, b) => a - b); const m = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); return { n: v.length, mean: +m.toFixed(2), p50: +(s[Math.floor(s.length / 2)] ?? 0).toFixed(2), p95: +(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(2) }; };
  return Object.fromEntries(Object.entries(ab).map(([k, v]) => [k, { frameStep: st(v.work), render: st(v.render), frame: st(v.frames) }]));
}
