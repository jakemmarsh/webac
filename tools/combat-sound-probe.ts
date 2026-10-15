/**
 * combat-sound-probe — "I hear ambient but no combat": spawns a Drudge
 * Skulker (@create 7), fights it, and logs every sound REQUEST (playSound,
 * playPositionalSound, playFromCenter, playGameSound), every voice start
 * (SoundPlayer.startVoice, started true/false), null decodes, the animation
 * Sound / SoundTweaked / SoundTable hooks reaching PhysicsScriptPlayer, and
 * the server Sound (0xF750) outcomes the client logs ("[AC] Sound …").
 * A request that never gets a voice, or a hook that never makes a request,
 * shows up as a gap between the columns.
 * --no-click plays it the way an agent window does: no user gesture at all
 * (BUG.combat-sounds-need-a-click: ambient played, swings and hits did not).
 * Usage: AC_BASE=http://localhost:3177/ AC_ACCOUNT=sndcombat1 npx tsx tools/combat-sound-probe.ts [--gpu] [--no-click]
 */
import { adminCommand, enterWorld, sessionArgs } from './lib/game-session.ts';

const { browser, page } = await enterWorld({ settleMs: 3000, createCharacter: process.env.AC_CHAR_NAME ?? 'Sndcombat', ...sessionArgs() });
const serverSounds: string[] = [];
page.on('console', (m) => { const t = m.text(); if (t.startsWith('[AC] Sound ')) serverSounds.push(t); });
if (!process.argv.includes('--no-click')) await page.mouse.click(780, 250); // a user gesture: the AudioContext opens
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
  const sv = sp.startVoice.bind(sp); sp.startVoice = (ctx, buf, cat, vol, pan) => { const r = sv(ctx, buf, cat, vol, pan); log('VOICE', { cat, vol: +vol.toFixed(3), dur: +buf.duration.toFixed(2), started: !!r, pool: sp.voices.playingCount }); return r; };
  const dw = sp.decodeWave.bind(sp); sp.decodeWave = async (w, src) => { const b = await dw(w, src); if (!b) log('DECODE-NULL', { wave: hex(w), src }); return b; };
  const psp = a.physicsScriptPlayer; const eh = psp.executeHook.bind(psp);
  psp.executeHook = (hook, group, ...rest) => { const t = hook && hook.hookType; if (t === 1 || t === 2 || t === 3 || t === 13) log('HOOK', { type: t, data: JSON.stringify(hook.data ?? hook).slice(0, 80), name: group && (group.name || (group.userData && group.userData.name)) }); return eh(hook, group, ...rest); };
})()`);
const beat = (b: string) => page.evaluate(`window.__beat = ${JSON.stringify(b)}`);
const state = () => page.evaluate(`(() => { const am = window.__ac.audioManager, sp = window.__ac.soundPlayer;
  return { ctx: am.audioContext && am.audioContext.state, canStart: sp.canStartSounds, appActive: sp.appActive,
    cats: Object.fromEntries(['effects','ambient','ui'].map((c) => [c, { vol: am.getCategoryVolume(c), muted: am.isCategoryMuted(c) }])) }; })()`);
console.log('state', JSON.stringify(await state()));

await beat('idle'); await page.waitForTimeout(4000);
await beat('combat');
await adminCommand(page, '@create 7'); await page.waitForTimeout(3000);
await page.keyboard.press('Backquote'); await page.waitForTimeout(1500); // combat mode
await page.keyboard.press('Quote'); await page.waitForTimeout(500);      // select closest monster
for (let k = 0; k < 6; k++) { await page.keyboard.press('PageDown'); await page.waitForTimeout(2500); } // attack
await page.waitForTimeout(3000);
await page.keyboard.press('Backquote'); await page.waitForTimeout(1500);
await beat('end');
console.log('state', JSON.stringify(await state()));

const out = JSON.parse(await page.evaluate('JSON.stringify(window.__snd)') as string) as Array<Record<string, unknown>>;
const findSpawn = () => page.evaluate(`(() => { const o = (window.acDebug.getObjects() || []).filter((x) => x.name === 'Drudge Skulker' && x.guid >= 0x80000000); return o.length ? o[o.length - 1].guid : null; })()`) as Promise<number | null>;
for (let g = await findSpawn(), n = 0; g !== null && n < 5; g = await findSpawn(), n++) {
  await page.evaluate(`window.acDebug.select(${g}); window.__ac.identifyObject(${g});`); await page.waitForTimeout(1200);
  await adminCommand(page, '@delete'); await page.waitForTimeout(1200);
}
await browser.close();

const counts = new Map<string, number>();
for (const s of out) { const k = `${s.beat} ${s.kind}${s.kind === 'VOICE' ? ` started=${s.started} ${s.cat}` : s.cat ? ` ${s.cat}` : ''}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
for (const [k, n] of counts) console.log(`${String(n).padStart(4)} × ${k}`);
const started = out.filter((x) => x.beat === 'combat' && x.kind === 'VOICE' && x.started).length;
const combatReq = out.filter((x) => x.beat === 'combat' && x.kind === 'playPositionalSound').length;
console.log(`\nCOMBAT: ${combatReq} positional requests, ${started} voices started, ${serverSounds.length} server Sound messages played/refused`);
console.log('\ncombat detail:');
for (const s of out.filter((x) => x.beat === 'combat' && x.kind !== 'playSound')) console.log(JSON.stringify(s));
console.log(`\nserver Sound messages (${serverSounds.length}):`);
for (const l of serverSounds.slice(0, 40)) console.log(l);
