/**
 * CORE.17.t — live evidence that slash emotes print the retail self line and
 * ship the 3rd-person text to the server, and that the server's echo of our
 * own soul emote is dropped (ClientCommunicationSystem::Pose @ 00580480 /
 * Handle_Communication__HearSoulEmote @ 0057d020 / HearEmote @ 0057cbe0 —
 * docs/retail-client-symbols.md CORE.17.t).
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright,
 * logs in like tools/capture-core17ka-notices-sidebyside.ts, then types real
 * commands into #chat-input (+ Enter):
 *   /wave    → chat "You wave."; sent 0x01E1 "waves."; ACE echoes
 *              GameMessageSoulEmote(our guid) → dropped (no second line)
 *   /akimbo  → chat "You put your hands on your hips."; sent "puts his|her
 *              hands on his|her hips." (the "%p" pronoun per Gender)
 *   /afk     → chat "You decide to rest for a while." + the server's AFK
 *              confirmation (SetAfkMode round-trip, CORE.17.k.a); /afk again
 *              toggles back
 * Shoots ours-emotes-chat.png (whole screen after the three emotes), writes
 * live-state.json (chat lines / last sent text / last echo after every step)
 * and composes
 *   core17t-chat-sidebyside.png        retail Wine chat | ours (3x crops)
 *   core17t-fullscreen-sidebyside.png  retail Wine frame | ours whole screen
 *
 * Usage: npx tsx tools/capture-core17t-emote-lines.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17t');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const OURS = join(OUT, 'ours-emotes-chat.png');
const STATE = join(OUT, 'live-state.json');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };

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

interface Snapshot {
  step: string;
  chatLines: string[];
  lastSoulEmoteSent: string | null;
  lastSoulEmoteEcho: { senderGuid: number; senderName: string; message: string; dropped: boolean } | null;
  gender: number | null;
}

async function snapshot(page: Page, step: string): Promise<Snapshot> {
  const s = await page.evaluate(() => {
    const w = window as any;
    const chat = document.getElementById('chat-messages');
    return {
      chatLines: chat ? [...chat.children].map((c) => ((c as HTMLElement).dataset.chatText ?? c.textContent ?? '').trim()) : [],
      lastSoulEmoteSent: w.__ac?.lastSoulEmoteSent ?? null,
      lastSoulEmoteEcho: w.__ac?.lastSoulEmoteEcho ?? null,
      gender: w.__playerState?.gender ?? null,
    };
  });
  const snap = { step, ...s };
  console.log(`[core17t] ${step}: chat=${JSON.stringify(snap.chatLines)} sent=${JSON.stringify(snap.lastSoulEmoteSent)} echo=${JSON.stringify(snap.lastSoulEmoteEcho)} gender=${snap.gender}`);
  return snap;
}

async function send(page: Page, cmd: string): Promise<void> {
  await page.focus('#chat-input');
  await page.fill('#chat-input', cmd);
  await page.keyboard.press('Enter');
}

async function waitForChatLine(page: Page, needle: string, timeout = 10000): Promise<boolean> {
  return page.waitForFunction((n) => {
    const chat = document.getElementById('chat-messages');
    return !!chat && [...chat.children].some((c) => ((c as HTMLElement).dataset.chatText ?? c.textContent ?? '').includes(n));
  }, needle, { timeout }).then(() => true).catch(() => false);
}

async function waitForEcho(page: Page, message: string, timeout = 10000): Promise<boolean> {
  return page.waitForFunction((m) => (window as any).__ac?.lastSoulEmoteEcho?.message === m, message, { timeout })
    .then(() => true).catch(() => false);
}

async function captureLive(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (msg) => {
    const t = msg.text();
    if (/error|Error/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`);
  });
  console.log(`[core17t] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17t] not in world yet — reloading (phantom-session retry)');
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '_login-failed.png') });
    await browser.close();
    throw new Error('never entered world — see _login-failed.png');
  }
  console.log('[core17t] in world; letting the login notices expire');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);

  const snaps: Snapshot[] = [];
  await send(page, '/clear');
  await page.waitForTimeout(400);
  snaps.push(await snapshot(page, 'baseline (after /clear)'));

  // 1. /wave → "You wave." locally; "waves." shipped; the echo of our guid dropped.
  await send(page, '/wave');
  const waveLine = await waitForChatLine(page, 'You wave.');
  const waveEcho = await waitForEcho(page, 'waves.');
  await page.waitForTimeout(600);
  const s1 = await snapshot(page, 'after /wave');
  snaps.push(s1);
  console.log(`[core17t] /wave: self line=${waveLine} echo arrived=${waveEcho} dropped=${s1.lastSoulEmoteEcho?.dropped}`);

  // 2. /akimbo → the "%p" pronoun in the shipped text.
  await send(page, '/akimbo');
  const akimboLine = await waitForChatLine(page, 'You put your hands on your hips.');
  const pronoun = (s1.gender === 1) ? 'his' : 'her';
  const akimboEcho = await waitForEcho(page, `puts ${pronoun} hands on ${pronoun} hips.`);
  await page.waitForTimeout(600);
  const s2 = await snapshot(page, 'after /akimbo');
  snaps.push(s2);
  console.log(`[core17t] /akimbo: self line=${akimboLine} echo(${pronoun}) arrived=${akimboEcho} dropped=${s2.lastSoulEmoteEcho?.dropped}`);

  // 3. /afk → the emote self line + the server's AFK confirmation.
  await send(page, '/afk');
  const afkLine = await waitForChatLine(page, 'You decide to rest for a while.');
  const afkOn = await waitForChatLine(page, 'You are now set to away-from-keyboard.');
  const afkEcho = await waitForEcho(page, 'decides to rest for a while.');
  await page.waitForTimeout(600);
  const s3 = await snapshot(page, 'after /afk');
  snaps.push(s3);
  console.log(`[core17t] /afk: self line=${afkLine} server confirmation=${afkOn} echo arrived=${afkEcho} dropped=${s3.lastSoulEmoteEcho?.dropped}`);

  const t0 = Date.now();
  await page.screenshot({ path: OURS });
  console.log(`[core17t] ${OURS} (screenshot took ${Date.now() - t0} ms)`);

  await send(page, '/afk');
  await waitForChatLine(page, 'You are no longer set to away-from-keyboard.');
  snaps.push(await snapshot(page, 'after second /afk'));

  const doubled = snaps.flatMap((s) => s.chatLines).filter((l) => /You You/.test(l));
  writeFileSync(STATE, JSON.stringify({
    url: URL, view: VIEW, snapshots: snaps,
    checks: { waveLine, waveEcho, akimboLine, akimboEcho, afkLine, afkOn, afkEcho, doubledLines: doubled },
  }, null, 2));
  console.log(`[core17t] wrote ${STATE}; doubled lines: ${JSON.stringify(doubled)}`);
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
  h1{font-size:14px;margin:0 0 8px}
</style>`;

async function compose(): Promise<void> {
  for (const f of [WINE, OURS]) {
    if (!existsSync(f)) throw new Error(`missing ${f}`);
  }
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2700, height: 1200 } });

  const chat: Panel[] = [
    { file: WINE, label: 'retail EoL client (Wine, 1024x768) at Holtburg: the main chat log (no emote frame exists in the reference corpus — the line text is anchored to the decomp)', x: 0, y: 660, w: 430, h: 108 },
    { file: OURS, label: 'ours after /wave, /akimbo, /afk: "You wave." / "You put your hands on your hips." / "You decide to rest for a while." (Pose @ 00580480 → HearEmote @ 0057cbe0, type 0x0C) + the AFK confirmation; the server echoes of our own guid dropped (HearSoulEmote @ 0057d020)', x: 0, y: 670, w: 430, h: 105 },
  ];
  await page.setContent(`${CSS}<h1>CORE.17.t — main chat log: retail vs ours after three slash emotes (3x crops, bottom-left)</h1>
    <div class="row">${chat.map((p) => cropCell(p, 3)).join('')}</div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17t-chat-sidebyside.png'), fullPage: true });

  await page.setContent(`${CSS}<h1>CORE.17.t — whole screen: retail EoL client (Wine 1024x768) | ours after /wave, /akimbo, /afk (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours — the three emote self lines + the AFK confirmation in the log</div><img src="${dataUrl(OURS)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17t-fullscreen-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17t] wrote side-by-sides to ${OUT}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((err) => { console.error(err); process.exit(1); });
