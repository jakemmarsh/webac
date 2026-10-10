/**
 * probe-hover-cost — what the per-frame mouse-over find costs on the real
 * GPU. SWEEP1006B.player-input moved the hover find from a 10 Hz poll to
 * every rendered frame, as retail's SmartBox does (the search runs each
 * frame the pointer is over the 3D view). Measured in one session, Holtburg:
 *  - frame rate with the pointer over the 3D view (a find every frame) vs
 *    over the chat window (no find), alternated three times each;
 *  - the mean cost of one getObjectAtScreenPos ray (1000 calls at the
 *    view's centre).
 * Writes verification/perf/hover-cost-<utc>.json.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-hover-cost.ts [--secs N]
 * (always --gpu: SwiftShader frame times say nothing about this cost)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { adminCommand, enterWorld, gameUrl } from './lib/game-session.ts';

const SECS = (() => { const i = process.argv.indexOf('--secs'); return i >= 0 ? Number(process.argv[i + 1]) : 6; })();
const account = process.env.AC_ACCOUNT ?? 'fxprobe1';

async function main(): Promise<void> {
  const s = await enterWorld({ gpu: true, settleMs: 4000, url: gameUrl({ cb: 'hover-cost', env: { ...process.env, AC_ACCOUNT: account, AC_PASSWORD: process.env.AC_PASSWORD ?? account } }) } as never);
  const P = s.page;
  try {
    const gl = await P.evaluate(`(() => { const c = document.createElement('canvas').getContext('webgl'); const e = c && c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`) as string;
    if (/swiftshader|software|llvmpipe/i.test(gl)) throw new Error(`software renderer (${gl}): the cost would mean nothing`);
    await adminCommand(P, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
    await P.waitForTimeout(12_000);
    const view = await P.evaluate(`(() => { const r = window.__ac.sceneManager.renderer.domElement.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.45 }; })()`) as { x: number; y: number };
    const chat = await P.evaluate(`(() => { const e = document.getElementById('chat-input'); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
    const sample = async (pt: { x: number; y: number }) => {
      await P.mouse.move(pt.x, pt.y);
      await P.waitForTimeout(800);
      return P.evaluate(`new Promise((done) => { const som = window.__ac.serverObjectManager; const orig = som.getObjectAtScreenPos.bind(som);
        let finds = 0; som.getObjectAtScreenPos = (rc) => { finds++; return orig(rc); };
        const d = []; let last = performance.now(); let live = true;
        const tick = (t) => { if (!live) return; d.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
        setTimeout(() => { live = false; som.getObjectAtScreenPos = orig; d.shift(); d.sort((a, b) => a - b);
          const mean = d.reduce((a, b) => a + b, 0) / d.length;
          done({ frames: d.length, finds, fps: +(1000 / mean).toFixed(1), p95ms: +d[Math.floor(d.length * 0.95)].toFixed(2) }); }, ${SECS * 1000}); })`) as Promise<{ frames: number; finds: number; fps: number; p95ms: number }>;
    };
    const over: unknown[] = []; const off: unknown[] = [];
    for (let i = 0; i < 3; i++) { over.push(await sample(view)); off.push(await sample(chat)); }
    await P.mouse.move(view.x, view.y);
    const perCall = await P.evaluate(`(() => { const ac = window.__ac; const som = ac.serverObjectManager;
      // Reuse the game's own raycaster via one real find (captured from the hover path).
      let rc = null; const orig = som.getObjectAtScreenPos.bind(som);
      som.getObjectAtScreenPos = (r) => { rc = r; return orig(r); };
      return new Promise((done) => setTimeout(() => { som.getObjectAtScreenPos = orig;
        if (!rc) { done(null); return; }
        const t0 = performance.now(); for (let i = 0; i < 1000; i++) orig(rc); const ms = (performance.now() - t0) / 1000;
        done({ msPerFind: +ms.toFixed(4), objects: som.objects.size }); }, 300)); })()`);
    const out = { at: new Date().toISOString(), renderer: gl, secs: SECS, overView: over, overChat: off, perCall };
    console.log(JSON.stringify(out, null, 1));
    mkdirSync('verification/perf', { recursive: true });
    writeFileSync(`verification/perf/hover-cost-${out.at.replace(/[:.]/g, '-')}.json`, JSON.stringify(out, null, 2));
  } finally {
    await s.browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
