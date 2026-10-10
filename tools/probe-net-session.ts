/**
 * probe-net-session — live checks for the 2026-09-26 network fixes
 * (NET.* tasks): login + world entry, a long (multi-fragment) outbound chat
 * round-trips, a sustained session keeps processing inbound messages, and a
 * tab close lets an immediate re-login through (the bridge's Disconnect now
 * carries the real ACE session id).
 * Usage: npx tsx tools/probe-net-session.ts  (vite :3000 + bridge :9090 + ACE)
 */
import type { Browser, Page } from 'playwright';
import { gameUrl, launchBrowser, sessionArgs, waitForWorld } from './lib/game-session.js';
const URL = gameUrl({ cb: 'netprobe' });

/** A fresh tab in the SAME browser (the re-login leg needs the first tab's close to be the only disconnect). */
async function enter(browser: Browser): Promise<{ page: Page; ms: number; logs: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  if (await waitForWorld(page, { timeoutMs: 180_000, pollMs: 1000, reloadEveryMs: 0 })) return { page, ms: Date.now() - t0, logs };
  throw new Error('never entered world');
}

async function main(): Promise<void> {
  const browser = await launchBrowser(sessionArgs());
  const { page, ms, logs } = await enter(browser);
  console.log(`entered world in ${(ms / 1000).toFixed(1)}s`);
  await page.waitForTimeout(5000);
  // Long outbound Talk: > 1024 bytes on the wire → several fragments.
  // The chat renders through the DAT bitmap font (no DOM text): record what
  // reaches GameUI.addChatMessage instead.
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; window.__chatSeen = [];
    const orig = ui.addChatMessage.bind(ui);
    ui.addChatMessage = (s, t, c, ty) => { window.__chatSeen.push(String(s) + ': ' + String(t)); return orig(s, t, c, ty); };
    const origSys = ui.addSystemMessage.bind(ui);
    ui.addSystemMessage = (...a) => { window.__chatSeen.push(String(a[0])); return origSys(...a); }; })()`);
  const shortMarker = `netprobe-short-${Date.now()}`;
  await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(shortMarker)})`);
  await page.waitForTimeout(3000);
  const shortSeen = await page.evaluate(`window.__chatSeen.some((l) => l.includes(${JSON.stringify(shortMarker)}))`);
  console.log(`short talk echoed back: ${shortSeen}`);
  const marker = `netprobe-${Date.now()}`;
  const long = `${marker} ` + 'x'.repeat(1400);
  await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(long)})`);
  await page.waitForTimeout(4000);
  const longSeen = await page.evaluate(`window.__chatSeen.find((l) => l.includes(${JSON.stringify(marker)})) || ''`) as string;
  console.log(`long talk (${long.length} chars) echoed back: ${longSeen.length > 0} (echo length ${longSeen.length})`);
  // Sustained session: run in a circle for 90s; inbound must keep flowing.
  await page.evaluate(`window.__ac.cameraController.simulateKeyDown('KeyW'); window.__ac.cameraController.simulateKeyDown('KeyA')`);
  const start = Date.now();
  let lastCount = -1; let stalls = 0;
  while (Date.now() - start < 60_000) {
    await page.waitForTimeout(10_000);
    const n = await page.evaluate(`window.__ac.serverObjectManager ? window.__ac.serverObjectManager['objects'].size : -1`) as number;
    const link = await page.evaluate(`(document.body.innerText.match(/Disconnected|lost connection/i) || [''])[0]`) as string;
    console.log(`t=${((Date.now() - start) / 1000).toFixed(0)}s objects=${n} ${link ? 'LINK:' + link : ''}`);
    if (n === lastCount) stalls++; lastCount = n;
  }
  await page.evaluate(`window.__ac.cameraController.simulateKeyUp('KeyW'); window.__ac.cameraController.simulateKeyUp('KeyA')`);
  const endMarker = `netprobe-end-${Date.now()}`;
  await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(endMarker)})`);
  await page.waitForTimeout(3000);
  console.log(`talk after the sustained run echoed back: ${await page.evaluate(`window.__chatSeen.some((l) => l.includes(${JSON.stringify(endMarker)}))`)}`);
  const disconnects = logs.filter((l) => /disconnect|ServerDied|serverTimeout/i.test(l));
  console.log(`disconnect-ish console lines: ${disconnects.length}${disconnects.length ? ' — ' + disconnects.slice(0, 3).join(' | ') : ''}`);
  // Tab close → immediate re-login.
  await page.close();
  const again = await enter(browser);
  const rejected = again.logs.filter((l) => /already|in use|two accounts|LoginReject|Account.*logged/i.test(l));
  console.log(`re-login after tab close: ${(again.ms / 1000).toFixed(1)}s, reject lines=${rejected.length}${rejected.length ? ' — ' + rejected.slice(0, 2).join(' | ') : ''}`);
  await browser.close();
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
