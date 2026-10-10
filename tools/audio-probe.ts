/**
 * audio-probe — the scorecard's flow-audio, live. Wraps the client's sound
 * entry points (SoundPlayer.playSound / playPositionalSound / playLoop,
 * MusicPlayer.play) and logs every sound started, tagged with the beat that
 * caused it: clicking UI buttons, opening panels, running (footsteps),
 * fighting a spawned Drudge Skulker (swings, hits, monster voice), standing
 * idle outdoors (ambient), and a portal (teleport). Also records the
 * AudioContext state and the ambient manager's active sounds.
 * Usage: npx tsx tools/audio-probe.ts [--poi Holtburg]
 * Writes verification/audio/audio-probe-<utc>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, adminCommand, enterWorld } from './lib/game-session.ts';

const args = process.argv.slice(2);
const POI = args.includes('--poi') ? args[args.indexOf('--poi') + 1] : 'Holtburg';

const { browser, page } = await enterWorld({ settleMs: 3000 });
const settleTeleport = async (cmd: string) => {
  let done = false;
  const f = (m: { text(): string }) => { if (/Sent LoginComplete/.test(m.text())) done = true; };
  page.on('console', f); await adminCommand(page, cmd);
  for (let i = 0; i < 120 && !done; i++) await page.waitForTimeout(500);
  page.off('console', f); await page.waitForTimeout(4000);
};
await settleTeleport('@telepoi ' + POI);
await page.mouse.click(780, 250); // a user gesture: the AudioContext may start
await page.evaluate(`(() => { const a = window.__ac; window.__beat = 'start'; window.__snd = [];
  const log = (kind, wave, category, extra) => window.__snd.push({ beat: window.__beat, t: Math.round(performance.now()), kind, wave: typeof wave === 'number' ? '0x' + wave.toString(16).padStart(8, '0') : String(wave), category, ...(extra || {}) });
  const sp = a.soundPlayer;
  for (const m of ['playSound', 'playLoop']) { const o = sp[m].bind(sp); sp[m] = (w, c, v) => { log(m, w, c, { vol: v }); return o(w, c, v); }; }
  const op = sp.playPositionalSound.bind(sp); sp.playPositionalSound = (...x) => { const d = Math.hypot(x[1].x - x[2].x, x[1].y - x[2].y, x[1].z - x[2].z); log('positional', x[0], x[3], { dist: Math.round(d), vol: x[4] }); return op(...x); };
  if (a.musicPlayer) { const om = a.musicPlayer.play.bind(a.musicPlayer); a.musicPlayer.play = (id, b, l) => { log('music', id, 'music'); return om(id, b, l); }; }
})()`);
const beat = (b: string) => page.evaluate(`window.__beat = ${JSON.stringify(b)}`);

await beat('idle-outdoors'); await page.waitForTimeout(20000);
await beat('ui-panels');
for (const key of ['F12', 'F9', 'F10']) { await page.keyboard.press(key); await page.waitForTimeout(800); await page.keyboard.press(key); await page.waitForTimeout(400); }
await beat('running');
await page.keyboard.down('KeyW'); await page.waitForTimeout(6000); await page.keyboard.up('KeyW');
await beat('combat');
await adminCommand(page, '@create 7'); await page.waitForTimeout(3000);
await page.keyboard.press('Quote'); await page.waitForTimeout(500);
await page.keyboard.press('Backquote'); await page.waitForTimeout(1500);
for (let k = 0; k < 4; k++) { await page.keyboard.press('PageDown'); await page.waitForTimeout(2500); }
await page.keyboard.press('Backquote'); await page.waitForTimeout(1500);
await beat('teleport'); await settleTeleport('@telepoi Shoushi');
await beat('end');

const out = JSON.parse(await page.evaluate(`JSON.stringify({ ctx: window.__ac.audioManager && window.__ac.audioManager.audioContext ? window.__ac.audioManager.audioContext.state : 'none',
  ambient: window.__ac.ambientSoundManager ? window.__ac.ambientSoundManager.getActiveSoundStates() : null, sounds: window.__snd })`) as string);
// Remove the spawned monster(s) so later probes start clean (perf-soak's removeSpawn).
const findSpawn = () => page.evaluate(`(() => { const o = (window.acDebug.getObjects() || []).filter((x) => x.name === 'Drudge Skulker' && x.guid >= 0x80000000); return o.length ? o[o.length - 1].guid : null; })()`) as Promise<number | null>;
await settleTeleport('@telepoi ' + POI);
for (let g = await findSpawn(), n = 0; g !== null && n < 5; g = await findSpawn(), n++) {
  await page.evaluate(`window.acDebug.select(${g}); window.__ac.identifyObject(${g});`); await page.waitForTimeout(1200);
  await adminCommand(page, '@delete'); await page.waitForTimeout(1200);
}
await browser.close();

const byBeat = new Map<string, Map<string, number>>();
for (const s of out.sounds as Array<{ beat: string; kind: string; wave: string; category: string }>) {
  const m = byBeat.get(s.beat) ?? new Map(); const d = (s as { dist?: number }).dist; const k = `${s.kind} ${s.wave} ${s.category ?? ''}${d === undefined ? '' : d <= 30 ? ' near(<=30m)' : ' far'}`; m.set(k, (m.get(k) ?? 0) + 1); byBeat.set(s.beat, m);
}
console.log(`AudioContext: ${out.ctx}   ambient active: ${JSON.stringify(out.ambient)?.slice(0, 300)}`);
for (const [b, m] of byBeat) { console.log(`\n${b}:`); for (const [k, n] of m) console.log(`  ${String(n).padStart(3)} × ${k}`); }
mkdirSync(resolve(REPO, 'verification/audio'), { recursive: true });
const file = resolve(REPO, `verification/audio/audio-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log('wrote', file);
