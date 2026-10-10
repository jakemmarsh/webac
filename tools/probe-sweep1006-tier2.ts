/**
 * probe-sweep1006-tier2 — live checks for the decomp-sweep tier-2 fixes that
 * show on screen, two clients (A fxprobe1 / B fxprobe2) in Holtburg:
 *  emote-held   A types *afk*: A holds AFKState, and B sees A's motion hold
 *               the AFK state cycle seconds later (not snap back).
 *  apostrophe   A says "/e 's hat falls off.": B reads "<A>'s hat falls off."
 *  crouch-combat A in melee stance crouches: the Crouch cycle plays (it exists
 *               only in NonCombat — the default-style fallback), seen by B.
 *  trade-close  A opens trade with B (UseObject case 5); B closes it: A's
 *               panel stays open and empty (RecvNotice_CloseTrade → Reset).
 *  expiry       A casts Brilliance (2348, 30 s) on itself: "Brilliance has
 *               expired." (Magic) when it runs out.
 * Writes verification/sweep1006-tier2/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-sweep1006-tier2.ts [--only a,b]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, shot } from './lib/game-session.ts';
import { openTwoClients, say, waitChat } from './lib/two-client.ts';

const OUT = 'verification/sweep1006-tier2';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (k: string) => !ONLY || ONLY.has(k);
const AFK_STATE = 0x4300011b;
const CROUCH = 0x41000012;
const BRILLIANCE = 2348;

/** How `viewer` sees `guid`'s motion: the low 16 bits of its MotionManager's current motion, and whether an animation plays. */
const motionOf = (viewer: Page, guid: number) => viewer.evaluate(`(() => { const a = window.__ac.serverObjectManager.getAnimated(${guid}); if (!a) return null;
  const mm = a.motionManager; return { motion: mm.motion & 0xffff, anim: !!(mm.animationPlayer && mm.animationPlayer.currentAnimation) }; })()`) as Promise<{ motion: number; anim: boolean } | null>;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 400)}`); };
  const { a, b, close } = await openTwoClients('sweep1006-t2');
  try {
    // B stands 3 m north of A so screenshots from A show B and vice versa.
    await adminCommand(b.page, '@teleloc 0xA9B40019 [85.0 24.5 94.0] 1 0 0 0');
    await b.page.waitForTimeout(8000);

    if (want('emote-held')) {
      await say(a.page, '*afk*');
      await a.page.waitForTimeout(3000);
      const held = await a.page.evaluate('window.__ac.animController ? window.__ac.animController.heldSubstate >>> 0 : null');
      const seen1 = await motionOf(b.page, a.guid);
      await b.page.waitForTimeout(4000);
      const seen2 = await motionOf(b.page, a.guid);
      await shot(b.page, `${OUT}/emote-held-b.png`);
      record('emote-held', held === AFK_STATE && seen1?.motion === (AFK_STATE & 0xffff) && seen2?.motion === (AFK_STATE & 0xffff), { held, seen1, seen2 });
      await a.page.evaluate('window.__ac.animController && window.__ac.animController.setHeldSubstate(0x41000003)'); // Ready
      await a.page.waitForTimeout(2000);
    }

    if (want('apostrophe')) {
      await say(a.page, "/e 's hat falls off.");
      const line = await waitChat(b.page, /hat falls off\./, 10_000);
      record('apostrophe', line === `${a.name}'s hat falls off.`, { line });
    }

    if (want('crouch-combat')) {
      // The combat toggle key (retail default: the backquote), as a player enters combat.
      await a.page.mouse.click(784, 120);
      await a.page.waitForTimeout(300);
      await a.page.keyboard.press('Backquote');
      await a.page.waitForTimeout(5000);
      results.crouchCombatModeState = await a.page.evaluate('(() => { const mm = window.__ac.animController && window.__ac.animController.mm; return { style: mm ? mm.currentStyleId >>> 0 : null, hud: window.__ac.gameUI.hudState && window.__ac.gameUI.hudState.combatMode }; })()');
      await a.page.evaluate(`window.__ac.animController.setHeldSubstate(${CROUCH})`);
      await a.page.waitForTimeout(3000);
      const self = await a.page.evaluate('(() => { const mm = window.__ac.animController && window.__ac.animController.mm; return mm ? { motion: mm.motion & 0xffff, style: mm.currentStyleId >>> 0, anim: !!(mm.animationPlayer && mm.animationPlayer.currentAnimation) } : null; })()') as { motion: number; style: number; anim: boolean } | null;
      const seen = await motionOf(b.page, a.guid);
      await shot(b.page, `${OUT}/crouch-combat-b.png`);
      record('crouch-combat', !!self && self.motion === 0x12 && self.style !== 0x8000003d && self.anim && seen?.motion === 0x12 && !!seen.anim, { self, seen });
      await a.page.evaluate('window.__ac.animController.setHeldSubstate(0x41000003)');
      await a.page.keyboard.press('Backquote');
      await a.page.waitForTimeout(3000);
    }

    if (want('trade-close')) {
      await a.page.evaluate(`window.acDebug.useObject(${b.guid})`);
      let bOpen = false;
      for (let i = 0; i < 20 && !bOpen; i++) { await b.page.waitForTimeout(500); bOpen = await b.page.evaluate('!!window.__ac.gameUI.tradeVisible') as boolean; }
      const aOpen = await a.page.evaluate('!!window.__ac.gameUI.tradeVisible');
      await b.page.evaluate('window.__ac.gameUI.closeTradeWindowFromUi()');
      await a.page.waitForTimeout(3000);
      const after = await a.page.evaluate('({ visible: !!window.__ac.gameUI.tradeVisible, partner: window.__ac.gameUI.getTradeData().partnerGuid })') as { visible: boolean; partner: number };
      const cancelled = (await a.page.evaluate('window.__ac.gameUI.spewBox.items.map((i) => i.text)') as string[]).find((t) => t === 'The trade has been cancelled.') ?? null;
      await shot(a.page, `${OUT}/trade-close-a.png`);
      record('trade-close', bOpen && aOpen === true && after.visible && after.partner === 0 && !!cancelled, { bOpen, aOpen, after, cancelled });
    }

    if (want('expiry')) {
      await adminCommand(a.page, `@addspell ${BRILLIANCE}`);
      await a.page.waitForTimeout(1500);
      await a.page.evaluate(`window.__ac.castSpell(${BRILLIANCE}, window.__ac.charGuid)`);
      const line = await waitChat(a.page, /^Brilliance has expired\.$/, 70_000);
      record('expiry', !!line, { line });
    }
  } finally {
    results.fails = fails;
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2) + '\n');
    await close();
  }
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
