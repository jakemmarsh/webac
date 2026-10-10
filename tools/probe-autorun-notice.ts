/**
 * probe-autorun-notice — DECOMP.autorun-cancel-notice live check.
 * Q (canonical 'NumLock') toggles the run lock: CommandInterpreter::SetAutoRun
 * @ 006b4850 raises "AutoRun ON" / "AutoRun OFF" via
 * ECM_UI::SendNotice_DisplayStringInfo(0x1a) into the spew strip; Forward (W)
 * cancels it (CInputManager::ActivateActionKey @ 00432650 → TurnOffRunLock),
 * which raises "AutoRun OFF".
 *
 * Records every spew line (wraps gameUI.spewNotice), the strip's row count, the controller's
 * autoRun flag and the player's position at each step, and screenshots the
 * whole frame plus the spew strip after Q and after W. A character the probe
 * had to create is soft-deleted afterwards.
 *
 *   npx tsx tools/probe-autorun-notice.ts   (verification/autorun-notice/)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, openSession, sessionArgs, gameUrl, waitForCharSelect, collisionState, elementBox, shot, telepoi } from './lib/game-session.js';

const OUT = 'verification/autorun-notice';
// A soft-deleted character keeps its name reserved: a fresh letters-only name per run.
const NAME = 'Autorun' + Array.from({ length: 4 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');

const INSTALL_JS = `(() => {
  const ui = window.__ac.gameUI; window.__spew = [];
  const orig = ui.spewNotice.bind(ui);
  ui.spewNotice = (text) => { window.__spew.push(text); return orig(text); };
  return true;
})()`;
const STATE_JS = `({ autoRun: window.__ac.cameraController.autoRun, spew: window.__spew.slice(),
  stripRows: document.querySelectorAll('#hud-spew-box .spew-item').length })`;

interface Step { step: string; autoRun: boolean; spew: string[]; stripRows: number; x: number; z: number }

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ ...sessionArgs(), cb: 'probe-autorun', settleMs: 6000, createCharacter: NAME });
  const { page } = s;
  const created = await page.evaluate(`(window.__ac.playerState && window.__ac.playerState.name) || ''`).catch(() => '') as string;
  const madeHere = created.replace(/^\+/, '') === NAME;
  // Open ground to run on (the account's character may log in facing a wall).
  await telepoi(page, 'Holtburg', 20_000);
  await page.evaluate(INSTALL_JS);
  await page.mouse.click(780, 300); // focus the 3D view (not the chat input)
  await page.waitForTimeout(500);
  const steps: Step[] = [];
  const record = async (step: string): Promise<void> => {
    const st = await page.evaluate(STATE_JS) as Omit<Step, 'step' | 'x' | 'z'>;
    const c = await collisionState(page);
    steps.push({ step, ...st, x: +c.x.toFixed(2), z: +c.z.toFixed(2) });
  };
  const strip = async (file: string): Promise<void> => {
    await shot(page, `${OUT}/${file}-frame.png`);
    const b = await elementBox(page, '#hud-spew-box', 4);
    if (!b) return;
    await shot(page, `${OUT}/${file}-strip.png`, b);
    // Retail hides row 0 behind the vitals plate too (BUG.spew-newest-line-
    // under-vitals); lift the plate for one capture to show the drawn row.
    await page.evaluate(`document.getElementById('hud-vitals').style.visibility = 'hidden'`);
    await shot(page, `${OUT}/${file}-strip-novitals.png`, b);
    await page.evaluate(`document.getElementById('hud-vitals').style.visibility = ''`);
  };

  await record('start');
  await page.keyboard.press('KeyQ');
  await page.waitForTimeout(300);
  await record('after Q');
  await strip('after-q');
  await page.waitForTimeout(1500);
  await record('running');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(150);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
  await record('after W tap');
  await strip('after-w');
  await page.waitForTimeout(2000);
  await record('after W settle');
  // A second Q → ON, a second Q → OFF (the plain toggle path).
  await page.keyboard.press('KeyQ');
  await page.waitForTimeout(800);
  await page.keyboard.press('KeyQ');
  await page.waitForTimeout(600);
  await record('after Q, Q');

  const moved = (a: Step, b: Step): number => +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2);
  const summary = {
    character: created || NAME,
    steps,
    runDistanceAfterQ: moved(steps[0], steps[2]),
    driftAfterWCancel: moved(steps[3], steps[4]),
    pass: steps[1].autoRun && steps[1].stripRows >= 1 && steps[2].autoRun && !steps[3].autoRun && steps[3].stripRows >= 1
      && !steps[4].autoRun && !steps[5].autoRun
      && JSON.stringify(steps[5].spew) === JSON.stringify(['AutoRun ON', 'AutoRun OFF', 'AutoRun ON', 'AutoRun OFF']),
  };
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  await s.browser.close();

  // Soft-delete the probe character so auto-enter keeps landing elsewhere.
  if (!madeHere) { if (!summary.pass) process.exit(1); return; }
  const s2 = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  await s2.page.goto(gameUrl({ autoenter: false, cb: 'autorun-cleanup' }), { waitUntil: 'domcontentloaded' });
  await waitForCharSelect(s2.page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
  await s2.page.waitForTimeout(2000);
  const del = await s2.page.evaluate(`(() => { const ui = window.__ac.gameUI; const c = ui.selectScreen.characters.find((s) => s.name === ${JSON.stringify('+' + NAME)} || s.name === ${JSON.stringify(NAME)});
    return c ? ui.callbacks.onDeleteCharacter(c) : false; })()`);
  await s2.page.waitForTimeout(3000);
  console.log('probe character deleted:', del);
  await s2.browser.close();
  if (!summary.pass) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
