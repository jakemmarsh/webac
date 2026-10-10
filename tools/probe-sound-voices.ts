/**
 * probe-sound-voices — DECOMP.sound-voice-limit live check. Retail
 * SoundManager::PlaySoundInternal @ 0054fec0 plays every sound in a 16-slot
 * voice table (playing_sounds_, `& 0xf`); with every slot playing a voice of
 * equal priority (all SoundBufRefs carry priority 0) the new sound is dropped.
 * Every play entry point is gated on `(!s_bPlaySoundOnlyWhenActive ||
 * Device::m_bIsActiveApp)` (s_bPlaySoundOnlyWhenActive .data default true),
 * and voices already playing are not cut when the app deactivates.
 *
 * Patches SoundPlayer.prototype (the module instance the client runs, via
 * Vite's dev-server URL) to record every voice start and the max
 * playingCount, stands in the world for --ms of natural sound traffic, then:
 *   1. bursts 40 plays of the longest decodable wave → at most 16 start;
 *   2. dispatches a window `blur` (GameUI's real activity handler) → new
 *      plays start nothing and the playing voices keep playing;
 *   3. dispatches `focus` → plays start again.
 *
 *   npx tsx tools/probe-sound-voices.ts [--poi holtburg|none] [--ms 20000] [--create-char Name] [--out verification/sound-voices]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, telepoi, shot } from './lib/game-session.js';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const POI = arg('poi') ?? 'holtburg';
const MS = Number(arg('ms') ?? 20000);
const OUT = arg('out') ?? 'verification/sound-voices';

const HOOK = `(async () => {
  const mod = await import('/src/audio/SoundPlayer.ts');
  const rec = window.__sv = { starts: 0, dropped: 0, maxPlaying: 0, playCalls: 0, gated: 0, waves: {} };
  const P = mod.SoundPlayer.prototype;
  const origStart = P.startVoice;
  P.startVoice = function (...a) {
    window.__svPlayer = this;
    const src = origStart.apply(this, a);
    if (src) rec.starts++; else rec.dropped++;
    const n = this.voices.playingCount;
    if (n > rec.maxPlaying) rec.maxPlaying = n;
    return src;
  };
  for (const name of ['playSound', 'playPositionalSound']) {
    const orig = P[name];
    P[name] = function (waveId, ...rest) {
      window.__svPlayer = this;
      rec.playCalls++;
      if (!this.canStartSounds) rec.gated++;
      rec.waves[waveId] = (rec.waves[waveId] || 0) + 1;
      return orig.call(this, waveId, ...rest);
    };
  }
  return true;
})()`;

const BURST = `(async () => {
  const sp = window.__svPlayer;
  if (!sp) return { error: 'no SoundPlayer instance seen' };
  const ctxState = sp.audioManager.audioContext && sp.audioManager.audioContext.state;
  // the longest wave among those the world already played, else scan the low 0x0A range
  let best = 0, bestDur = 0;
  const ids = Object.keys(window.__sv.waves).map(Number);
  for (let i = 0; i < 0x200; i++) ids.push(0x0A000000 + i);
  for (const id of ids) {
    const b = await sp.decodeWave(id).catch(() => null);
    if (b && b.duration > bestDur) { best = id; bestDur = b.duration; }
  }
  window.__svWave = best;
  const before = sp.voices.playingCount;
  const results = [];
  for (let i = 0; i < 40; i++) results.push(await sp.playSound(best, 'effects', 0.05));
  const started = results.filter(Boolean).length;
  const afterBurst = sp.voices.playingCount;
  // deactivate through GameUI's real listener
  window.dispatchEvent(new Event('blur'));
  const appActive = sp.appActive, gateOpen = sp.canStartSounds;
  const inactive = [];
  for (let i = 0; i < 10; i++) inactive.push(await sp.playSound(best, 'effects', 0.05));
  const playingWhileInactive = sp.voices.playingCount;
  window.dispatchEvent(new Event('focus'));
  const reactivated = { appActive: sp.appActive, gateOpen: sp.canStartSounds };
  return {
    ctxState, wave: '0x' + best.toString(16), waveSecs: +bestDur.toFixed(2),
    burst: { calls: 40, playingBefore: before, started, playingAfter: afterBurst },
    inactive: { appActive, gateOpen, calls: 10, started: inactive.filter(Boolean).length, playingKept: playingWhileInactive },
    reactivated,
  };
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'probe-sound-voices', settleMs: 3000, createCharacter: arg('create-char') ?? 'Soundprobe' });
  const { page } = s;
  await page.evaluate(HOOK);
  // A real input gesture so the AudioContext may run under the autoplay policy.
  await page.mouse.click(5, 5);
  if (POI !== 'none') await telepoi(page, POI);
  await page.waitForTimeout(MS);
  const natural = await page.evaluate('({ ...window.__sv, waves: Object.keys(window.__sv.waves).length })');
  const burst = await page.evaluate(BURST) as Record<string, unknown> & {
    burst?: { started: number; playingAfter: number; playingBefore: number };
    inactive?: { started: number; appActive: boolean; playingKept: number };
    reactivated?: { gateOpen: boolean };
  };
  // Back after focus: one play starts again (once a slot frees; the burst waves are long, so wait them out).
  await page.waitForTimeout(Math.min(30000, ((burst.waveSecs as number) ?? 0) * 1000 + 500));
  const resumed = await page.evaluate(`(async () => { const sp = window.__svPlayer; const r = await sp.playSound(window.__svWave || 0x0A000001, 'effects', 0.05); return { started: !!r, playing: sp.voices.playingCount, maxPlaying: window.__sv.maxPlaying }; })()`).catch((e) => ({ error: String(e) }));
  await shot(page, `${OUT}/scene.png`);
  const summary = { poi: POI, ms: MS, natural, ...burst, resumed };
  writeFileSync(`${OUT}/result.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 1));
  await s.browser.close();
  const b = burst.burst, ina = burst.inactive;
  const ok = !!b && b.playingBefore + b.started <= 16 && b.playingAfter <= 16
    && !!ina && !ina.appActive && ina.started === 0 && !!burst.reactivated?.gateOpen
    && (natural as { maxPlaying: number }).maxPlaying <= 16;
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
