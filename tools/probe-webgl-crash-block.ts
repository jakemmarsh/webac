import { chromium } from 'playwright';
import { createRunProfile } from './lib/temp-profile.js';
/**
 * Reproduces Chromium's graphics-crash block (BUG.webgl-crash-block-wait, 2026-11-16): two game tabs
 * open, the GPU process crashed through chrome://gpucrash, then a fresh tab boots. Prints the capability
 * screen's text, and when (if) it closes by itself.
 *
 *   npx tsx tools/probe-webgl-crash-block.ts [url=http://localhost:5173/] [out=/tmp/webgl-crash-block]
 */
async function main(): Promise<void> {
  const URL = process.argv[2] ?? 'http://localhost:5173/';
  const OUT = process.argv[3] ?? '/tmp/webgl-crash-block';
  const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const prof = createRunProfile('acjs-gpucrash-', { tool: 'gpucrash-probe' });
  const ctx = await chromium.launchPersistentContext(prof.dir, { headless: true, viewport: { width: 1000, height: 750 } });
  prof.setCloser(() => ctx.close());
  const watch = (p: any, name: string) => p.on('console', (m: any) => { const t = m.text(); if (/capability|WebGL|context/i.test(t)) console.log(ts(), name, t.slice(0, 200)); });
  const a = await ctx.newPage(); watch(a, 'A'); await a.goto(URL);
  const b = await ctx.newPage(); watch(b, 'B'); await b.goto(URL);
  await a.waitForTimeout(12000);
  // Each tab holds a WebGL 2 context of its own, so the crash records two losses for the site (the player had two tabs).
  for (const [p, n] of [[a, 'A'], [b, 'B']] as const) {
    await p.evaluate((name) => {
      const gl = document.createElement('canvas').getContext('webgl2');
      (window as any).__probeGl = gl;
      gl?.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.log(`[probe] ${name} context lost`); });
      console.log(`[probe] ${name} holds a WebGL 2 context: ${!!gl}`);
    }, n);
  }
  console.log(ts(), 'crashing the GPU process');
  // chrome://gpucrash is refused under automation; the DevTools protocol's own command crashes it.
  const cdp = await ctx.newCDPSession(a);
  await cdp.send('Browser.crashGpuProcess' as any).catch((e: unknown) => console.log('crashGpuProcess:', String(e).slice(0, 160)));
  await a.waitForTimeout(4000);
  const d = await ctx.newPage(); watch(d, 'D');
  // A crash the DevTools protocol causes carries no guilt, so Chromium doesn't block the site for it. With
  // BLOCK_MS set, tab D's WebGL 2 creation fails the way a blocked site's does (null + webglcontextcreationerror
  // with Chromium's status text) until BLOCK_MS after its load; everything else in the boot is real.
  const blockMs = Number(process.env.BLOCK_MS ?? 0);
  if (blockMs > 0) {
    await d.addInitScript((ms: number) => {
      const until = performance.now() + ms;
      const real = HTMLCanvasElement.prototype.getContext;
      (HTMLCanvasElement.prototype as any).getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        if ((kind === 'webgl2' || kind === 'webgl') && performance.now() < until) {
          const ev = new Event('webglcontextcreationerror') as any;
          ev.statusMessage = 'Web page caused context loss and was blocked';
          this.dispatchEvent(ev);
          return null;
        }
        return (real as any).call(this, kind, ...rest);
      };
    }, blockMs);
  }
  await d.goto(URL);
  const screenText = async () => d.evaluate(() => (document.getElementById('capability-screen')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400)).catch(() => '');
  await d.waitForTimeout(3000);
  console.log(ts(), 'D screen:', await screenText());
  await d.screenshot({ path: OUT + '-blocked.png' });
  let gone = false;
  for (let i = 0; i < 34 && !gone; i++) { await d.waitForTimeout(5000); const s = await screenText(); if (!s) { gone = true; console.log(ts(), 'D capability screen closed'); } }
  await d.waitForTimeout(6000);
  await d.screenshot({ path: OUT + '-after.png' });
  console.log(ts(), 'D visible text after:', (await d.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200)).catch(() => '')));
  await prof.dispose();
}
void main();
