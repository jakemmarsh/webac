/**
 * BUG.portal-walk-in-nothing live probe: walk into portals with the keyboard
 * (the path a player takes) on local ACE and record what the portal telemetry
 * (telemetry/PortalUseReporter.ts) posts, plus every teleport and portal
 * refusal line.
 *
 * Scenarios, each from a fresh spot (@telepoi):
 *   gateway      @create 1955 "Gateway" (PhysicsState Ethereal|LightingOn, no
 *                ReportCollisions: "You must use this portal to activate it.
 *                Walking through the portal will not activate it."), walk
 *                through it. Retail and ACE: nothing happens.
 *   quest        @create 31061 (the Training Academy exit, QuestRestriction
 *                AcademyTokenGiven), walk in: ACE refuses with 0x0474.
 *   purple       @create PORTAL (default 1087, ReportCollisions, a destination),
 *                walk in. Expect a teleport.
 *   too-soon     right after that arrival, @create PORTAL and walk in: ACE's
 *                3.5 s minTimeSinceLastPortal refuses (WeenieError 0x04A7).
 *   reenter      4 s later, walk out of and back into that same portal.
 *   brush        @create PORTAL, strafe 2.6 m, walk forward past it: no try.
 *   side         @create PORTAL, strafe 0.8 m, walk forward: an off-centre walk-in.
 *   ontop        @teleloc onto a portal's own position, wait, walk 1 m.
 *
 *   BASE=http://localhost:5477/ ACCT=testacjs3 npx tsx tools/probe-portal-walk-in.ts [scenario ...]
 *
 * Uses its own deleted-at-exit browser profile (createRunProfile) and deletes
 * its spawns at the end (deleteSpawnsNear). Never run it on testacjs.
 */
import { chromium, type Page } from 'playwright';
import { createRunProfile } from './lib/temp-profile.js';
import { waitFor, chatLine, deleteSpawnsNear, IN_WORLD_JS, SWIFTSHADER_ARGS } from './lib/game-session.js';

const base = process.env.BASE ?? 'http://localhost:5477/';
const bridge = process.env.BRIDGE ?? 'ws://localhost:9090';
const acct = process.env.ACCT ?? 'testacjs3';
if (acct === 'testacjs') throw new Error('never testacjs (Jake plays it)');
const poi = process.env.POI ?? 'Holtburg';
const want = new Set(process.argv.slice(2));
const run = (s: string): boolean => want.size === 0 || want.has(s);
/** A portal that teleports (1087 Outside Accursed Halls Portal: Setup 0x020001B3, ReportCollisions, a destination, no restriction). */
const PORTAL = Number(process.env.PORTAL ?? 1087);
/** The Training Academy exit (31061, QuestRestriction AcademyTokenGiven): ACE refuses with WeenieError 0x0474. */
const QUEST_PORTAL = 31061;

const profile = createRunProfile('acjs-portal-walkin-', { tool: 'probe-portal-walk-in' });
const browser = await chromium.launchPersistentContext(profile.dir, { args: SWIFTSHADER_ARGS, viewport: { width: 1280, height: 720 } });
profile.setCloser(() => browser.close());
const page = browser.pages()[0] ?? await browser.newPage();
page.setDefaultTimeout(120_000);

const t0 = Date.now();
const ts = (): string => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const events: Record<string, unknown>[] = [];
await page.route('**/client-preworld', async (route) => {
  const body = route.request().postData() ?? '';
  try {
    const ev = JSON.parse(body) as Record<string, unknown>;
    if (typeof ev.outcome === 'string' && ev.outcome.startsWith('portal_')) {
      events.push(ev);
      const { outcome, trigger, wcid, useSent, serverWalk, overlapped, closest, weenieErrors, chatTemplate, endDist, waitedMs, ms } = ev;
      console.log(`${ts()} EVENT ${JSON.stringify({ outcome, trigger, wcid, useSent, serverWalk, overlapped, closest, weenieErrors, chatTemplate, endDist, waitedMs, ms })}`);
    }
  } catch { /* not JSON */ }
  await route.fulfill({ status: 204, body: '' });
});
page.on('console', (m) => {
  const t = m.text();
  if (/PlayerTeleport|teleport(ed)? too|portal|WeenieError|0xF751|Sent Use|UseDone|Use refused|MoveToState|MoveTo|too busy/i.test(t) && !/emitter|particle|PortalSpace|portal space/i.test(t)) console.log(`${ts()} [page] ${t.slice(0, 180)}`);
});

const ev = <T = unknown>(js: string): Promise<T> => page.evaluate(js) as Promise<T>;
await page.goto(`${base}?ace&debug&agent&bridge=${encodeURIComponent(bridge)}&account=${acct}&password=${acct}`, { waitUntil: 'commit' });
if (!(await waitFor(page, IN_WORLD_JS, { timeoutMs: 300_000, reloadEveryMs: 0 }))) throw new Error('never entered the world');
console.log(`${ts()} in world`);
await page.waitForTimeout(5000);
await page.mouse.click(640, 200);

const player = (): Promise<{ x: number; z: number; cell: string }> => ev(`(() => { const p = window.__ac.playerModel.position; const c = window.acDebug.collisionState(); return { x: +p.x.toFixed(2), z: +p.z.toFixed(2), cell: (c.cellId >>> 0).toString(16) }; })()`);
const portalsNear = (wcid: number): Promise<{ guid: number; d: number; pos: unknown }[]> => ev(`(() => { const ac = window.__ac; const p = ac.playerModel.position; const out = [];
  for (const [g, o] of ac.serverObjectManager.getAllObjects()) if (o.weenieClassId === ${wcid} && (g >>> 0) >= 0x80000000) out.push({ guid: g >>> 0, d: +Math.hypot(o.worldX - p.x, o.worldZ - p.z).toFixed(2), pos: o.position });
  return out.sort((a, b) => a.d - b.d); })()`);
const teleports = async (): Promise<number> => ev<number>(`window.__portalProbeTeleports || 0`);
await ev(`(() => { window.__portalProbeTeleports = 0; const prev = window.__ac.serverObjectManager; })()`);
// Count PlayerTeleports by watching the portal-space flag go up.
await ev(`(() => { let was = false; setInterval(() => { const now = !!window.__ac.gameUI.worldHiddenByPortalSpace; if (now && !was) window.__portalProbeTeleports++; was = now; }, 50); })()`);

async function hold(key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}
async function fresh(label: string): Promise<void> {
  console.log(`\n${ts()} ===== ${label}`);
  await chatLine(page, `@telepoi ${poi}`);
  await page.waitForTimeout(12_000);
  await waitFor(page, `!window.__ac.gameUI.worldHiddenByPortalSpace`, { timeoutMs: 60_000, reloadEveryMs: 0 });
  await page.waitForTimeout(6_000);
  const gone = await deleteSpawnsNear(page, [1955, QUEST_PORTAL, PORTAL], 40);
  if (gone) { console.log(`${ts()} deleted ${gone} earlier spawn(s)`); await page.waitForTimeout(1500); }
}
async function spawn(wcid: number): Promise<void> {
  await chatLine(page, `@create ${wcid}`);
  await page.waitForTimeout(2500);
  console.log(`${ts()} spawned ${wcid}: ${JSON.stringify((await portalsNear(wcid)).slice(0, 1).map((p) => p.d))} m; player ${JSON.stringify(await player())}`);
}
async function settle(label: string, ms = 9000): Promise<void> {
  const before = await teleports();
  await page.waitForTimeout(ms);
  console.log(`${ts()} ${label}: teleports +${(await teleports()) - before}, player ${JSON.stringify(await player())}`);
}

if (run('gateway')) {
  await fresh('gateway: walk through a Gateway (no ReportCollisions)');
  await spawn(1955);
  const tp = await teleports();
  await hold('KeyW', 2200);
  await settle('after walking through the Gateway');
  console.log(`${ts()} gateway teleported: ${(await teleports()) > tp}`);
}
/** Back 8 m away from a fresh Gateway, select it, and use it with the UseSelected key (the path a player's double-click takes: the Use goes out, ACE walks the player). */
async function gatewayAtRange(): Promise<void> {
  await spawn(1955);
  await hold('KeyX', 3500);
  const [g] = await portalsNear(1955);
  console.log(`${ts()} gateway at ${g?.d} m`);
  const sel = await ev(`JSON.stringify(window.__acAgent.select('Gateway'))`);
  await page.waitForTimeout(500);
  console.log(`${ts()} select ${sel}; hud target ${await ev(`String(window.__ac.gameUI.hudState.target?.id?.toString(16))`)}`);
  await page.mouse.click(640, 650); // keyboard focus back on the game, off any panel
}
if (run('held-use')) {
  // Prod 2026-11-04 shape: use the Gateway while a run key is held. Retail: the held key sends nothing, the server's walk wins.
  await fresh('held-use: hold W, use the Gateway at 8 m');
  await gatewayAtRange();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(400);
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(6000);
  await page.keyboard.up('KeyW');
  await settle('after using the Gateway with W held');
}
if (run('busy-use')) {
  // Prod 2026-11-04 shape: a player spamming casts (dozens of "You're too busy!") uses the Gateway 5 times; no walk, no teleport.
  await fresh('busy-use: cast nonstop, use the Gateway at 8 m five times');
  await gatewayAtRange();
  await ev(`(() => { window.__probeCasting = true; const loop = async () => { while (window.__probeCasting) { try { await window.__acAgent.cast('Strength Self I', 'self'); } catch {} await new Promise((r) => setTimeout(r, 150)); } }; void loop(); })()`);
  await page.waitForTimeout(2500);
  for (let i = 0; i < 5; i++) { await page.keyboard.press('KeyR'); await page.waitForTimeout(1800); }
  await ev(`window.__probeCasting = false`);
  await settle('after five uses while casting');
}
if (run('quest')) {
  await fresh('quest: walk into the Training Academy exit (QuestRestriction)');
  await spawn(QUEST_PORTAL);
  await hold('KeyW', 2200);
  await settle('after walking into the quest portal');
}
if (run('brush')) {
  await fresh('brush: walk past a purple portal 2.6 m off-centre');
  await spawn(PORTAL);
  await hold('KeyZ', 1400);
  console.log(`${ts()} after strafe ${JSON.stringify(await player())}`);
  await page.waitForTimeout(1500);
  // The body's closest horizontal pass by the portal, sampled every 50 ms (render frame).
  await ev(`(() => { window.__portalProbeMin = 1e9; window.__portalProbeTimer = setInterval(() => { const ac = window.__ac; const p = ac.playerModel.position;
    for (const [g, o] of ac.serverObjectManager.getAllObjects()) if (o.weenieClassId === ${PORTAL} && (g >>> 0) >= 0x80000000 && !ac.gameUI.worldHiddenByPortalSpace)
      window.__portalProbeMin = Math.min(window.__portalProbeMin, Math.hypot(o.worldX - p.x, o.worldZ - p.z)); }, 50); })()`);
  await hold('KeyW', 2200);
  await settle('after brushing past');
  console.log(`${ts()} closest pass ${(await ev<number>('window.__portalProbeMin')).toFixed(2)} m (a touch needs < 1.84)`);
  await ev(`clearInterval(window.__portalProbeTimer)`);
}
if (run('side')) {
  await fresh('side: walk into a purple portal 0.8 m off-centre');
  await spawn(PORTAL);
  await hold('KeyZ', 450);
  await hold('KeyW', 2000);
  await settle('after the off-centre walk-in');
}
if (run('purple') || run('too-soon') || run('reenter')) {
  await fresh('purple: walk straight into a purple portal');
  await spawn(PORTAL);
  await hold('KeyW', 2000);
  await waitFor(page, `!!window.__ac.gameUI.worldHiddenByPortalSpace`, { timeoutMs: 8000, reloadEveryMs: 0 });
  await waitFor(page, `!window.__ac.gameUI.worldHiddenByPortalSpace`, { timeoutMs: 60_000, reloadEveryMs: 0 });
  console.log(`${ts()} arrived ${JSON.stringify(await player())}`);
  if (run('too-soon') || run('reenter')) {
    await spawn(PORTAL);
    await hold('KeyW', 1500);
    await settle('too-soon walk-in', 7000);
    if (run('reenter')) {
      await hold('KeyX', 2500);
      await page.waitForTimeout(1500);
      await hold('KeyW', 2600);
      await settle('re-entered the same portal after leaving it');
    }
    await deleteSpawnsNear(page, [PORTAL], 40);
  }
}
if (run('ontop')) {
  await fresh('ontop: teleloc onto a purple portal');
  await spawn(PORTAL);
  const [p] = await portalsNear(PORTAL);
  const pos = p?.pos as { landblock: number; x: number; y: number; z: number } | undefined;
  if (pos) {
    await chatLine(page, `@teleloc 0x${(pos.landblock >>> 0).toString(16).padStart(8, '0')} [${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${(pos.z + 0.05).toFixed(2)}] 1 0 0 0`);
    await page.waitForTimeout(3000);
    await waitFor(page, `!window.__ac.gameUI.worldHiddenByPortalSpace`, { timeoutMs: 60_000, reloadEveryMs: 0 });
    await settle('standing where we arrived on the portal', 8000);
    await hold('KeyW', 400);
    await settle('after stepping inside it', 8000);
    await hold('KeyW', 2200);
    await settle('after walking out', 4000);
    await hold('KeyX', 2400);
    await settle('after backing into it again');
  }
}

console.log(`\n${ts()} cleanup`);
await fresh('cleanup');
console.log(`EVENTS ${JSON.stringify(events)}`);
await browser.close();
process.exit(0);
