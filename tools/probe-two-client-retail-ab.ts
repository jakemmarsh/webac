/**
 * probe-two-client-retail-ab — retail A/B for the multi-player social flows
 * (HARNESS.retail-ab-multiplayer-frames; scorecard flow-social-multiplayer).
 *
 * tools/probe-two-client-social.ts proves the flows work between two of OUR
 * clients, but no retail frame of a two-player flow existed. This probe keeps
 * one of ours as the initiator (O = fxprobe1 / Fxprobe) and runs the same
 * script twice against a different receiver standing on the same spot:
 *
 *   phase retail — R: the real retail client under Wine on Xvfb
 *                  (tools/launch-retail-client.sh, account testacjs3 / Obsprobe)
 *   phase ours   — B: our browser client (fxprobe2 / Fxprobetwo)
 *
 * so every frame pairs retail's receiver with ours at the same moment of the
 * same flow, both at 1600x900:
 *   fellowship-invite  O recruits the receiver: its Yes/No confirmation
 *   fellowship-joined  the receiver clicked Yes and is in O's fellowship
 *   allegiance-ask     O swears allegiance to the receiver: its confirmation
 *   allegiance-sworn   the receiver clicked Yes (O is now its vassal)
 *   trade              O double-clicks the receiver: the receiver's trade window
 *
 * The receiver answers each dialog by clicking Yes with the mouse: on retail
 * the button is found in the frame (retailYesButton), on ours via the dialog
 * DOM. Output goes to verification/retail-ab/social-<scene>/{retail,ours,sheet}.png
 * (ours.png is gitignored, like capture-retail-ab's) and results.json; the
 * sheets are judged by eye, there is no pass/fail beyond each step's checks.
 *
 * Linux only (Wine needs native x86_64; tools/launch-retail-client.sh refuses
 * elsewhere). Needs the local ACE stack (tools/provision-ace-stack.sh) with
 * its MariaDB reachable through `mysql -uroot`: the probe makes the three
 * accounts admin (@teleloc) and clears the retail character's
 * IgnoreFellowshipRequests bit, which retail ships ON.
 *
 * Usage: npx tsx tools/probe-two-client-retail-ab.ts [--phase retail|ours|both] [--keep-retail]
 *   --keep-retail  reuse a retail client that is already in the world (and leave it running)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Page } from 'playwright';
import { adminCommand, enterWorld, gameUrl, REPO } from './lib/game-session.ts';
import { answerDialog, MEET_LOC, say, waitDialog } from './lib/two-client.ts';
import { retailYesButton } from './lib/retail-dialog.ts';

const VIEWPORT = { width: 1600, height: 900 } as const;
const RETAIL_ACCOUNT = 'testacjs3', RETAIL_CHAR = 'Obsprobe';
const O_ACCOUNT = 'fxprobe1', O_CHAR = 'Fxprobe';
const B_ACCOUNT = 'fxprobe2', B_CHAR = 'Fxprobetwo';
/** O stands 4 m south of the receiver, both facing north: the receiver is in front of O's camera. */
const O_LOC = MEET_LOC.replace('20.5', '16.5');
const OUT = join(REPO, 'verification', 'retail-ab');
export const SOCIAL_SCENES = ['fellowship-invite', 'fellowship-joined', 'allegiance-ask', 'allegiance-sworn', 'trade'] as const;
type Scene = typeof SOCIAL_SCENES[number];
type Side = 'retail' | 'ours';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (s: string): void => console.log(`[social-ab] ${s}`);

interface Result { phase: Side; step: string; ok: boolean; detail: string }
const results: Result[] = [];
function record(phase: Side, step: string, ok: boolean, detail: string): void {
  results.push({ phase, step, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${phase} ${step}: ${detail}`);
}

// ── Receivers ─────────────────────────────────────────────────────────

interface Receiver {
  side: Side;
  name: string;
  /** Capture the receiver's whole frame. */
  capture(file: string): Promise<void>;
  /** Wait for a confirmation dialog and click its Yes. Returns what it saw. */
  answerYes(): Promise<{ ok: boolean; detail: string }>;
  /** Whether the receiver's trade window is up; null where it cannot be read (retail: judge the frame). */
  tradeOpen(): Promise<boolean | null>;
  stop(): Promise<void>;
}

function retailReceiver(keep: boolean): Receiver {
  const env = { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99' };
  const xdo = (...args: string[]): string => execFileSync('xdotool', args, { env, encoding: 'utf8' }).trim();
  const win = (): string => xdo('search', '--onlyvisible', '--name', "^Asheron's Call$").split('\n')[0];
  const grab = (file: string): void => {
    const g = Object.fromEntries(xdo('getwindowgeometry', '--shell', win()).split('\n').map((l) => l.split('=')));
    if (Number(g.WIDTH) !== VIEWPORT.width || Number(g.HEIGHT) !== VIEWPORT.height) throw new Error(`retail window is ${g.WIDTH}x${g.HEIGHT}`);
    execFileSync('import', ['-window', 'root', '-crop', `${g.WIDTH}x${g.HEIGHT}+${g.X}+${g.Y}`, '+repage', file], { env });
  };
  // Cursor over open sky, clear of the HUD and the player (launch-retail-client.sh does the same).
  const park = (): void => { xdo('mousemove', '--window', win(), String(VIEWPORT.width * 5 / 8), String(VIEWPORT.height / 12)); };
  return {
    side: 'retail',
    name: RETAIL_CHAR,
    async capture(file) { park(); await sleep(300); grab(file); },
    async answerYes() {
      const tmp = join(OUT, '.retail-probe.png');   // gitignored
      for (let t = 0; t < 15; t++) {
        grab(tmp);
        const at = retailYesButton(PNG.sync.read(readFileSync(tmp)));
        if (at) {
          xdo('mousemove', '--window', win(), String(at.x), String(at.y), 'click', '1');
          await sleep(500);
          park();
          return { ok: true, detail: `clicked Yes at ${at.x},${at.y}` };
        }
        await sleep(1000);
      }
      return { ok: false, detail: 'no dialog button found in 15 s' };
    },
    async tradeOpen() { return null; },
    async stop() {
      if (keep) return;
      // Killing Wine leaves the character standing in the world until ACE's
      // session timeout, on the very spot phase ours puts B: O's double-click
      // then trades with the ghost. Send it to another town first.
      xdo('key', '--window', win(), 'Return'); await sleep(500);
      xdo('type', '--window', win(), '--delay', '40', '@telepoi Yaraq'); xdo('key', '--window', win(), 'Return');
      await sleep(10_000);
      spawnSync('wineserver', ['-k'], { env: { ...env, WINEPREFIX: process.env.WINEPREFIX ?? join(homedir(), '.wine32') }, stdio: 'ignore' });
    },
  };
}

function launchRetail(): void {
  const run = (): number | null => spawnSync('bash', [join(REPO, 'tools', 'launch-retail-client.sh')], {
    stdio: 'inherit',
    env: {
      ...process.env, AC_ENTER_WORLD: '1', AC_ACCOUNT: RETAIL_ACCOUNT, AC_PASSWORD: RETAIL_ACCOUNT,
      AC_RESOLUTION: `${VIEWPORT.width}x${VIEWPORT.height}`, AC_TELELOC: MEET_LOC, AC_WORLD_WAIT: '240',
    },
  }).status;
  // A previous retail session still live on ACE makes the first launch fail
  // with "Cannot have two accounts logged on"; the second gets in (script header).
  if (run() === 0) return;
  log('retail launch failed; stopping Wine and retrying once');
  spawnSync('wineserver', ['-k'], { env: { ...process.env, WINEPREFIX: process.env.WINEPREFIX ?? join(homedir(), '.wine32') } });
  execFileSync('sleep', ['5']);
  if (run() !== 0) throw new Error('launch-retail-client.sh failed twice');
}

async function oursReceiver(page: Page, close: () => Promise<void>): Promise<Receiver> {
  const name = await page.evaluate('window.__ac.playerState.name') as string;
  return {
    side: 'ours',
    name,
    async capture(file) { await page.mouse.move(VIEWPORT.width * 5 / 8, VIEWPORT.height / 12); await page.waitForTimeout(300); await page.screenshot({ path: file }); },
    async answerYes() {
      const text = await waitDialog(page, 15_000);
      if (text === null) return { ok: false, detail: 'no dialog in 15 s' };
      const ok = await answerDialog(page, true);
      return { ok, detail: `dialog ${JSON.stringify(text)}; clicked Yes: ${ok}` };
    },
    async tradeOpen() {
      return await page.evaluate('!!window.__ac.gameUI.tradePanel && window.__ac.gameUI.tradePanel.isConnected') as boolean;
    },
    stop: close,
  };
}

// ── Shared setup ──────────────────────────────────────────────────────

function sql(q: string): string {
  return execFileSync('mysql', ['-uroot', '-N', '-e', q], { encoding: 'utf8' }).trim();
}

/** @teleloc needs admin; a fresh ACE DB creates these accounts as players on first login. */
function ensureAdmins(): void {
  sql(`update ace_auth.account set accessLevel = 5 where accountName in ('${RETAIL_ACCOUNT}','${O_ACCOUNT}','${B_ACCOUNT}')`);
}

async function openOurs(account: string, character: string, cb: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const wasAdmin = sql(`select accessLevel from ace_auth.account where accountName = '${account}'`) === '5';
  const s = await enterWorld({
    createCharacter: character, viewport: VIEWPORT,
    url: gameUrl({ cb, env: { ...process.env, AC_ACCOUNT: account, AC_PASSWORD: account } }),
  } as never);
  await s.page.waitForTimeout(3000);
  if (!wasAdmin) {
    // ACE created the account on this login, as a player; it reads the access
    // level at login, so promote it and log in again.
    ensureAdmins();
    await s.browser.close().catch(() => {});
    await sleep(8000);
    return openOurs(account, character, cb);
  }
  return { page: s.page, close: async () => { await s.browser.close().catch(() => {}); } };
}

/** Poll O's world for an object named like `name`; its guid or null. */
async function findGuid(page: Page, name: string, ms = 60_000): Promise<number | null> {
  for (let t = 0; t < ms; t += 1000) {
    const g = await page.evaluate(`(() => { const all = [...window.__ac.serverObjectManager.getAllObjects().values()];
      const o = all.find((x) => (x.name ?? '').replace(/^\\+/, '') === ${JSON.stringify(name)}); return o ? o.guid : null; })()`) as number | null;
    if (g) return g;
    await page.waitForTimeout(1000);
  }
  return null;
}

const fellowNames = (page: Page): Promise<string[]> =>
  page.evaluate('(window.__ac.gameUI.fellowship?.fellows ?? []).map((f) => f.name)') as Promise<string[]>;

const sceneFile = (scene: Scene, side: Side): string => join(OUT, `social-${scene}`, `${side}.png`);

/**
 * A page point on `guid`'s model that a click there selects (the nearest
 * object under the cursor is `guid`, not a model in front of it), scanning
 * from the head down; null when no point does.
 */
async function unoccludedPointOf(page: Page, guid: number): Promise<{ x: number; y: number } | null> {
  const points = await page.evaluate(`(() => {
    const { serverObjectManager: som, sceneManager: sm } = window.__ac;
    const obj = som.getObject(${guid});
    if (!obj?.mesh || !sm.renderer) return [];
    const rect = sm.renderer.domElement.getBoundingClientRect();
    const h = Math.max(obj.collisionHeight, 1);
    return [0.95, 0.85, 0.75, 0.6, 0.45, 0.3, 0.15].map((f) => {
      const p = obj.mesh.position.clone(); p.y += h * f; p.project(sm.camera);
      return p.z > 1 ? null : { x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height };
    }).filter(Boolean);
  })()`) as Array<{ x: number; y: number }>;
  for (const pt of points) {
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(400);
    const sel = await page.evaluate('window.__ac.gameUI.hudState.target?.id ?? null') as number | null;
    if (sel === guid) return pt;
  }
  return null;
}

/** The script both phases run: O initiates, the receiver answers. */
async function runFlow(o: Page, rx: Receiver, rxGuid: number, tag: string): Promise<void> {
  const shot = async (scene: Scene): Promise<void> => {
    mkdirSync(join(OUT, `social-${scene}`), { recursive: true });
    await rx.capture(sceneFile(scene, rx.side));
    log(`${rx.side} ${scene}`);
  };
  const plain = (n: string): string => n.replace(/^\+/, '');

  // Fellowship: O creates one and recruits the selected receiver.
  await o.evaluate(`window.__ac.gameUI.callbacks.onCreateFellowship("Probers${tag}")`); // the fellowship panel's Create
  await o.waitForTimeout(2500);
  await o.evaluate(`window.acDebug.select(${rxGuid})`);
  await o.waitForTimeout(800);
  await o.evaluate('window.__ac.gameUI.callbacks.onFellowshipRecruitSelected()'); // the panel's Recruit
  await sleep(4000);
  await shot('fellowship-invite');
  const yes1 = await rx.answerYes();
  let fellows: string[] = [];
  for (let t = 0; t <= 20_000; t += 500) {
    fellows = (await fellowNames(o)).map(plain);
    if (fellows.includes(plain(rx.name))) break;
    await o.waitForTimeout(500);
  }
  record(rx.side, 'fellowship', yes1.ok && fellows.includes(plain(rx.name)), `${yes1.detail}; O lists ${JSON.stringify(fellows)}`);
  await sleep(2000);
  await shot('fellowship-joined');
  await o.evaluate('window.__ac.gameUI.callbacks.onFellowshipSteps([{ kind: "quit", disband: true }])'); // the panel's Disband
  await sleep(3000);

  // Allegiance: O swears to the selected receiver (the panel's Swear action);
  // the receiver, as patron, gets the confirmation.
  await o.evaluate(`window.acDebug.select(${rxGuid})`);
  await o.waitForTimeout(800);
  await o.evaluate(`window.__ac.gameUI.callbacks.onAllegianceSwear(${rxGuid})`); // the confirmation's Yes swears to the selection
  await sleep(4000);
  await shot('allegiance-ask');
  const yes2 = await rx.answerYes();
  let patron: string | null = null;
  for (let t = 0; t <= 20_000; t += 500) {
    patron = await o.evaluate(`(() => { const a = window.__ac.gameUI.allegianceInfo;
      const self = a && a.members.find((m) => m.guid === a.selfGuid); const p = self && a.members.find((m) => m.guid === self.parentGuid);
      return p ? p.name : null; })()`) as string | null;
    if (patron && plain(patron) === plain(rx.name)) break;
    await o.waitForTimeout(500);
  }
  record(rx.side, 'allegiance', yes2.ok && !!patron && plain(patron) === plain(rx.name), `${yes2.detail}; O's patron ${JSON.stringify(patron)}`);
  await sleep(2000);
  await shot('allegiance-sworn');
  await o.evaluate(`window.__ac.gameUI.callbacks.onAllegianceBreak(${rxGuid})`);
  await sleep(3000);

  // Trade: O double-clicks the receiver (retail's only way in). O stands
  // right behind the receiver, so O's own body can cover the receiver's chest
  // point (a double-click there Uses O itself): find a point that selects the
  // receiver first.
  const at = await unoccludedPointOf(o, rxGuid);
  if (at) await o.mouse.dblclick(at.x, at.y);
  await sleep(4000);
  const tradeO = await o.evaluate('!!window.__ac.gameUI.tradePanel && window.__ac.gameUI.tradePanel.isConnected') as boolean;
  const tradeRx = await rx.tradeOpen();
  record(rx.side, 'trade', tradeO && tradeRx !== false,
    `receiver on O's screen at ${JSON.stringify(at)}; O's trade window open: ${tradeO}; receiver's: ${tradeRx ?? 'see the frame'}`);
  await shot('trade');
  // Leave the trade so the next phase starts clean (O's window closes when the partner goes too).
  await o.keyboard.press('Escape');
  await sleep(1500);
}

/** retail | ours sheet per scene: both frames at half size, labelled. */
function sheets(): void {
  for (const scene of SOCIAL_SCENES) {
    const r = sceneFile(scene, 'retail'), o = sceneFile(scene, 'ours');
    if (!existsSync(r) || !existsSync(o)) { log(`no sheet for ${scene}: ${existsSync(r) ? '' : 'retail '}${existsSync(o) ? '' : 'ours '}missing`); continue; }
    execFileSync('montage', ['-label', 'retail (Wine, llvmpipe)', r, '-label', 'ours', o, '-tile', '2x1', '-geometry', '800x450+4+4', '-pointsize', '18',
      join(OUT, `social-${scene}`, 'sheet.png')]);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const phase = args.includes('--phase') ? args[args.indexOf('--phase') + 1] : 'both';
  if (!['retail', 'ours', 'both'].includes(phase)) throw new Error(`--phase ${phase}: expected retail, ours or both`);
  const keep = args.includes('--keep-retail');
  mkdirSync(OUT, { recursive: true });
  ensureAdmins();
  const tag = String(process.pid).slice(-4);

  if (phase !== 'ours' && !keep) {
    // The retail character must exist before the client logs in (it enters
    // the account's first character), and must accept fellowship invites.
    if (!sql(`select count(*) from ace_shard.character where name = '${RETAIL_CHAR}' and is_Deleted = 0`).startsWith('1')) {
      log(`creating ${RETAIL_CHAR} on ${RETAIL_ACCOUNT} through our client`);
      const c = await openOurs(RETAIL_ACCOUNT, RETAIL_CHAR, 'social-ab-mk');
      await c.close();
      await sleep(5000);
    }
    sql(`update ace_shard.character set character_Options_1 = character_Options_1 & ~8 where name = '${RETAIL_CHAR}'`);
  }

  const o = await openOurs(O_ACCOUNT, O_CHAR, 'social-ab-o');
  try {
    await adminCommand(o.page, `@teleloc ${O_LOC}`);
    if (phase !== 'ours') {
      if (!keep) launchRetail();
      const rx = retailReceiver(keep);
      try {
        const guid = await findGuid(o.page, RETAIL_CHAR);
        if (!guid) throw new Error(`O never saw ${RETAIL_CHAR}`);
        await runFlow(o.page, rx, guid, `${tag}r`);
      } finally {
        await rx.stop();
      }
    }
    if (phase !== 'retail') {
      // O walked up to the retail receiver for the trade: put it back on its
      // mark so both phases start from the same positions.
      await adminCommand(o.page, `@teleloc ${O_LOC}`);
      const b = await openOurs(B_ACCOUNT, B_CHAR, 'social-ab-b');
      b.page.on('console', (m) => { if (/Trade/.test(m.text())) log(`B console: ${m.text()}`); });
      // Retail ships "Ignore Fellowship Requests" on; turn it off through the option's own path.
      await b.page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.optionsSettings.ignoreFellowshipRequests = false;
        ui.callbacks.onCharacterOptionToggle?.(0x02, false); })()`);
      await adminCommand(b.page, `@teleloc ${MEET_LOC}`);
      const rx = await oursReceiver(b.page, b.close);
      try {
        const guid = await findGuid(o.page, B_CHAR);
        if (!guid) throw new Error(`O never saw ${B_CHAR}`);
        await sleep(6000);   // B's own landblock streams in before the first frame
        await runFlow(o.page, rx, guid, `${tag}b`);
      } finally {
        await rx.stop();
      }
    }
  } finally {
    await o.close();
    // One file for both phases: a single-phase run replaces only its own rows.
    const file = join(OUT, 'social-results.json');
    const prior = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).results ?? []) as Result[] : [];
    const ran = new Set(results.map((r) => r.phase));
    writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), results: [...prior.filter((r) => !ran.has(r.phase)), ...results] }, null, 1)}\n`);
  }
  sheets();
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} steps passed`);
  if (failed.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
