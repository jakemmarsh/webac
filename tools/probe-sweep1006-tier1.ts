/**
 * probe-sweep1006-tier1 — live checks for the decomp-sweep tier-1 fixes
 * (SWEEP1006.*), two clients (A fxprobe1 / B fxprobe2) in Holtburg:
 *  npc-say   A spawns wcid 21135 (its Use emote is a Say) and uses it: the line
 *            reads 'Antius Blackmoor says, "…"' (ACE sends it as chat type
 *            Emote) and the spew shows "Approaching Name" (UseObject).
 *  dove      A (peace mode) uses a fresh drudge: no Use goes out; the spew
 *            reads "To attack Drudge Skulker, click on the dove icon first".
 *  pickup    A drops a Longbow and uses it on the ground: it is picked up
 *            (DetermineUseResult case 2 → PlaceInBackpack), no Use sent.
 *  channel   B says on General: A shows '[General] +Fxprobetwo says, "…"'.
 *  jump      A starts an emote and jumps at once: the take-off drops the
 *            emote (no action still playing after leaveGround).
 *  chargen   B's account opens chargen and asks for a taken name: retail's
 *            NameReserved text in a dialog, nothing in chat.
 * Writes verification/sweep1006-tier1/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-sweep1006-tier1.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, enterCharSelect, gameUrl, shot, PROBE_CHARGEN_REOPEN_JS } from './lib/game-session.ts';
import { openTwoClients, say, waitChat, chatLines, MEET_LOC } from './lib/two-client.ts';

const OUT = 'verification/sweep1006-tier1';
/** `--only a,b` runs just those checks. */
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (k: string) => !ONLY || ONLY.has(k);
/** A weenie whose Use emote opens with a Say (EmoteCategory Use, EmoteType Say): "High Queen Elysa, brought me back…". */
const SAY_NPC = 21135;
const DRUDGE = 19257;
const LONGBOW = 306;

const spew = (p: Page) => p.evaluate('window.__ac.gameUI.spewBox.items.map((i) => i.text)') as Promise<string[]>;
const objOf = (p: Page, wcid: number) => p.evaluate(`(() => { let best = 0, bd = 1e9; const cs = window.acDebug.collisionState();
  for (const o of window.__ac.serverObjectManager.objects.values()) { if (o.weenieClassId !== ${wcid} || window.__ac.serverObjectManager.isDying(o.guid)) continue;
    const d = Math.hypot(o.worldX - cs.x, o.worldZ - cs.z); if (d < bd) { bd = d; best = o.guid; } } return best; })()`) as Promise<number>;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 400)}`); };
  const run = String(process.pid).slice(-5);
  const { a, b, close } = await openTwoClients('sweep1006');
  const sentUse: string[] = [];
  a.page.on('console', (m) => { const t = m.text(); if (/Sent Use \(0x0036\)|UseObject 0x|PutItemInContainer|placeInBackpack/i.test(t)) sentUse.push(t.slice(0, 200)); });
  try {
    // npc-say
    if (want('npc-say')) {
      await adminCommand(a.page, `@create ${SAY_NPC}`);
      await a.page.waitForTimeout(3500);
      const npc = await objOf(a.page, SAY_NPC);
      const npcName = await a.page.evaluate(`window.__ac.serverObjectManager.getObject(${npc})?.name ?? ''`) as string;
      sentUse.length = 0;
      await a.page.evaluate(`window.acDebug.useObject(${npc})`);
      await a.page.waitForTimeout(300);
      const approaching = (await spew(a.page)).find((t) => t === `Approaching ${npcName}`) ?? null;
      // Its Use emote picks one of six Say lines by probability.
      const sayLine = await waitChat(a.page, new RegExp(`^${npcName} says, "`), 30_000);
      const anyLines = (await chatLines(a.page)).filter((l) => l.includes(npcName)).slice(-3);
      record('npc-say', !!sayLine && sayLine.startsWith(`${npcName} says, "`) && !!approaching, { npc: npc.toString(16), npcName, sayLine, approaching, anyLines, sends: sentUse.slice() });
      await shot(a.page, `${OUT}/npc-say-a.png`);
    }

    if (want('dove')) {
    // dove
    await adminCommand(a.page, `@teleloc ${MEET_LOC}`);
    await a.page.waitForTimeout(6000);
    await adminCommand(a.page, `@create ${DRUDGE}`);
    await a.page.waitForTimeout(3500);
    const drudge = await objOf(a.page, DRUDGE);
    sentUse.length = 0;
    await a.page.waitForTimeout(400);
    await a.page.evaluate(`window.acDebug.useObject(${drudge})`);
    await a.page.waitForTimeout(1500);
    const dove = (await spew(a.page)).find((t) => /click on the dove icon first/.test(t)) ?? null;
    const usedDrudge = sentUse.some((t) => /Sent Use \(0x0036\)/.test(t));
    record('dove', !!dove && !usedDrudge, { dove, sends: sentUse.slice() });
    await adminCommand(a.page, '@smite all');
    await a.page.waitForTimeout(2000);
    }

    if (want('pickup')) {
    // pickup
    await adminCommand(a.page, `@ci ${LONGBOW}`);
    await a.page.waitForTimeout(2500);
    const bow = await a.page.evaluate(`(() => { const it = (window.__ac.gameUI.inventoryItems || []).find((i) => i.weenieClassId === ${LONGBOW}); return it ? it.id : 0; })()`) as number;
    await a.page.evaluate(`window.acDebug.dropInventoryItem(${bow})`);
    await a.page.waitForTimeout(3500);
    const onGround = await a.page.evaluate(`!window.__ac.playerState.inventory.getItem(${bow})`);
    sentUse.length = 0;
    await a.page.evaluate(`window.acDebug.useObject(${bow})`);
    await a.page.waitForTimeout(4000);
    const backInPack = await a.page.evaluate(`!!window.__ac.playerState.inventory.getItem(${bow})`);
    const usedBow = sentUse.some((t) => /Sent Use \(0x0036\)/.test(t));
    record('pickup', onGround === true && backInPack === true && !usedBow, { bow: bow.toString(16), onGround, backInPack, sends: sentUse.slice() });
    }

    if (want('channel')) {
    // channel
    const msg = `chan-${run}`;
    await say(b.page, `/g ${msg}`);
    const chan = await waitChat(a.page, new RegExp(msg), 15_000);
    record('channel', !!chan && /^\[General\] \S+ says, "chan-\d+"$/.test(chan), { line: chan });
    await shot(a.page, `${OUT}/channel-a.png`);
    }

    if (want('jump')) {
    // jump — an emote, then a jump at once (the canvas has the keyboard focus).
    await a.page.mouse.click(784, 120);
    await a.page.waitForTimeout(300);
    await a.page.evaluate(`window.__ac.animController && window.__ac.animController.playEmote && window.__ac.animController.playEmote(0x13000087)`); // Wave
    await a.page.waitForTimeout(120);
    const before = await a.page.evaluate('!!(window.__ac.animController && window.__ac.animController.mm && window.__ac.animController.mm.isPlayingAction)');
    await a.page.keyboard.down('Space'); await a.page.waitForTimeout(80); await a.page.keyboard.up('Space');
    let afterTakeoff: unknown = null;
    for (let i = 0; i < 60; i++) {
      await a.page.waitForTimeout(25);
      const s = await a.page.evaluate('(() => { const c = window.__ac.animController; return c ? { airborne: c._airborne, motion: c.mm ? (c.mm.motion >>> 0) : null } : null; })()') as { airborne: boolean; motion: number | null } | null;
      if (s?.airborne) { afterTakeoff = s; break; }
    }
    // The take-off's motion is Falling (0x40000015 → wire 0x15) at once; with the
    // emote's link still playing first, Falling would wait in the queue.
    const ta = afterTakeoff as { airborne: boolean; motion: number | null } | null;
    record('jump', before === true && !!ta && ta.motion !== null && (ta.motion & 0xffff) === 0x15, { emotePlayingBefore: before, afterTakeoff });
    }
  } finally {
    await close();
  }

  // chargen — a taken name on B's account.
  if (want('chargen')) {
  const cs = await enterCharSelect({ cb: 'sweep1006-chargen', url: gameUrl({ cb: 'sweep1006-chargen', autoenter: false, env: { ...process.env, AC_ACCOUNT: 'fxprobe2', AC_PASSWORD: 'fxprobe2' } }) } as never);
  try {
    const chatBefore = (await chatLines(cs.page)).length;
    await cs.page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.showCharacterCreate(); ${PROBE_CHARGEN_REOPEN_JS} })()`);
    await cs.page.waitForTimeout(3000);
    await cs.page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.wizard.name = 'Fxprobetwo'; ui.callbacks.onCharacterCreated(ui.wizard); })()`);
    await cs.page.waitForTimeout(5000);
    const dialog = await cs.page.evaluate(`(() => { const d = [...document.querySelectorAll('[data-ac-line]')].map((e) => e.getAttribute('data-ac-line')).join(' '); return d; })()`) as string;
    const chatAfter = (await chatLines(cs.page)).length;
    await shot(cs.page, `${OUT}/chargen.png`);
    record('chargen', /The name you have selected is already in use\./.test(dialog) && chatAfter === chatBefore, { dialog: dialog.slice(0, 200), chatBefore, chatAfter });
  } finally {
    await cs.browser.close();
  }
  }
  results.fails = fails;
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2) + '\n');
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
