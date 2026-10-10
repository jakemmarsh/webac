/**
 * Live verification for BUG.createobject-movement-placement-skipped (corpse
 * case). The "Corpse of " name-prefix hack is deleted — a corpse can only
 * lie down if the CreateObject PhysicsDesc Movement blob (CurrentMotionState
 * = Motion(NonCombat, MotionCommand.Dead), ACE Corpse.cs:58) is parsed and
 * applied.
 *
 * Flow: smite the Sparring Golems near the Holtburg POI, screenshot it standing, @smite all (its
 * corpse arrives as a fresh CreateObject carrying Dead), dump the corpse
 * mesh pose + screenshot, teleport out of visibility and back (a second
 * fresh CreateObject), dump + screenshot again. Both corpse poses must
 * match each other and differ from the standing pose.
 *
 * Usage: npx tsx tools/capture-corpse-initial-motion.ts [outDir]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'verification/createobject-initial-motion';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=corpseverify';
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate("!!(window.acDebug?.collisionState?.().x > 0)") as Promise<boolean>;
}

async function chat(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    (window as unknown as { acDebug: { sendChat: (s: string) => void } }).acDebug.sendChat(t);
  }, text);
}

/** Find object by name-prefix; dump its mesh's level-1 child poses. */
async function objState(page: Page, namePrefix: string): Promise<{ guid?: string; pose?: string }> {
  return page.evaluate(`(() => {
    const som = window.__ac.serverObjectManager;
    let found = null;
    som.getAllObjects().forEach((o, g) => { if (!found && o.name && o.name.startsWith(${JSON.stringify(namePrefix)})) found = { g, o }; });
    if (!found) return {};
    const r2 = (v) => Math.round(v * 100) / 100;
    const pose = (found.o.mesh?.children ?? []).map(n =>
      [r2(n.position.x), r2(n.position.y), r2(n.position.z), r2(n.quaternion.x), r2(n.quaternion.y), r2(n.quaternion.z), r2(n.quaternion.w)].join(',')
    ).join(' | ');
    return { guid: '0x' + found.g.toString(16), pose };
  })()`) as Promise<{ guid?: string; pose?: string }>;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (msg) => {
    const t = msg.text();
    if (/objectCreate.*Corpse of Sparring/i.test(t)) console.log('[console]', t.slice(0, 140));
  });

  console.log('[corpse] navigating');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline && !(await inWorld(page))) {
    if (Date.now() - lastReload > 60_000) {
      console.log('[corpse] not in world yet — reloading');
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) throw new Error('never entered world');

  console.log('[corpse] in world; teleporting to open ground');
  await chat(page, '@telepoi holtburg');
  await page.waitForTimeout(6000);

  // Standing reference: a live Sparring Golem (perf-cycle spawns near the
  // Holtburg POI; they respawn between runs and die to @smite all).
  const standing = await objState(page, 'Sparring Golem');
  console.log('[corpse] live golem:', JSON.stringify(standing));
  await page.screenshot({ path: `${OUT}/corpse-0-alive.png` });

  console.log('[corpse] smiting');
  await chat(page, '@smite all');
  let corpse1: { guid?: string; pose?: string } = {};
  for (let i = 0; i < 12 && !corpse1.guid; i++) {
    await page.waitForTimeout(1500);
    corpse1 = await objState(page, 'Corpse of Sparring Golem');
  }
  console.log('[corpse] corpse after death:', JSON.stringify(corpse1));
  await page.screenshot({ path: `${OUT}/corpse-1-dead.png` });
  if (!corpse1.guid) throw new Error('no corpse appeared');

  console.log('[corpse] teleporting away (30s — ACE drops known objects ~25s out of range)');
  await chat(page, '@telepoi arwic');
  await page.waitForTimeout(30000);
  const gone = await objState(page, 'Corpse of Sparring Golem');
  console.log('[corpse] corpse while away:', JSON.stringify(gone));

  console.log('[corpse] teleporting back');
  await chat(page, '@telepoi holtburg');
  await page.waitForTimeout(12000); // let the re-entry CreateObjects land before dumping
  const corpse2 = await objState(page, 'Corpse of Sparring Golem');
  console.log('[corpse] corpse on return:', JSON.stringify(corpse2));
  await page.screenshot({ path: `${OUT}/corpse-2-returned.png` });

  const lying1 = corpse1.pose ?? 'a';
  const lying2 = corpse2.pose ?? 'b';
  console.log('[corpse] VERDICT: pose match after round-trip =', lying1 === lying2,
    '| differs from standing =', lying1 !== (standing.pose ?? ''));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
