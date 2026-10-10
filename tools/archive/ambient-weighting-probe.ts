/**
 * ambient-weighting-probe — RECON.ambient-sound-weighting live check (one-off).
 * Enters the world, teleports to a POI, and samples the ambient manager while
 * walking: the gathered total weight, each active sound's weighted volume /
 * play chance / direction bands, and every Ambient::Play (distance, offset).
 * Usage: npx tsx tools/archive/ambient-weighting-probe.ts [--poi Holtburg] [--walk-ms 12000]
 * Writes verification/audio/ambient-weighting-<utc>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, enterWorld, telepoi, collisionState } from '../lib/game-session.ts';

const args = process.argv.slice(2);
const POI = args.includes('--poi') ? args[args.indexOf('--poi') + 1] : 'Holtburg';
const WALK_MS = args.includes('--walk-ms') ? Number(args[args.indexOf('--walk-ms') + 1]) : 12000;

const { browser, page } = await enterWorld({ settleMs: 3000 });
await telepoi(page, POI);
await page.mouse.click(780, 250); // a user gesture: the AudioContext may start
await page.evaluate(`(() => { const m = window.__ac.ambientSoundManager; window.__amb = [];
  m.onPlay = (p) => window.__amb.push({ t: Math.round(performance.now()), ...p }); })()`);
const sample = async (tag: string) => {
  const pos = await collisionState(page);
  const s = JSON.parse(await page.evaluate(`JSON.stringify({ total: window.__ac.ambientSoundManager.getTotalSoundCount(),
    active: window.__ac.ambientSoundManager.getActiveSoundStates().map(s => ({ stb: s.stbIndex, sType: s.sType, cont: s.isContinuous,
      count: +s.soundCount.toFixed(3), vol: +s.currentVolume.toFixed(4), chance: +s.playChance.toFixed(4), onQueue: s.onQueue,
      dirs: s.dirs.map(d => d.dir + ':' + d.min.toFixed(0) + '-' + d.max.toFixed(0)).join(' ') })) })`) as string);
  return { tag, x: Math.round(pos.x), z: Math.round(pos.z), ...s };
};
const samples = [await sample('arrive')];
await page.waitForTimeout(8000);
samples.push(await sample('idle-8s'));
await page.keyboard.down('KeyW');
for (let t = 0; t < WALK_MS; t += 3000) { await page.waitForTimeout(3000); samples.push(await sample(`walk-${t + 3000}`)); }
await page.keyboard.up('KeyW');
await page.waitForTimeout(6000);
samples.push(await sample('stop'));
const plays = JSON.parse(await page.evaluate('JSON.stringify(window.__amb)') as string);
const ctx = await page.evaluate('window.__ac.audioManager && window.__ac.audioManager.audioContext ? window.__ac.audioManager.audioContext.state : "none"');
await browser.close();

for (const s of samples) {
  const stbs = [...new Set(s.active.map((a: { stb: number }) => a.stb))];
  console.log(`${s.tag.padEnd(10)} (${s.x},${s.z}) total=${s.total.toFixed(3)} stbs=[${stbs}] active=${s.active.length}`);
}
console.log(`AudioContext ${ctx}; ${plays.length} Ambient::Play starts; from centre ${plays.filter((p: { distance: number }) => p.distance === 0).length}, positional ${plays.filter((p: { distance: number }) => p.distance > 0).length}`);
mkdirSync(resolve(REPO, 'verification/audio'), { recursive: true });
const file = resolve(REPO, `verification/audio/ambient-weighting-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ poi: POI, ctx, samples, plays }, null, 1) + '\n');
console.log('wrote', file);
