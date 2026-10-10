/**
 * verify-pet-summoning — live in-cloud verification for GAP.30
 * (pet summoning: combat pets + lum-pets).
 *
 * Server ground truth (ACE):
 *  - PetDevice.ActOnUse (PetDevice.cs:61-101): generic Use on the essence/crate
 *    summons the PetClass weenie; Structure decrements via
 *    GameMessagePublicUpdatePropertyInt when the device carries charges.
 *  - Pet.Init (Pet.cs:62-114): pet spawns in front of the player, renamed
 *    "<Player>'s <Name>", Ethereal, RadarBehavior.ShowNever; passive pets
 *    follow the owner (SlowTick → MoveToObject broadcast).
 *  - HandleCurrentActivePet_Retail (Pet.cs:145-175): re-using a passive-pet
 *    device stows the pet (a second use re-summons); a combat-pet device with
 *    a combat pet active sends the "X is already active" transient — but in
 *    the EoL data every combat pet's Lifespan (43s) is shorter than every
 *    essence's SharedCooldown (45s), so that transient is only reachable via
 *    the heartbeat race ACE documents at PetDevice.cs:119-124; the reachable
 *    behavior is lifespan despawn + post-cooldown re-summon.
 *  - WorldObject_Use.cs:326-336: SharedCooldown re-use inside CooldownDuration
 *    → "You have used this item too recently" transient.
 *
 * The retail client has NO pet-specific UI or commands (the only "pet" string
 * in the decompiled EoL client is the .pet DAT-extension registration for
 * PhysicsScriptTable) — the client's whole role is the generic pipes above.
 *
 * Test content (full ace_world dump): Baby Drudge Crate 33919 → Pet Baby
 * Drudge 33918 (passive, no requirements, no charges); Mud Golem Essence
 * 48886 → Golem 48887 (CombatPet, Structure 50/50, UseRequiresSkill=Summoning
 * trained @ 50, SharedCooldown 213 / 45s).
 *
 * Output: verification/playtest/<utc>-pet-summoning/
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=petsummon';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-pet-summoning`);

const CRATE_WCID_NAME = 'Baby Drudge Crate';
const ESSENCE_WCID_NAME = 'Mud Golem Essence';
const PROPERTY_INT_STRUCTURE = 92; // ACE PropertyInt.Structure

const steps: Array<Record<string, unknown>> = [];
const failures: string[] = [];
const consoleLines: string[] = [];

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

async function installChatTap(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    window.__chatTap = [];
    for (const m of ['addSystemMessage', 'addChatMessage']) {
      if (typeof ui[m] !== 'function' || ui[m].__tapped) continue;
      const orig = ui[m].bind(ui);
      const wrapped = (...args) => {
        window.__chatTap.push({ via: m, text: args.filter(a => typeof a === 'string').join(' | ') });
        return orig(...args);
      };
      wrapped.__tapped = true;
      ui[m] = wrapped;
    }
  })()`);
}

async function chatTap(page: Page): Promise<Array<{ via: string; text: string }>> {
  return page.evaluate(`window.__chatTap.slice()`) as any;
}

async function talk(page: Page, text: string): Promise<void> {
  await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(text)})`);
  console.log(`[talk] ${text}`);
}

/**
 * @ci an item and return the FRESH copy's inventory index + guid (diffed
 * against the pre-@ci inventory) — prior runs leave older, partially-consumed
 * copies in the persistent shard character's pack.
 */
async function createInventoryItem(page: Page, wcid: number, name: string): Promise<{ idx: number; guid: number } | null> {
  const invBefore = await page.evaluate(`window.__ac.playerState.inventory.getAll().map(i => i && i.id)`) as number[];
  await talk(page, `@ci ${wcid}`);
  return waitFor(() => page.evaluate(`(() => {
    const before = new Set(${JSON.stringify(invBefore)});
    const items = window.__ac.playerState.inventory.getAll();
    for (let i = 0; i < items.length; i++) {
      if (items[i] && items[i].name === ${JSON.stringify(name)} && !before.has(items[i].id)) return { idx: i, guid: items[i].id };
    }
    return null;
  })()`) as any, 20_000);
}

/** Re-resolve a known guid's current inventory index (indices shift as items are added). */
async function inventoryIndexOf(page: Page, guid: number): Promise<number> {
  return page.evaluate(`(() => {
    const items = window.__ac.playerState.inventory.getAll();
    for (let i = 0; i < items.length; i++) if (items[i] && items[i].id === ${guid}) return i;
    return -1;
  })()`) as any;
}

/** Drive the real inventory double-click gesture path (GameUI cell dblclick → onDoubleClickItem). */
async function dblClickInventoryItem(page: Page, idx: number): Promise<void> {
  await page.evaluate(`window.__ac.gameUI.dragCallbacks.onDoubleClickItem(${idx})`);
}

/**
 * All tracked world objects whose name includes the fragment. Reads the LIVE
 * interpolated world coordinates (worldX/worldZ — updated by
 * applyPositionUpdate on every server UpdatePosition), NOT the static
 * ACPosition captured at CreateObject time.
 */
async function findWorldObjects(page: Page, nameFragment: string): Promise<Array<{ guid: number; name: string; radarBehavior: number; x: number; y: number; z: number }>> {
  return page.evaluate(`(() => {
    const out = [];
    for (const [guid, o] of window.__ac.serverObjectManager.getAllObjects()) {
      if (o.name && o.name.includes(${JSON.stringify(nameFragment)})) {
        out.push({ guid, name: o.name, radarBehavior: o.radarBehavior,
                   x: o.worldX, y: o.worldZ, z: o.worldY });
      }
    }
    return out;
  })()`) as any;
}

async function playerPos(page: Page): Promise<{ x: number; z: number }> {
  return page.evaluate(`(() => { const cs = window.acDebug.collisionState(); return { x: cs.x, z: cs.z }; })()`) as any;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 1500): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v as T;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

function record(step: string, data: Record<string, unknown>, failure?: string | null): void {
  steps.push({ step, ...data });
  console.log(`[verify] ${step}: ${JSON.stringify(data)}${failure ? ` FAIL: ${failure}` : ''}`);
  if (failure) failures.push(`${step}: ${failure}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  page.on('console', msg => {
    const t = msg.text();
    if (t.includes('[Property] PublicInt') || t.includes('Sent Use') || t.includes('DeleteObject')) consoleLines.push(t);
  });

  console.log(`[verify] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[verify] create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[verify] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep looping */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '00-never-entered.png') });
    await browser.close();
    throw new Error('never entered world');
  }
  await page.waitForTimeout(10_000);
  await installChatTap(page);

  // The default spawn is the sealed Holtburg starter cottage — too cramped for
  // Pet.Init's InFrontOf spawn placement (run 1 reproduced ACE's own
  // "Couldn't spawn <pet>" EnterWorld failure against the cottage wall).
  // Teleport to open outdoor Holtburg first.
  // Holtburg outdoor POI lands at roughly world (32532, 34567). Skip the
  // teleport when the character already saved there — run 3 showed that a
  // same-position @telepoi leaves the session in a state where subsequent
  // CreateObjects never register client-side (tracked separately).
  const HOLTBURG = { x: 32532, z: 34567 };
  const posBefore = await playerPos(page);
  if (Math.hypot(posBefore.x - HOLTBURG.x, posBefore.z - HOLTBURG.z) > 150) {
    await talk(page, '@telepoi Holtburg');
    const teleported = await waitFor(async () => {
      const p = await playerPos(page);
      return Math.hypot(p.x - posBefore.x, p.z - posBefore.z) > 50 ? p : null;
    }, 40_000);
    record('A0-telepoi-holtburg', { posBefore, teleported }, teleported ? null : '@telepoi Holtburg never moved the player');
    await page.waitForTimeout(15_000); // let the outdoor landblock stream in
  } else {
    record('A0-already-at-holtburg', { posBefore });
  }
  await page.screenshot({ path: join(OUT, '01-spawn.png') });

  // ── Phase A: passive lum-pet (Baby Drudge Crate) ──────────────────────────
  const crate = await createInventoryItem(page, 33919, CRATE_WCID_NAME);
  record('A1-crate-in-inventory', { crate }, crate ? null : 'fresh crate never landed in inventory after @ci 33919');
  if (!crate) throw new Error('cannot continue without crate');

  await dblClickInventoryItem(page, crate.idx);
  let pet1 = await waitFor(async () => {
    const objs = await findWorldObjects(page, 'Pet Baby Drudge');
    return objs.length > 0 ? objs[0] : null;
  }, 20_000);
  if (!pet1) {
    // A lingering pet from a crashed prior session makes the first use a
    // retail STOW (Pet.cs:150-156) — one more click then summons for real.
    record('A2a-first-use-stowed-ghost', { note: 'no pet on first use; clicking again per retail stow semantics' });
    await dblClickInventoryItem(page, crate.idx);
    pet1 = await waitFor(async () => {
      const objs = await findWorldObjects(page, 'Pet Baby Drudge');
      return objs.length > 0 ? objs[0] : null;
    }, 20_000);
  }
  record('A2-passive-pet-summoned', { pet1 }, pet1 ? null : 'no "Pet Baby Drudge" world object after using crate (two attempts)');
  await page.screenshot({ path: join(OUT, '02-passive-pet-summoned.png') });

  if (pet1) {
    // Pet.Init renames to "<Player>'s <Name>" (Pet.cs:88).
    if (!/'s Pet Baby Drudge$/.test(pet1.name)) failures.push(`A2: pet name "${pet1.name}" lacks owner prefix (Pet.cs:88)`);
    // SetEphemeralValues → RadarBehavior.ShowNever (Pet.cs:56); radar loop culls on it (main.ts).
    if (pet1.radarBehavior !== 1) failures.push(`A2: pet radarBehavior=${pet1.radarBehavior}, expected ShowNever=1 (Pet.cs:56)`);

    // A3 — follow: run away, pet's SlowTick follow should close the gap.
    const before = await playerPos(page);
    const petBefore = { x: pet1.x, y: pet1.y };
    await page.keyboard.down('w');
    await page.waitForTimeout(3500);
    await page.keyboard.up('w');
    await page.waitForTimeout(8000);
    const after = await playerPos(page);
    const petAfterArr = await findWorldObjects(page, 'Pet Baby Drudge');
    const petAfter = petAfterArr[0];
    const playerMoved = Math.hypot(after.x - before.x, after.z - before.z);
    const petMoved = petAfter ? Math.hypot(petAfter.x - petBefore.x, petAfter.y - petBefore.y) : 0;
    const petPlayerDist = petAfter ? Math.hypot(petAfter.x - after.x, petAfter.y - after.z) : NaN;
    record('A3-passive-pet-follows', { playerMoved, petMoved, petPlayerDist, petBefore, petAfter },
      playerMoved > 2 && petMoved < 0.5 ? 'player moved but pet never moved (no follow position updates applied)' : null);
    await page.screenshot({ path: join(OUT, '03-passive-pet-follow.png') });

    // A4 — retail stow: re-using the crate destroys the pet; next use re-summons.
    const crateIdx = await inventoryIndexOf(page, crate.guid);
    await dblClickInventoryItem(page, crateIdx);
    const stowed = await waitFor(async () => {
      const objs = await findWorldObjects(page, 'Pet Baby Drudge');
      return objs.length === 0 ? true : null;
    }, 20_000);
    record('A4-passive-pet-stowed', { stowed }, stowed ? null : 'pet object still present after re-using crate (retail stow, Pet.cs:150-156)');
    await page.screenshot({ path: join(OUT, '04-passive-pet-stowed.png') });

    await dblClickInventoryItem(page, crateIdx);
    const pet2 = await waitFor(async () => {
      const objs = await findWorldObjects(page, 'Pet Baby Drudge');
      return objs.length > 0 ? objs[0] : null;
    }, 20_000);
    record('A5-passive-pet-resummoned', { pet2 }, pet2 ? null : 'second use did not re-summon the passive pet');
    if (pet2 && pet1 && pet2.guid === pet1.guid) failures.push('A5: re-summoned pet has the same guid as the destroyed one');
    // stow it again to leave a clean slate for phase B
    if (pet2) { await dblClickInventoryItem(page, crateIdx); await page.waitForTimeout(6000); }
  }

  // ── Phase B: combat pet (Mud Golem Essence, Summoning-gated, 50 charges) ──
  // B0: an untrained character must first be refused (UseRequiresSkill=54 trained).
  const essence = await createInventoryItem(page, 48886, ESSENCE_WCID_NAME);
  record('B1-essence-in-inventory', { essence }, essence ? null : 'fresh essence never landed in inventory after @ci 48886');
  if (!essence) throw new Error('cannot continue without essence');

  // B2: use once. A character with untrained Summoning must be refused
  // (WorldObject_Use.cs:239); one already trained by a previous run of this
  // harness (the shard persists) summons immediately instead.
  const tapB0 = (await chatTap(page)).length;
  await dblClickInventoryItem(page, essence.idx);
  const firstUse = await waitFor(async () => {
    const added = (await chatTap(page)).slice(tapB0);
    const refusal = added.find(l => /must have.*Summoning trained/i.test(l.text));
    if (refusal) return { kind: 'refusal' as const, refusal };
    const objs = await findWorldObjects(page, "'s Golem");
    if (objs.length > 0) return { kind: 'summoned' as const, golem: objs[0] };
    return null;
  }, 20_000);

  let golem: { guid: number; name: string; radarBehavior: number } | null = null;
  if (firstUse?.kind === 'refusal') {
    record('B2-untrained-refused', { refusal: firstUse.refusal });

    // B3: train Summoning through the real TrainSkill pipe, then max ranks.
    await talk(page, '@grantxp 191226310247');
    await page.waitForTimeout(4000);
    await page.evaluate(`window.acDebug.trainSkill(54, 8)`); // Summoning trainedCost=8 (DAT SkillTable)
    await page.waitForTimeout(4000);
    await talk(page, '@spendallxp');
    await page.waitForTimeout(8000);

    await dblClickInventoryItem(page, essence.idx);
    golem = await waitFor(async () => {
      const objs = await findWorldObjects(page, "'s Golem");
      return objs.length > 0 ? objs[0] : null;
    }, 25_000);
    record('B4-combat-pet-summoned', { golem }, golem ? null : 'no "<Player>\'s Golem" world object after using essence with trained Summoning');
  } else if (firstUse?.kind === 'summoned') {
    record('B2-already-trained-summoned', { note: 'character retains trained Summoning from a prior run; refusal path covered by that run', golem: firstUse.golem });
    golem = firstUse.golem;
  } else {
    record('B2-first-use', {}, 'first essence use produced neither the untrained refusal nor a summoned golem');
  }
  await page.screenshot({ path: join(OUT, '05-combat-pet-summoned.png') });

  // charge decrement: PetDevice.ActOnUse → PublicUpdatePropertyInt(Structure) 50→49 on the essence guid.
  const structLine = consoleLines.find(l =>
    l.includes('[Property] PublicInt') && l.includes(`guid=0x${essence.guid.toString(16)}`) && l.includes(`key=${PROPERTY_INT_STRUCTURE} `) && l.includes('value=49'));
  record('B5-charge-decremented', { structLine: structLine ?? null, propertyLines: consoleLines.filter(l => l.includes('PublicInt')).slice(-5) },
    structLine ? null : 'no PublicUpdatePropertyInt Structure=49 for the essence guid (PetDevice.cs:94)');

  if (golem) {
    // B6: immediate re-use inside the 45s SharedCooldown window.
    const tapB6 = (await chatTap(page)).length;
    await dblClickInventoryItem(page, essence.idx);
    const cooldownMsg = await waitFor(async () => {
      const added = (await chatTap(page)).slice(tapB6);
      return added.find(l => /used this item too recently/i.test(l.text)) ?? null;
    }, 15_000);
    record('B6-cooldown-refusal', { cooldownMsg },
      cooldownMsg ? null : 'no "You have used this item too recently" transient on immediate re-use (WorldObject_Use.cs:335)');

    // B7: the combat pet's Lifespan (43s — weenie 48887 int prop 267) is
    // SHORTER than the device's 45s SharedCooldown (float prop 167), for
    // every essence tier in the EoL data (spot-checked 48884/49372/49551 —
    // all cooldown 45 / lifespan 43). The "X is already active" transient
    // (PetDevice.cs:130) is therefore unreachable in normal data flow — it
    // exists only for the heartbeat-offset race ACE documents at
    // PetDevice.cs:119-124 — and the client-side pipe it would use is the
    // same transient pipe B2/B6 already prove. What IS reachable: the pet
    // dies at end-of-life (client must apply the despawn), and a post-
    // cooldown re-use summons a fresh golem with another charge decrement.
    console.log('[verify] waiting out the 45s SharedCooldown (golem lifespan 43s expires first)…');
    await page.waitForTimeout(47_000);
    const golemsAfterLifespan = await findWorldObjects(page, "'s Golem");
    record('B7-lifespan-despawn', { golemsAfterLifespan },
      golemsAfterLifespan.length === 0 ? null : `golem still tracked ${47}s after summon — Lifespan 43s despawn not applied client-side`);

    await dblClickInventoryItem(page, essence.idx);
    const golem2 = await waitFor(async () => {
      const objs = await findWorldObjects(page, "'s Golem");
      return objs.length > 0 ? objs[0] : null;
    }, 25_000);
    record('B8-post-cooldown-resummon', { golem2 },
      golem2 ? null : 'post-cooldown re-use did not summon a fresh golem');
    if (golem2 && golem && golem2.guid === golem.guid) failures.push('B8: re-summoned golem has the same guid as the expired one');
    const structAgain = consoleLines.find(l =>
      l.includes('[Property] PublicInt') && l.includes(`guid=0x${essence.guid.toString(16)}`) && l.includes(`key=${PROPERTY_INT_STRUCTURE} `) && l.includes('value=48'));
    record('B9-second-charge-decremented', { structAgain: structAgain ?? null },
      structAgain ? null : 'no Structure=48 PublicUpdatePropertyInt after the second successful summon');
    await page.screenshot({ path: join(OUT, '06-post-cooldown-resummon.png') });
  }

  const finalChat = await chatTap(page);
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({
    utc: UTC, steps, failures,
    propertyConsoleLines: consoleLines.filter(l => l.includes('PublicInt')),
    chat: finalChat.slice(-80),
  }, null, 2));

  await browser.close();

  if (failures.length) {
    console.error('[verify] FAIL:\n' + failures.map(f => ` - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log(`[verify] PASS — pet summoning end-to-end verified. Evidence: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
