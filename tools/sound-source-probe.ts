/**
 * sound-source-probe — which objects' script/animation sound hooks fire, and
 * how many voices they hold. Wraps PhysicsScriptPlayer.dispatchHook (the
 * module instance the client runs) and counts Sound / SoundTweaked hooks per
 * anchor (name + setupId + distance), then reports the voice pool.
 * Usage: AC_BASE=http://localhost:<vite>/ AC_BRIDGE=ws://localhost:<bridge> AC_ACCOUNT=<acct> npx tsx tools/sound-source-probe.ts [--ms 20000] [--gpu]
 */
import { enterWorld, sessionArgs, telepoi } from './lib/game-session.ts';

const argv = process.argv.slice(2);
const MS = Number(argv[argv.indexOf('--ms') + 1] ?? 20000) || 20000;
const { browser, page } = await enterWorld({ settleMs: 3000, createCharacter: process.env.AC_CHAR_NAME ?? 'Sndprobe', ...sessionArgs() });
const POI = argv.includes('--poi') ? argv[argv.indexOf('--poi') + 1] : null;
if (POI) await telepoi(page, POI, 20_000);
await page.mouse.click(780, 250);
await page.evaluate(`(async () => {
  const mod = await import('/src/effects/PhysicsScriptPlayer.ts');
  const P = mod.PhysicsScriptPlayer.prototype; const rec = window.__src = {}; const o = P.dispatchHook;
  P.dispatchHook = function (hook, anchor) {
    if (hook && (hook.hookType === 1 || hook.hookType === 21)) {
      const p = anchor.getWorldPosition(new anchor.position.constructor()); const c = window.__ac.sceneManager.camera.position;
      const k = (anchor.name || '?') + ' setup=0x' + ((anchor.userData.setupId >>> 0) || 0).toString(16) + ' wave=0x' + (hook.soundId >>> 0).toString(16) + ' dist=' + Math.round(p.distanceTo(c));
      rec[k] = (rec[k] || 0) + 1;
    }
    return o.call(this, hook, anchor);
  };
  const sp = window.__ac.soundPlayer; window.__pool = []; setInterval(() => window.__pool.push(sp.voices.playingCount), 250);
})()`);
await page.waitForTimeout(MS);
const r = JSON.parse(await page.evaluate('JSON.stringify({ src: window.__src, pool: window.__pool })') as string) as { src: Record<string, number>; pool: number[] };
for (const [k, n] of Object.entries(r.src).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), k);
const full = r.pool.filter((n) => n >= 16).length;
console.log(`pool: mean ${(r.pool.reduce((a, b) => a + b, 0) / Math.max(1, r.pool.length)).toFixed(1)} / 16, full ${full}/${r.pool.length} samples`);
await browser.close();
