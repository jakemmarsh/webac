/**
 * probe-pet-follow — wire-level diagnosis for the passive-pet follow question
 * (GAP.30 verification): after summoning a lum-pet and walking away, does the
 * server ever send UpdatePosition / MovementEvent for the pet guid, and does
 * the client apply it?
 *
 * ACE ground truth: Pet.SlowTick (1x/s) calls StartFollow when
 * dist(owner) > 2m; StartFollow broadcasts a MoveToObject motion and moves the
 * server-side physics; Pet.Tick (5x/s) then streams SendUpdatePosition while
 * IsMoving (Pet.cs:180-253).
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=petfollow';
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-pet-follow-probe`);

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function talk(page: Page, text: string): Promise<void> {
  await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(text)})`);
  console.log(`[talk] ${text}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) throw new Error('never entered world');
  await page.waitForTimeout(8000);

  // tap position/motion application per guid
  await page.evaluate(`(() => {
    const som = window.__ac.serverObjectManager;
    window.__posTap = [];
    window.__motTap = [];
    if (!som.updatePosition.__tapped) {
      const orig = som.updatePosition.bind(som);
      som.updatePosition = (data) => { window.__posTap.push({ t: Date.now(), guid: data.guid, x: data.x, y: data.y }); return orig(data); };
      som.updatePosition.__tapped = true;
    }
    if (!som.handleMovementEvent.__tapped) {
      const orig2 = som.handleMovementEvent.bind(som);
      som.handleMovementEvent = (data) => { window.__motTap.push({ t: Date.now(), guid: data.guid, len: data.movementData.length, type: data.movementData.length >= 7 ? data.movementData[6] : -1 }); return orig2(data); };
      som.handleMovementEvent.__tapped = true;
    }
  })()`);

  const pos0 = await page.evaluate(`(() => { const cs = window.acDebug.collisionState(); return { x: cs.x, z: cs.z }; })()`) as any;
  await talk(page, '@telepoi Holtburg');
  await page.waitForTimeout(20_000);

  // find crate (persisted from prior runs) or create one
  let crate = await page.evaluate(`(() => {
    const items = window.__ac.playerState.inventory.getAll();
    for (let i = 0; i < items.length; i++) if (items[i] && items[i].name === 'Baby Drudge Crate') return { idx: i, guid: items[i].id };
    return null;
  })()`) as any;
  if (!crate) {
    await talk(page, '@ci 33919');
    await page.waitForTimeout(8000);
    crate = await page.evaluate(`(() => {
      const items = window.__ac.playerState.inventory.getAll();
      for (let i = 0; i < items.length; i++) if (items[i] && items[i].name === 'Baby Drudge Crate') return { idx: i, guid: items[i].id };
      return null;
    })()`) as any;
  }
  if (!crate) throw new Error('no crate');

  await page.evaluate(`window.__ac.gameUI.dragCallbacks.onDoubleClickItem(${crate.idx})`);
  let pet: any = null;
  for (let i = 0; i < 15 && !pet; i++) {
    await page.waitForTimeout(2000);
    pet = await page.evaluate(`(() => {
      for (const [guid, o] of window.__ac.serverObjectManager.getAllObjects()) {
        if (o.name && o.name.includes('Pet Baby Drudge')) return { guid, name: o.name };
      }
      return null;
    })()`);
  }
  console.log('[probe] pet:', JSON.stringify(pet));
  if (!pet) throw new Error('no pet summoned');

  // walk away, then sample
  await page.keyboard.down('w');
  await page.waitForTimeout(3500);
  await page.keyboard.up('w');

  const samples: any[] = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(2500);
    const s = await page.evaluate(`(() => {
      const cs = window.acDebug.collisionState();
      let petPos = null;
      const o = window.__ac.serverObjectManager.getObject(${pet.guid});
      if (o && o.position) petPos = { x: o.position.x, y: o.position.y, landblock: o.position.landblock };
      const posForPet = window.__posTap.filter(p => p.guid === ${pet.guid});
      const motForPet = window.__motTap.filter(p => p.guid === ${pet.guid});
      return { t: Date.now(), player: { x: cs.x, z: cs.z }, petPos,
               posTapTotal: window.__posTap.length, posForPet: posForPet.length,
               motForPet, lastPosForPet: posForPet.slice(-2) };
    })()`);
    samples.push(s);
    console.log(`[probe] sample ${i}: petPos=${JSON.stringify((s as any).petPos)} posForPet=${(s as any).posForPet} motForPet=${JSON.stringify((s as any).motForPet.slice(-2))} posTapTotal=${(s as any).posTapTotal}`);
  }

  writeFileSync(join(OUT, 'probe.json'), JSON.stringify({ utc: UTC, pos0, pet, samples }, null, 2));
  await page.screenshot({ path: join(OUT, 'final.png') });
  await browser.close();
  console.log(`[probe] done — ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
