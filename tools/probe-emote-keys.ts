/**
 * probe-emote-keys — live check that the Emotes keymap fires: J (retail
 * default for Wave, KeyMap 0x14000000) plays the emote locally and sends a
 * MoveToState carrying MotionCommand.Wave so other players see it.
 *
 *   AC_ACCOUNT=testacjs3 npx tsx tools/probe-emote-keys.ts   (verification/emote-keys/)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, sessionArgs, shot } from './lib/game-session.js';

const OUT = 'verification/emote-keys';

const INSTALL_JS = `(() => {
  const ac = window.__ac; window.__emotes = [];
  const mm = ac.animController.mm;
  const q = mm.queueAction.bind(mm);
  mm.queueAction = (m, ...r) => { window.__emotes.push({ kind: 'local', motion: m >>> 0, t: Math.round(performance.now()), stack: new Error().stack.split(String.fromCharCode(10)).slice(2,6).join(' / ') }); return q(m, ...r); };
  const ms = ac.movementSync;
  if (ms) { const f = ms.sendSoulEmoteMotion.bind(ms);
    ms.sendSoulEmoteMotion = (m, ...r) => { window.__emotes.push({ kind: 'sent', motion: m >>> 0 }); return f(m, ...r); }; }
  const som = ac.serverObjectManager; const ap = som.applyParsedMotion.bind(som);
  som.applyParsedMotion = (guid, an, parsed, live) => {
    if (guid === som.localPlayerGuid) window.__emotes.push({ kind: 'echo', t: Math.round(performance.now()),
      autonomous: parsed.autonomous, movementType: parsed.movementType, fwd: parsed.forwardCommand, cmds: JSON.stringify(parsed.commands ?? null) });
    return ap(guid, an, parsed, live);
  };
  return !!ms;
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ ...sessionArgs(), cb: 'probe-emote', settleMs: 6000, createCharacter: 'Emoteprobe' });
  const { page, browser } = s;
  const sent: string[] = [];
  page.on('console', (m) => { if (/MoveToState|emote/i.test(m.text())) sent.push(m.text()); });
  await page.evaluate(INSTALL_JS);
  await page.evaluate(`document.activeElement && document.activeElement.blur()`);
  await page.mouse.click(780, 300);
  await page.waitForTimeout(500);
  await shot(page, `${OUT}/before.png`);
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(700);
  await shot(page, `${OUT}/wave-700ms.png`);
  await page.waitForTimeout(800);
  await shot(page, `${OUT}/wave-1500ms.png`);
  const emotes = await page.evaluate(`window.__emotes`);
  const out = { emotes, sent };
  writeFileSync(`${OUT}/result.json`, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
