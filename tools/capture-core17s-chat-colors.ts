/**
 * CORE.17.s — live capture + side-by-side evidence for the default chat text
 * colours (ChatInterface::BuildChatColorLookupTable @ 004f31c0).
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright:
 * logs in like tools/capture-ui-screens.ts (scripted character creation on a
 * virgin account, as measure-perf.ts does), parks at Holtburg with the scene
 * harness' pins (weather off, time-of-day 0.5, yaw 0) and shoots
 *   <label>-hud-idle-over-world.png   the whole frame right after login — the
 *                                     server welcome (ChatMessageType.Broadcast)
 *                                     is the line set retail's Wine frame shows
 *   <label>-swatch-N.png              the main chat log crop after pushing one
 *                                     line per text type through the shipped
 *                                     addSystemMessage(text, chatColorFor(type),
 *                                     type) path, four types per crop
 * Then `--compose` builds, from verification/core17s/:
 *   core17s-chat-sidebyside.png       retail Wine chat crop | ours BEFORE | AFTER
 *   core17s-fullscreen-sidebyside.png retail Wine frame | ours before | ours after
 *   core17s-swatch-sidebyside.png     every text type, before | after, with the
 *                                     retail name + hex from the .data table
 *
 * Usage: npx tsx tools/capture-core17s-chat-colors.ts --label before|after
 *        npx tsx tools/capture-core17s-chat-colors.ts --compose
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatMessageType, chatColorFor } from '../packages/shared/src/enums/ChatMessageType.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17s');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };

const labelIdx = process.argv.indexOf('--label');
const LABEL = labelIdx >= 0 ? process.argv[labelIdx + 1] : '';

/** Text types in retail table order, with the retail name for the legend. */
const TYPES: Array<[number, string]> = [
  [ChatMessageType.Broadcast, 'Broadcast 0x00'],
  [ChatMessageType.AllChannels, 'AllChannels 0x01'],
  [ChatMessageType.Speech, 'Speech 0x02'],
  [ChatMessageType.Tell, 'Tell 0x03'],
  [ChatMessageType.OutgoingTell, 'OutgoingTell 0x04'],
  [ChatMessageType.System, 'System 0x05'],
  [ChatMessageType.Combat, 'Combat 0x06'],
  [ChatMessageType.Magic, 'Magic 0x07'],
  [ChatMessageType.Channel, 'Channel 0x08'],
  [ChatMessageType.ChannelSend, 'ChannelSend 0x09'],
  [ChatMessageType.Social, 'Social 0x0a'],
  [ChatMessageType.SocialSend, 'SocialSend 0x0b'],
  [ChatMessageType.Emote, 'Emote 0x0c'],
  [ChatMessageType.Advancement, 'Advancement 0x0d'],
  [ChatMessageType.Abuse, 'Abuse 0x0e'],
  [ChatMessageType.Help, 'Help 0x0f'],
  [ChatMessageType.Appraisal, 'Appraisal 0x10'],
  [ChatMessageType.Spellcasting, 'Spellcasting 0x11'],
  [ChatMessageType.Allegiance, 'Allegiance 0x12'],
  [ChatMessageType.Fellowship, 'Fellowship 0x13'],
  [ChatMessageType.WorldBroadcast, 'WorldBroadcast 0x14'],
  [ChatMessageType.CombatEnemy, 'CombatEnemy 0x15'],
  [ChatMessageType.CombatSelf, 'CombatSelf 0x16'],
  [ChatMessageType.Recall, 'Recall 0x17'],
  [ChatMessageType.Craft, 'Craft 0x18'],
  [ChatMessageType.Salvaging, 'Salvaging 0x19'],
  [ChatMessageType.AdminTell, 'AdminTell 0x1f'],
];
const GROUP = 4; // the main log shows four lines at the default dock height

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

/** Same scripted creation as measure-perf.ts (source string — tsx __name landmine). */
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

async function captureLive(label: string): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  console.log(`[core17s] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core17s] virgin account at character-create — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17s] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, `_${label}-login-failed.png`) });
    await browser.close();
    throw new Error('never entered world — see _login-failed.png');
  }
  console.log('[core17s] in world; settling');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@telepoi holtburg');
  await page.waitForTimeout(4000);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(2500);

  const chatLines = await page.evaluate(() => {
    const chat = document.getElementById('chat-messages');
    return chat ? [...chat.children].map((c) => (c.textContent ?? '').trim()) : null;
  });
  console.log(`[core17s] chat lines: ${JSON.stringify(chatLines)}`);
  const idle = join(OUT, `${label}-hud-idle-over-world.png`);
  await page.screenshot({ path: idle });
  console.log(`[core17s] ${idle}`);

  // Swatch: one line per text type through the shipped addSystemMessage path,
  // GROUP at a time (the main log shows four lines), cropped to the chat log.
  const rect = await page.evaluate(() => {
    const el = document.getElementById('chat-messages');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });
  if (!rect) throw new Error('#chat-messages not found');
  for (let g = 0; g * GROUP < TYPES.length; g++) {
    const slice = TYPES.slice(g * GROUP, g * GROUP + GROUP).map(([type, name]) => ({ type, name, color: chatColorFor(type) }));
    await page.evaluate((lines) => {
      const ui = (window as any).__ac?.gameUI;
      for (const l of lines) ui?.addSystemMessage?.(`${l.name}: The quick brown fox`, l.color, l.type);
    }, slice);
    await page.waitForTimeout(400);
    const file = join(OUT, `${label}-swatch-${g}.png`);
    await page.screenshot({ path: file, clip: rect });
    console.log(`[core17s] ${file} ${slice.map((s) => `${s.name}=${s.color}`).join(' ')}`);
  }
  await browser.close();
}

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

function cropCell(p: Panel, zoom: number): string {
  return `<div class="cell"><div class="lbl">${p.label}</div>
    <div class="clip" style="width:${p.w * zoom}px;height:${p.h * zoom}px">
      <img src="${dataUrl(p.file)}" style="position:absolute;left:${-p.x * zoom}px;top:${-p.y * zoom}px;transform-origin:0 0;transform:scale(${zoom});image-rendering:pixelated"/>
    </div></div>`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:900px}
  .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
  .full img{display:block;width:780px;height:auto;border:1px solid #444}
  .sw img{display:block;border:1px solid #444;image-rendering:pixelated}
  table{border-collapse:collapse} td{padding:2px 8px;border-bottom:1px solid #333}
  h1{font-size:14px;margin:0 0 8px}
</style>`;

async function compose(): Promise<void> {
  const BEFORE = join(OUT, 'before-hud-idle-over-world.png');
  const AFTER = join(OUT, 'after-hud-idle-over-world.png');
  for (const f of [WINE, BEFORE, AFTER]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2700, height: 1200 } });

  const chat: Panel[] = [
    { file: WINE, label: 'retail EoL client (Wine, 1024x768) fresh login at Holtburg: the ACE welcome (ChatMessageType.Broadcast 0x00) is GREEN', x: 0, y: 660, w: 430, h: 108 },
    { file: BEFORE, label: 'ours BEFORE: the same Broadcast lines rendered through resolveChatType(0 -> System) + the hand-written table = grey/white', x: 0, y: 670, w: 430, h: 105 },
    { file: AFTER, label: 'ours AFTER: chatColorFor built like BuildChatColorLookupTable @ 004f31c0 — type 0 = colorGreen (0x81c578) #80ff7f', x: 0, y: 670, w: 430, h: 105 },
  ];
  await page.setContent(`${CSS}<h1>CORE.17.s — main chat log after login: retail vs ours before/after (3x crops, bottom-left)</h1>
    <div class="row">${chat.map((p) => cropCell(p, 3)).join('')}</div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17s-chat-sidebyside.png'), fullPage: true });

  await page.setContent(`${CSS}<h1>CORE.17.s — whole screen: retail EoL client (Wine 1024x768) | ours before | ours after (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours BEFORE</div><img src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER</div><img src="${dataUrl(AFTER)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17s-fullscreen-sidebyside.png'), fullPage: true });

  // Swatch: before | after crops per group + the retail legend.
  const groups: string[] = [];
  for (let g = 0; g * GROUP < TYPES.length; g++) {
    const b = join(OUT, `before-swatch-${g}.png`);
    const a = join(OUT, `after-swatch-${g}.png`);
    const legend = TYPES.slice(g * GROUP, g * GROUP + GROUP)
      .map(([t, n]) => `<tr><td>${n}</td><td style="color:${chatColorFor(t)}">${chatColorFor(t)} (after)</td></tr>`).join('');
    groups.push(`<div class="row sw">
      <div class="cell"><div class="lbl">before ${g}</div>${existsSync(b) ? `<img src="${dataUrl(b)}" style="width:${430 * 2}px"/>` : '<div class="lbl">missing</div>'}</div>
      <div class="cell"><div class="lbl">after ${g}</div>${existsSync(a) ? `<img src="${dataUrl(a)}" style="width:${430 * 2}px"/>` : '<div class="lbl">missing</div>'}</div>
      <div class="cell"><div class="lbl">retail default (BuildChatColorLookupTable, .data 0x81c4a8..0x81c578)</div><table>${legend}</table></div>
    </div><div style="height:10px"></div>`);
  }
  await page.setContent(`${CSS}<h1>CORE.17.s — one line per text type through addSystemMessage(text, chatColorFor(type), type): before | after | retail table</h1>${groups.join('')}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17s-swatch-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17s] wrote side-by-sides to ${OUT}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (process.argv.includes('--compose')) { await compose(); return; }
  if (!LABEL) throw new Error('usage: --label before|after, or --compose');
  await captureLive(LABEL);
}

main().catch((e) => { console.error(e); process.exit(1); });
