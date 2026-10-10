/**
 * probe-portalstorm — live verification for BUG.portalstorm-extent-ignored.
 *
 * Drives ACE's real @portalstorm developer command (DeveloperCommands.cs
 * HandlePortalStorm: 0=Brewing, 1=Imminent, 2=Storm+teleport, 3=Subsided)
 * against the running stack and asserts:
 *   - each event's chat line lands with the retail wording from the
 *     decompiled client (portalStormEvents.ts);
 *   - Brewing/Imminent dispatch PS_PortalStorm (0x73) through the PlayScript
 *     pipeline on the local player (console `[AC] PlayScript ... 0x73`);
 *   - the parsed wire extent reaches the consumer (console
 *     `[AC] Portal storm brewing: extent=0.4`).
 *
 * Screenshots under verification/portalstorm/.
 *
 * Usage: npx tsx tools/probe-portalstorm.ts
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack,
 * admin-enabled testacjs account.
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT_DIR = join(__dir, '..', 'verification', 'portalstorm');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=portalstorm';
const VIEW = { width: 1280, height: 800 };

const RETAIL = {
  brewing: 'This area is getting too crowded - a Portal Storm is brewing.',
  imminent: 'A Portal Storm is imminent - leave this crowded area!',
  storm: 'The Portal Storm has teleported you away from the crowded area!',
  subsided: 'The Portal Storm has subsided',
};

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
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

// The chat scroll is canvas-rendered (AC font renderer), so DOM text is
// invisible to textContent. Instead wrap the REAL gameUI.addSystemMessage
// once in-world and capture every string the live handlers pass it.
async function armChatCapture(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || ui.__probeWrapped) return;
    window.__probeChat = [];
    const orig = ui.addSystemMessage.bind(ui);
    ui.addSystemMessage = (text, color) => { window.__probeChat.push(text); return orig(text, color); };
    ui.__probeWrapped = true;
  })()`);
}

async function chatText(page: Page): Promise<string> {
  return page.evaluate(`(window.__probeChat || []).join('\\n')`) as Promise<string>;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  const lines: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('Portal storm') || t.includes('PlayScript')) {
      lines.push(t);
      console.log(`[probe][console] ${t}`);
    }
  });

  console.log(`[probe] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Phantom-session retry loop (see measure-perf.ts).
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[probe] character-create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[probe] not in world yet — reloading');
      try { await page.goto(URL, { waitUntil: 'domcontentloaded' }); } catch { /* retry next window */ }
      lastReload = Date.now();
      createSent = false;
    }
    await page.waitForTimeout(2000);
  }
  if (!(await inWorld(page))) {
    console.error('[probe] FAIL: never entered world');
    await browser.close();
    process.exit(1);
  }
  console.log('[probe] in world — settling 8s');
  await page.waitForTimeout(8000);
  await armChatCapture(page);

  const results: Record<string, boolean> = {};

  // Beat 1: Brewing (extent 0.4, PS_PortalStorm mod-0 variant on the player).
  await page.evaluate(`window.acDebug.sendChat('@portalstorm 0')`);
  await page.waitForTimeout(3000);
  let chat = await chatText(page);
  results['brewing chat'] = chat.includes(RETAIL.brewing);
  results['brewing extent=0.4 reached consumer'] = lines.some(l => l.includes('Portal storm brewing: extent=0.4'));
  results['brewing PS_PortalStorm dispatched'] = lines.some(l => l.includes('scriptId=0x73'));
  await page.screenshot({ path: join(OUT_DIR, '01-brewing.png') });

  // Beat 2: Imminent (extent 0.6, mod-1 variant).
  const scriptsBefore = lines.filter(l => l.includes('scriptId=0x73')).length;
  await page.evaluate(`window.acDebug.sendChat('@portalstorm 1')`);
  await page.waitForTimeout(3000);
  chat = await chatText(page);
  results['imminent chat'] = chat.includes(RETAIL.imminent);
  results['imminent extent=0.6 reached consumer'] = lines.some(l => l.includes('Portal storm imminent: extent=0.6'));
  results['imminent PS_PortalStorm dispatched'] = lines.filter(l => l.includes('scriptId=0x73')).length > scriptsBefore;
  await page.screenshot({ path: join(OUT_DIR, '02-imminent.png') });

  // Beat 3: Subsided.
  await page.evaluate(`window.acDebug.sendChat('@portalstorm 3')`);
  await page.waitForTimeout(3000);
  chat = await chatText(page);
  results['subsided chat'] = chat.includes(RETAIL.subsided)
    && !chat.includes(RETAIL.subsided + '.'); // retail prints no trailing period
  await page.screenshot({ path: join(OUT_DIR, '03-subsided.png') });

  // Beat 4 (last — it teleports us to 0,0): the storm strike.
  await page.evaluate(`window.acDebug.sendChat('@portalstorm 2')`);
  await page.waitForTimeout(6000);
  chat = await chatText(page);
  results['storm chat'] = chat.includes(RETAIL.storm);
  results['old invented storm line gone'] = !chat.includes('You are in the path of a Portal Storm');
  results['old truncated imminent line gone'] = !chat.includes('A Portal Storm is imminent!');
  await page.screenshot({ path: join(OUT_DIR, '04-storm-teleported.png') });

  console.log('[probe] === RESULT ===');
  let ok = true;
  for (const [k, v] of Object.entries(results)) {
    console.log(`[probe] ${v ? 'PASS' : 'FAIL'}: ${k}`);
    if (!v) ok = false;
  }
  await browser.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
