/**
 * probe-sweepb-input — live checks for the SWEEP1006B player-input fixes,
 * two clients (A fxprobe1 / B fxprobe2) beside the Holtburg lifestone,
 * against ACE. Only A is driven; B stands in as a non-attackable player.
 *  modeselect  SetCombatMode @ 0056be30: with B (a non-PK player) selected
 *              and a drudge (wcid 7) spawned, the real ToggleCombatMode key
 *              (Backquote) enters melee and the selection becomes an
 *              attackable target (Auto Target), never B; back in peace, with
 *              the drudge selected, re-entering keeps it.
 *  pending     a combat toggle pressed while an emote (*wave*) plays logs
 *              "pending" and applies on its own once the motion ends
 *              (pendingCombatMode → UseTime).
 *  incompatible a combat toggle parked behind an emote (pending Melee),
 *              then a Longbow wielded: the pending change is refused with
 *              "You can't enter melee mode while wielding the Longbow" and
 *              nothing is sent (CompatibleCombatMode @ 0056a580)
 *  defender    in melee, the selection dropped with Escape (no Auto Target
 *              then), the drudge's next attack or evade selects it
 *              (HandleDefender / EvasionDefenderNotificationEvent).
 *  selfpick    third person: a left press on our own body selects the player,
 *              hovering it shows the over-object cursor, a right release on
 *              it sends IdentifyObject for our own guid.
 *  rightdrag   a right press 40 px off B and a release on it still
 *              examines B (no 5 px drag threshold, MouseUp @ 004e5820).
 *  hoverframe  with the mouse still over the 3D view the mouse-over find runs
 *              once per rendered frame (counted getObjectAtScreenPos calls vs
 *              requestAnimationFrame frames over 3 s), not at 10 Hz.
 * Writes verification/sweepb-input/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-sweepb-input.ts [--only a,b]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, shot, deleteSpawnsNear } from './lib/game-session.ts';
import { openTwoClients, say } from './lib/two-client.ts';

const OUT = 'verification/sweepb-input';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (k: string) => !ONLY || ONLY.has(k);
const DRUDGE_WCID = 7;
const MELEE = 2;
const PEACE = 1;

const ev = <T>(p: Page, js: string): Promise<T> => p.evaluate(js) as Promise<T>;
const findDynamic = (p: Page, wcid: number) => ev<number>(p, `(() => { let g = 0; for (const [k, o] of window.__ac.serverObjectManager.getAllObjects()) if (o.weenieClassId === ${wcid} && (k >>> 0) >= 0x80000000 && !window.__ac.serverObjectManager.isDying(k)) g = k; return g; })()`);
const selected = (p: Page) => ev<number>(p, '(() => { const t = window.__ac.gameUI.hudState.target; return t ? t.id >>> 0 : 0; })()');
const mode = (p: Page) => ev<number>(p, 'window.__ac.combatController.mode');
/** Client-space point of an object's (or the player's) mesh centre; null when off screen. */
const screenOf = (p: Page, which: number | 'self', lift = which === 'self' ? 1.0 : 0.6) => ev<{ x: number; y: number } | null>(p, `(() => {
  const ac = window.__ac; const m = ${which === 'self' ? 'ac.playerModel' : `ac.serverObjectManager.getObject(${which})?.mesh`};
  if (!m) return null; const THREE_V = m.position.constructor;
  m.updateMatrixWorld(true); const v = new THREE_V(); m.getWorldPosition(v);
  // Aim at the chest, not the feet.
  v.y += ${lift};
  v.project(ac.sceneManager.camera);
  if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
  const r = ac.sceneManager.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; })()`);
async function waitUntil(p: Page, fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  for (let t = 0; t < ms; t += 250) { if (await fn()) return true; await p.waitForTimeout(250); }
  return fn();
}
async function setMode(p: Page, want: number): Promise<void> {
  if ((await mode(p)) !== want) { await p.keyboard.press('Backquote'); }
  await waitUntil(p, async () => (await mode(p)) === want, 8000);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 600)}`); };
  const { a, b, close } = await openTwoClients('sweepb-input');
  const A = a.page;
  const logA: string[] = [];
  A.on('console', (m) => { const t = m.text(); if (/ChangeCombatMode|IdentifyObject|Sent Use/.test(t)) logA.push(t.slice(0, 200)); });
  const selfGuid = a.guid >>> 0;
  try {
    // Focus the 3D view so keys reach the game, third person, peace mode.
    await A.locator('canvas').first().click({ position: { x: 5, y: 5 }, force: true }).catch(() => {});
    // The probe characters hold a Practice Wand (the toggle would enter
    // magic): unwield it so ToggleCombatMode enters melee. A faces north
    // and B stands ahead-right of it (the two-client meet puts them on one
    // point), so the self pick hits A's own body and B is on screen.
    await ev(A, "window.acDebug.unwield('Held')");
    await adminCommand(A, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
    await adminCommand(b.page, '@teleloc 0xA9B40019 [88.0 25.0 94.0] 1 0 0 0');
    await A.waitForTimeout(5000);
    await setMode(A, PEACE);
    await adminCommand(A, `@create ${DRUDGE_WCID}`);
    await A.waitForTimeout(3500);
    let drudge = await findDynamic(A, DRUDGE_WCID);

    if (want('modeselect')) {
      await ev(A, `window.acDebug.select(${b.guid})`);
      const before = await selected(A);
      await setMode(A, MELEE);
      await A.waitForTimeout(800);
      const afterEnter = await selected(A);
      const attackable = await ev<boolean>(A, `(() => { const o = window.__ac.serverObjectManager.getObject(${afterEnter}); return !!o && (o.itemType & 0x10) !== 0 && (${afterEnter} >>> 0) >= 0x80000000; })()`);
      await setMode(A, PEACE);
      drudge = await findDynamic(A, DRUDGE_WCID) || drudge;
      await ev(A, `window.acDebug.select(${drudge})`);
      await setMode(A, MELEE);
      await A.waitForTimeout(800);
      const kept = await selected(A);
      await shot(A, `${OUT}/modeselect.png`);
      record('modeselect', before === (b.guid >>> 0) && afterEnter !== (b.guid >>> 0) && afterEnter !== 0 && attackable && kept === (drudge >>> 0),
        { before: before.toString(16), afterEnter: afterEnter.toString(16), attackable, drudge: drudge.toString(16), kept: kept.toString(16) });
      await setMode(A, PEACE);
    }

    if (want('pending')) {
      logA.length = 0;
      await say(A, '*wave*');
      await A.waitForTimeout(250);
      const motionsPending = await ev<boolean>(A, '!!window.__ac.animController?.motionsPending');
      await A.keyboard.press('Backquote');
      await A.waitForTimeout(100);
      const modeRightAway = await mode(A);
      const applied = await waitUntil(A, async () => (await mode(A)) === MELEE, 8000);
      const lines = logA.slice();
      record('pending', applied && (!motionsPending || (modeRightAway === PEACE && lines.some((l) => /pending/.test(l)))),
        { motionsPending, modeRightAway, applied, lines });
      await setMode(A, PEACE);
    }

    if (want('incompatible')) {
      // A Melee parked behind an emote, then a Longbow wielded: when the
      // pending mode applies (UseTime → SetCombatMode(pending, true)) the
      // CompatibleCombatMode check refuses it with the weapon's name.
      await setMode(A, PEACE);
      logA.length = 0;
      const spewBefore = await ev<number>(A, 'window.__ac.gameUI.spewBox.items.length');
      await say(A, '*wave*');
      await A.waitForTimeout(250);
      await A.keyboard.press('Backquote');
      await A.waitForTimeout(100);
      const parked = logA.some((l) => /ChangeCombatMode Melee pending/.test(l));
      const wielded = await ev<boolean>(A, "window.acDebug.wieldByName('Longbow')");
      await A.waitForTimeout(6000);
      const spewText = await ev<string[]>(A, 'window.__ac.gameUI.spewBox.items.map((i) => i.text)');
      const line = spewText.slice(Math.max(0, spewBefore - 2)).find((t) => /while wielding the/.test(t)) ?? null;
      const modeAfter = await mode(A);
      const sentMelee = logA.some((l) => /Sent ChangeCombatMode: Melee/.test(l));
      record('incompatible', parked && wielded && modeAfter === PEACE && !sentMelee && line === "You can't enter melee mode while wielding the Longbow",
        { parked, wielded, modeAfter, sentMelee, line, lines: logA.slice() });
      await ev(A, "window.acDebug.unwield('MissileWeapon')");
      await A.waitForTimeout(2000);
    }

    if (want('defender')) {
      drudge = await findDynamic(A, DRUDGE_WCID) || drudge;
      if (!drudge) { await adminCommand(A, `@create ${DRUDGE_WCID}`); await A.waitForTimeout(3500); drudge = await findDynamic(A, DRUDGE_WCID); }
      await setMode(A, MELEE);
      await A.waitForTimeout(500);
      await A.keyboard.press('Escape'); // willingly lost: no Auto Target from the selection change
      await A.waitForTimeout(50);
      const cleared = (await selected(A)) === 0;
      const isDrudge = (g: number) => ev<boolean>(A, `window.__ac.serverObjectManager.getObject(${g})?.weenieClassId === ${DRUDGE_WCID}`);
      // Wait for the drudge to swing at us (Defender / EvasionDefender notification).
      const got = await waitUntil(A, async () => (await selected(A)) !== 0, 30_000);
      const sel = await selected(A);
      await shot(A, `${OUT}/defender.png`);
      // The attacker is a drudge (one left from an earlier run may be the one swinging).
      record('defender', cleared && got && await isDrudge(sel), { cleared, got, sel: sel.toString(16), drudge: drudge.toString(16) });
      await setMode(A, PEACE);
    }

    if (want('selfpick')) {
      await A.keyboard.press('Escape');
      await A.waitForTimeout(400);
      const pt = await screenOf(A, 'self');
      const visible = await ev<boolean>(A, '!!window.__ac.playerModel?.visible');
      let selAfter = 0; let cursor = ''; let identified = false;
      if (pt && visible) {
        await A.mouse.move(pt.x, pt.y);
        await A.waitForTimeout(600);
        cursor = await ev<string>(A, 'window.acDebug?.cursorState ? JSON.stringify(window.acDebug.cursorState()) : ""');
        await A.mouse.down({ button: 'left' }); await A.mouse.up({ button: 'left' });
        await A.waitForTimeout(500);
        selAfter = await selected(A);
        logA.length = 0;
        await A.mouse.down({ button: 'right' }); await A.mouse.up({ button: 'right' });
        await A.waitForTimeout(800);
        identified = logA.some((l) => l.includes(`IdentifyObject (0x00C8) for entity 0x${selfGuid.toString(16)}`));
      }
      await shot(A, `${OUT}/selfpick.png`);
      record('selfpick', !!pt && visible && selAfter === selfGuid && identified && /OverObject/i.test(cursor),
        { pt, visible, selAfter: selAfter.toString(16), self: selfGuid.toString(16), cursor, identified });
    }

    if (want('rightdrag')) {
      // B stands still ahead of A (the drudge fights on top of A, where the
      // self pick rightly finds A's own body first).
      const pt = await screenOf(A, b.guid, 1.1); // a player's chest (0.6 m is the gap between its legs)
      let identified = false; let stationary = false; let under = '';
      if (pt) {
        under = await ev<string>(A, `(() => { const e = document.elementFromPoint(${pt.x}, ${pt.y}); const f = document.elementFromPoint(${pt.x + 40}, ${pt.y}); return (e ? e.tagName + '#' + e.id : '-') + ' / ' + (f ? f.tagName + '#' + f.id : '-'); })()`);
        // Control: a stationary right click on B examines it.
        logA.length = 0;
        await A.mouse.move(pt.x, pt.y);
        await A.mouse.down({ button: 'right' }); await A.mouse.up({ button: 'right' });
        await A.waitForTimeout(800);
        stationary = logA.some((l) => l.includes(`IdentifyObject (0x00C8) for entity 0x${(b.guid >>> 0).toString(16)}`));
        await A.keyboard.press('Escape');
        await A.waitForTimeout(400);
        logA.length = 0;
        await A.mouse.move(pt.x + 40, pt.y);
        await A.mouse.down({ button: 'right' });
        await A.mouse.move(pt.x, pt.y, { steps: 5 });
        await A.mouse.up({ button: 'right' });
        await A.waitForTimeout(800);
        identified = logA.some((l) => l.includes(`IdentifyObject (0x00C8) for entity 0x${(b.guid >>> 0).toString(16)}`));
      }
      record('rightdrag', !!pt && identified, { pt, under, stationary, target: (b.guid >>> 0).toString(16), lines: logA.slice() });
    }

    if (want('hoverframe')) {
      const r = await ev<{ x: number; y: number }>(A, '(() => { const r = window.__ac.sceneManager.renderer.domElement.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 3 }; })()');
      await A.mouse.move(r.x, r.y);
      await A.waitForTimeout(300);
      const counts = await ev<{ finds: number; frames: number }>(A, `new Promise((done) => {
        const som = window.__ac.serverObjectManager; const orig = som.getObjectAtScreenPos.bind(som);
        let finds = 0, frames = 0, live = true;
        som.getObjectAtScreenPos = (rc) => { finds++; return orig(rc); };
        const tick = () => { if (!live) return; frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
        setTimeout(() => { live = false; som.getObjectAtScreenPos = orig; done({ finds, frames }); }, 3000); })`);
      // One find per frame (allow the first / last frame to straddle the window).
      record('hoverframe', counts.frames > 0 && counts.finds >= counts.frames - 2,
        { ...counts, tenHzCap: 30 });
    }
  } finally {
    // Probe hygiene: remove what this probe spawned (it would show up in other sessions' captures).
    await deleteSpawnsNear(A, [DRUDGE_WCID]).catch(() => 0);
    await ev(A, "window.acDebug.wieldByName('Practice Wand')").catch(() => {});
    await A.waitForTimeout(1500);
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    await close();
  }
  if (fails.length) { console.log(`FAILED: ${fails.join(', ')}`); process.exit(1); }
  console.log('ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
