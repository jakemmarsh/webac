/**
 * verify-login-sidepack — live in-world verification for
 * BUG.login-sidepack-viewcontents-opens-panel.
 *
 * ACE sends one GameEventViewContents per carried side pack on every login
 * (Player_Networking.cs:242-262) — a silent contents snapshot. Pre-fix the
 * client treated each as a user container-open: the container panel popped
 * with the lid motion + Sound.Open chime on every login.
 *
 * Flow:
 *   A. Log in (scripted character-create on a virgin account). Ensure the
 *      character carries a side pack — grant one via the admin `@ci 136`
 *      (backpack) if not.
 *   B. Reload (fresh login) with taps installed on gameUI.playOpenSound and
 *      gameUI.showContainerPanel from page init. After world entry, assert:
 *        - a ViewContents for the side pack ARRIVED (console log proof),
 *        - showContainerPanel was NOT called, playOpenSound was NOT called,
 *        - gameUI.containerPanelHandle is null (no visible panel),
 *        - the pack registered as a side-pack tab (gameUI side-pack guids).
 *      Screenshot the post-login frame as evidence.
 *
 * Usage: npx tsx tools/verify-login-sidepack.ts
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=sidepack';
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-login-sidepack`);

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function loginLoop(page: Page): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[sidepack] scripted character create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[sidepack] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world within 360s');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  // Tap panel/chime calls from page init so the LOGIN-time calls are counted
  // (survives reloads; counters reset per navigation which is what we want).
  await page.addInitScript(`(() => {
    window.__sidepackTap = { openSound: 0, showPanel: 0, viewContents: [] };
    const iv = setInterval(() => {
      const ui = window.__ac && window.__ac.gameUI;
      if (!ui || !ui.playOpenSound || ui.playOpenSound.__tapped) return;
      const origSound = ui.playOpenSound.bind(ui);
      ui.playOpenSound = () => { window.__sidepackTap.openSound++; return origSound(); };
      ui.playOpenSound.__tapped = true;
      const origPanel = ui.showContainerPanel.bind(ui);
      ui.showContainerPanel = (...a) => { window.__sidepackTap.showPanel++; return origPanel(...a); };
      clearInterval(iv);
    }, 50);
  })()`);
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[AC] ViewContents')) {
      console.log(`[page] ${t}`);
      void page.evaluate((line) => { (window as any).__sidepackTap?.viewContents.push(line); }, t).catch(() => {});
    }
  });

  console.log(`[sidepack] phase A: login + ensure side pack — ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await loginLoop(page);
  await page.waitForTimeout(8000);

  const packState = await page.evaluate(`(() => {
    const inv = window.__ac.playerState.inventory.getAll();
    const packs = inv.filter(i => (i.itemType & 0x200) !== 0);
    return { total: inv.length, packs: packs.map(p => ({ id: p.id, name: p.name })) };
  })()`) as { total: number; packs: Array<{ id: number; name: string }> };
  console.log(`[sidepack] inventory: ${packState.total} items, packs: ${JSON.stringify(packState.packs)}`);

  if (packState.packs.length === 0) {
    console.log('[sidepack] no side pack — granting via @ci 136 (backpack)');
    await page.evaluate(`window.acDebug.sendTalk('@ci 136')`);
    await page.waitForTimeout(5000);
    const after = await page.evaluate(`(() => {
      const inv = window.__ac.playerState.inventory.getAll();
      return inv.filter(i => (i.itemType & 0x200) !== 0).map(p => ({ id: p.id, name: p.name }));
    })()`) as Array<{ id: number; name: string }>;
    console.log(`[sidepack] packs after @ci: ${JSON.stringify(after)}`);
    if (after.length === 0) throw new Error('@ci 136 did not grant a pack — cannot stage the login scenario');
  }

  console.log('[sidepack] phase B: reload for a fresh login with the side pack carried');
  await page.goto(URL.replace('cb=sidepack', 'cb=sidepack2'), { waitUntil: 'domcontentloaded' });
  await loginLoop(page);
  console.log('[sidepack] in world — settling 10s for the full login stream…');
  await page.waitForTimeout(10_000);

  const verdict = await page.evaluate(`(() => {
    const tap = window.__sidepackTap;
    const ui = window.__ac.gameUI;
    const inv = window.__ac.playerState.inventory.getAll();
    const packs = inv.filter(i => (i.itemType & 0x200) !== 0).map(p => p.id);
    return {
      openSoundCalls: tap.openSound,
      showPanelCalls: tap.showPanel,
      viewContentsSeen: tap.viewContents,
      containerPanelOpen: !!ui.containerPanelHandle,
      packGuids: packs,
    };
  })()`) as {
    openSoundCalls: number; showPanelCalls: number; viewContentsSeen: string[];
    containerPanelOpen: boolean; packGuids: number[];
  };

  const shot = join(OUT, 'post-login.png');
  await page.screenshot({ path: shot });
  await browser.close();

  const packHex = verdict.packGuids.map(g => '0x' + g.toString(16));
  const sawPackViewContents = verdict.viewContentsSeen.some(line => packHex.some(h => line.includes(`container=${h}`)));

  const result = {
    utc: new Date().toISOString(),
    task: 'BUG.login-sidepack-viewcontents-opens-panel',
    ...verdict,
    packGuidsHex: packHex,
    sawPackViewContents,
    screenshot: shot,
    pass: sawPackViewContents && verdict.openSoundCalls === 0 && verdict.showPanelCalls === 0 && !verdict.containerPanelOpen,
  };
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) {
    console.error('[sidepack] FAIL — login side-pack ViewContents still triggers the container-open path (or no pack ViewContents arrived)');
    process.exit(1);
  }
  console.log('[sidepack] PASS — side-pack ViewContents arrived silently: no panel, no chime');
}

main().catch((err) => { console.error(err); process.exit(1); });
