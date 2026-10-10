/**
 * probe-busy-cursor — GAP.client-busy-cursor-count live check. Samples
 * acDebug.cursorState() (the resolved UICURSOR name + m_cBusy) every 10 ms
 * around a Use, an examine, a teleport and a melee swing, and records each
 * span the cursor spent as Wait / Wait_OverObject and what ended it.
 *
 * Usage: npx tsx tools/probe-busy-cursor.ts
 * Writes verification/busy-cursor/{state.json,console.log,*.png}. Soft-
 * deletes the probe character it creates.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, adminCommand, openSession, gameUrl, waitForCharSelect, sessionArgs, REPO } from './lib/game-session.js';

const OUT = `${REPO}/verification/busy-cursor`;
const NAME = 'Busyprobe';

type Sample = { t: number; name: string; busy: number; teleport: boolean };

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ ...sessionArgs(), cb: 'busy-cursor', createCharacter: NAME } as never);
  const { page } = s;
  const all: string[] = [];
  const t0 = Date.now();
  page.on('console', (m) => { all.push(`${Date.now() - t0} ${m.text()}`); });
  await page.waitForTimeout(5000);
  await page.mouse.click(700, 300);
  await page.mouse.move(780, 200);
  await adminCommand(page, '@god');
  await page.waitForTimeout(1500);
  await adminCommand(page, '@create 12699');
  await page.waitForTimeout(2500);

  const startSampling = () => page.evaluate(`(() => {
    window.__cs = []; const t0 = performance.now();
    window.__csTimer = setInterval(() => { const c = window.acDebug.cursorState(); window.__cs.push({ t: Math.round(performance.now() - t0), name: c.name, busy: c.busy, teleport: c.teleport }); }, 10);
  })()`);
  const stopSampling = async (): Promise<Sample[]> => page.evaluate(`(() => { clearInterval(window.__csTimer); return window.__cs; })()`) as Promise<Sample[]>;
  const spans = (xs: Sample[]) => {
    const out: { from: number; to: number | null; names: string[] }[] = [];
    let cur: { from: number; to: number | null; names: string[] } | null = null;
    for (const x of xs) {
      if (x.busy > 0 && !cur) cur = { from: x.t, to: null, names: [] };
      if (cur && x.busy > 0 && !cur.names.includes(x.name)) cur.names.push(x.name);
      if (cur && x.busy === 0) { cur.to = x.t; out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  };
  // Every m_cBusy / cursor / awaited-appraisal transition, on the same
  // console clock as the sends and the server's answers.
  await page.evaluate(`(() => { let last = '';
    setInterval(() => { const c = window.acDebug.cursorState();
      const k = c.busy + ' ' + c.name + ' teleport=' + c.teleport + ' awaiting=0x' + c.awaitingAppraisal.toString(16);
      if (k !== last) { last = k; console.log('[busy] ' + k); } }, 10); })()`);
  const result: Record<string, unknown> = {};
  result.idle = await page.evaluate('window.acDebug.cursorState()');

  const nearest = (re: string) => page.evaluate(`(() => {
    let best = null, bestD = 1e9; const me = window.acDebug.collisionState();
    for (const o of window.acDebug.getObjects()) {
      if (!new RegExp(${JSON.stringify(re)}).test(o.name || '')) continue;
      const d = o.pos ? Math.hypot(o.pos.x - me.x, o.pos.z - me.z) : 1e8;
      if (d < bestD) { bestD = d; best = { guid: o.guid, name: o.name, d }; }
    }
    return best; })()`) as Promise<{ guid: number; name: string; d: number } | null>;

  // 1. Examine (IdentifyObject → IdentifyObjectResponse).
  const npc = await nearest('Sparring Golem|Town Crier|Guard|Shopkeeper|Collector|Barkeeper|Grocer|Healer|Jeweler|Armorer|Archmage|Scribe');
  result.examineTarget = npc;
  if (npc) {
    await startSampling();
    await page.evaluate(`window.__ac.identifyObject(${npc.guid})`);
    await page.waitForTimeout(1500);
    result.examine = spans(await stopSampling());
  }

  // 2. Use (Use → UseDone). The object may need an approach first.
  const usable = await nearest('Door|Lifestone|Chest|Gate|Portal|Well');
  result.useTarget = usable;
  if (usable) {
    await startSampling();
    await page.evaluate(`window.__ac.useObject(${usable.guid})`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/use-pending.png` });
    await page.waitForTimeout(8000);
    result.use = spans(await stopSampling());
  }

  // 3. Melee swing on a spawned golem (CommenceAttack → AttackDone; ACE
  // sends CommenceAttack only for the repeat swings, Player_Melee.cs:286).
  await page.waitForTimeout(2500);
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(2500);
  const golem = await nearest('Sparring Golem');
  result.golem = golem;
  if (golem) {
    await page.evaluate(`window.acDebug.select(${golem.guid})`);
    await page.waitForTimeout(800);
    await page.evaluate('window.__ac.gameUI.combatPowerLevel = 0.5');
    await startSampling();
    await page.keyboard.down('End');
    await page.waitForTimeout(1200);
    await page.keyboard.up('End');
    await page.waitForTimeout(9000);
    result.attack = spans(await stopSampling());
    await page.keyboard.press('Backquote');
    await page.waitForTimeout(2000);
  }

  // 4. Teleport (portal space → the TAS_OFF step).
  await startSampling();
  await adminCommand(page, '@telepoi Rithwic');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/teleport-pending.png` });
  await page.waitForTimeout(20000);
  result.teleport = spans(await stopSampling());
  result.after = await page.evaluate('window.acDebug.cursorState()');
  await page.screenshot({ path: `${OUT}/after.png` });

  writeFileSync(`${OUT}/state.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${OUT}/console.log`, all.filter((l) => /\[busy\]|UseDone|AttackDone|CommenceAttack|Sent Use|IdentifyObject|Teleport|LoginComplete/i.test(l)).join('\n'));
  console.log(JSON.stringify(result, null, 2));
  await s.browser.close();

  const s2 = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  await s2.page.goto(gameUrl({ autoenter: false, cb: 'busy-cursor-cleanup' }), { waitUntil: 'domcontentloaded' });
  await waitForCharSelect(s2.page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
  await s2.page.waitForTimeout(2000);
  const del = await s2.page.evaluate(`(() => { const ui = window.__ac.gameUI; const names = ui.selectScreen.characters.map((s) => s.name);
    const c = ui.selectScreen.characters.find((s) => s.name.replace(/^\\+/, '').toLowerCase() === ${JSON.stringify(NAME.toLowerCase())});
    return { names, deleted: c ? ui.callbacks.onDeleteCharacter(c) : false }; })()`);
  await s2.page.waitForTimeout(3000);
  console.log('probe character deleted:', del);
  await s2.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
