/**
 * sound-start-probe — logs every sound request AND whether it started a
 * voice (SoundPlayer.startVoice), with the category gain/mute state, across
 * a jump and a teleport (TELE_CMD, default @telepoi Shoushi): portal enter,
 * tunnel drone, exit. Also logs GameUI.playUISound and the teleport state.
 * audio-probe.ts logs requests only; a request that never reaches a voice
 * (missing wave, attenuated to 0, muted, inactive-gated) looks the same there.
 * Usage: [TELE_CMD='@telepoi Holtburg'] [TELE_WAIT_MS=25000] AC_BASE=http://localhost:3017/ AC_BRIDGE=ws://localhost:9097 AC_ACCOUNT=sndprobe1 npx tsx tools/sound-start-probe.ts [--gpu]
 */
import { enterWorld, chatLine, sessionArgs } from './lib/game-session.ts';

const { browser, page } = await enterWorld({ settleMs: 3000, createCharacter: process.env.AC_CHAR_NAME ?? 'Sndprobe', ...sessionArgs() });
await page.mouse.click(780, 250); // a user gesture: AudioContext starts
await page.waitForTimeout(500);
await page.evaluate(`(() => { const a = window.__ac; window.__beat = 'start'; window.__snd = [];
  const sp = a.soundPlayer, am = a.audioManager;
  const hex = (w) => typeof w === 'number' ? '0x' + (w >>> 0).toString(16).padStart(8, '0') : String(w);
  const log = (kind, o) => window.__snd.push({ beat: window.__beat, t: Math.round(performance.now()), kind, ...o });
  const wrap = (name, f) => { const o = sp[name].bind(sp); sp[name] = (...x) => { log(name, f(x)); return o(...x); }; };
  wrap('playGameSound', (x) => ({ table: hex(x[0]), sound: x[1], cat: x[2] }));
  wrap('playFromCenter', (x) => ({ wave: hex(x[0]), vol: x[1], cat: x[2] }));
  wrap('playSound', (x) => ({ wave: hex(x[0]), cat: x[1], vol: x[2], src: x[3] }));
  wrap('playPositionalSound', (x) => ({ wave: hex(x[0]), cat: x[3], vol: x[4], dist: Math.round(Math.hypot(x[1].x - x[2].x, x[1].y - x[2].y, x[1].z - x[2].z)) }));
  const sv = sp.startVoice.bind(sp); sp.startVoice = (ctx, buf, cat, vol, pan) => { const r = sv(ctx, buf, cat, vol, pan); log('VOICE', { cat, vol, pan, dur: buf.duration, started: !!r, catGain: am.getCategoryGain(cat)?.gain.value }); return r; };
  const ui = a.gameUI; const pu = ui.playUISound.bind(ui); ui.playUISound = (snd) => { log('playUISound', { sound: snd, hasSp: !!ui.soundPlayer }); return pu(snd); };
  setInterval(() => { const st = ui.portalSpaceState; if (st !== window.__lastPs) { window.__lastPs = st; log('PORTAL-STATE', { st, pool: sp.voices.playingCount }); } }, 50);
  const dw = sp.decodeWave.bind(sp); sp.decodeWave = async (w, src) => { const b = await dw(w, src); if (!b) log('DECODE-NULL', { wave: hex(w), src }); return b; };
})()`);
page.on('console', (m) => { if (/teleport|portal|lifestone|recall/i.test(m.text())) console.log('CONSOLE', m.text().slice(0, 200)); });
const beat = (b: string) => page.evaluate(`window.__beat = ${JSON.stringify(b)}`);
const state = () => page.evaluate(`(() => { const am = window.__ac.audioManager, sp = window.__ac.soundPlayer;
  return { ctx: am.audioContext && am.audioContext.state, canStart: sp.canStartSounds, appActive: sp.appActive,
    cats: Object.fromEntries(['effects','ambient','ui','music'].map((c) => [c, { vol: am.getCategoryVolume(c), muted: am.isCategoryMuted(c), gain: am.getCategoryGain(c)?.gain.value }])) }; })()`);
console.log('state', JSON.stringify(await state()));

await beat('jump'); await page.keyboard.down('Space'); await page.waitForTimeout(600); await page.keyboard.up('Space'); await page.waitForTimeout(2500);
await beat('teleport'); await chatLine(page, process.env.TELE_CMD ?? '@telepoi Shoushi');
await page.waitForTimeout(Number(process.env.TELE_WAIT_MS ?? 40000));
await beat('end');
console.log('state', JSON.stringify(await state()));
const out = JSON.parse(await page.evaluate('JSON.stringify(window.__snd)') as string) as Array<Record<string, unknown>>;
for (const s of out) console.log(JSON.stringify(s));
await browser.close();
