/**
 * sound-pan-probe — RECON.ambient-sound-weighting.pan live check (one-off).
 * Enters the world at a POI and records every ambient play (offset, distance,
 * the camera heading it panned against, the pan) and every panned voice the
 * audio graph built (SoundPlayer.connectPanned), while the player stands,
 * turns, and then with Sound Features Mono (SoundPlayer.stereo = false).
 * Each recorded ambient pan is re-derived here with RetailSound.retailSoundPan.
 * Usage: npx tsx tools/archive/sound-pan-probe.ts [--poi Holtburg] [--phase-ms 15000]
 * Writes verification/audio/sound-pan-<utc>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, enterWorld, telepoi } from '../lib/game-session.ts';
import { retailSoundPan } from '../../packages/renderer/src/audio/RetailSound.ts';

const args = process.argv.slice(2);
const POI = args.includes('--poi') ? args[args.indexOf('--poi') + 1] : 'Holtburg';
const PHASE_MS = args.includes('--phase-ms') ? Number(args[args.indexOf('--phase-ms') + 1]) : 15000;

const { browser, page } = await enterWorld({ settleMs: 3000 });
await telepoi(page, POI);
await page.mouse.click(780, 250); // a user gesture: the AudioContext may start
await page.evaluate(`(() => {
  const m = window.__ac.ambientSoundManager; const sp = m.soundPlayer;
  window.__pan = { phase: 'stand', amb: [], graph: [] };
  const vh = m.viewerHeading; let last = null;
  m.viewerHeading = () => (last = vh());
  m.onPlay = (p) => window.__pan.amb.push({ phase: window.__pan.phase, heading: last, ...p });
  const C = sp.constructor; const orig = C.connectPanned;
  C.connectPanned = (ctx, src, out, pan) => { window.__pan.graph.push({ phase: window.__pan.phase, pan }); return orig(ctx, src, out, pan); };
})()`);
const phase = async (name: string, ms: number, key?: string) => {
  await page.evaluate(`window.__pan.phase = ${JSON.stringify(name)}`);
  if (key) await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  if (key) await page.keyboard.up(key);
};
await phase('stand', PHASE_MS);
await phase('turning', PHASE_MS, 'KeyD');
await phase('stand-turned', PHASE_MS);
await page.evaluate('window.__ac.ambientSoundManager.soundPlayer.stereo = false');
await phase('mono', PHASE_MS);
await page.evaluate('window.__ac.ambientSoundManager.soundPlayer.stereo = true');
const rec = JSON.parse(await page.evaluate('JSON.stringify(window.__pan)') as string) as {
  amb: Array<{ phase: string; heading: number | null; dx: number; dy: number; distance: number; pan: number; sType: number }>;
  graph: Array<{ phase: string; pan: number }>;
};
const ctx = await page.evaluate('window.__ac.audioManager && window.__ac.audioManager.audioContext ? window.__ac.audioManager.audioContext.state : "none"');
await browser.close();

const checked = rec.amb.map((p) => {
  const expected = p.phase === 'mono' || (!p.dx && !p.dy) || p.heading === null ? 0 : retailSoundPan(-p.dx, -p.dy, p.distance, p.heading);
  return { ...p, expected, ok: expected === p.pan };
});
const byPhase: Record<string, { ambient: number; positional: number; panned: number; graphPanned: number; pans: number[] }> = {};
for (const p of checked) {
  const b = (byPhase[p.phase] ??= { ambient: 0, positional: 0, panned: 0, graphPanned: 0, pans: [] });
  b.ambient++;
  if (p.dx || p.dy) b.positional++;
  if (p.pan) { b.panned++; b.pans.push(p.pan); }
}
for (const g of rec.graph) (byPhase[g.phase] ??= { ambient: 0, positional: 0, panned: 0, graphPanned: 0, pans: [] }).graphPanned++;
const summary = { poi: POI, audioContext: ctx, plays: checked.length, mismatches: checked.filter((p) => !p.ok).length, byPhase };
console.log(JSON.stringify(summary, null, 1));
const dir = resolve(REPO, 'verification/audio');
mkdirSync(dir, { recursive: true });
const out = resolve(dir, `sound-pan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({ summary, plays: checked, graph: rec.graph }, null, 1));
console.log('wrote', out);
