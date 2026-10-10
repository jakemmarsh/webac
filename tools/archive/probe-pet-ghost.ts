/**
 * probe-pet-ghost — disambiguates why a crate/essence use decrements charges
 * without a client-visible summon (GAP.30 verification runs 3/4).
 *
 * Theory: the previous session's passive pet is still active server-side
 * (browser closed without logout; the ACE session lingers ~600s, and
 * HandleCurrentActivePet_Retail (Pet.cs:145-175) then treats the first device
 * use as a STOW of that ghost pet — returning false/null: charges consumed on
 * the combat-essence path, no CreateObject either way. A SECOND use must then
 * summon for real.
 *
 * Instruments every CreateObject the client registers to rule out a client-
 * side drop.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=petghost';
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-pet-ghost-probe`);

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

  // Tap chat + every world-object registration.
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    window.__chatTap = [];
    for (const m of ['addSystemMessage', 'addChatMessage']) {
      if (typeof ui[m] !== 'function' || ui[m].__tapped) continue;
      const orig = ui[m].bind(ui);
      const wrapped = (...args) => { window.__chatTap.push(args.filter(a => typeof a === 'string').join(' | ')); return orig(...args); };
      wrapped.__tapped = true;
      ui[m] = wrapped;
    }
    const som = window.__ac.serverObjectManager;
    window.__createTap = [];
    if (!som.createObject.__tapped) {
      const orig = som.createObject.bind(som);
      som.createObject = (data) => {
        window.__createTap.push({ t: Date.now(), guid: data.guid, name: data.name });
        return orig(data);
      };
      som.createObject.__tapped = true;
    }
  })()`);

  const invBefore = await page.evaluate(`window.__ac.playerState.inventory.getAll().map(i => i && i.id)`) as number[];
  await talk(page, '@ci 33919');
  await page.waitForTimeout(6000);
  const crate = await page.evaluate(`(() => {
    const before = new Set(${JSON.stringify(invBefore)});
    const items = window.__ac.playerState.inventory.getAll();
    for (let i = 0; i < items.length; i++) if (items[i] && items[i].name === 'Baby Drudge Crate' && !before.has(items[i].id)) return { idx: i, guid: items[i].id };
    return null;
  })()`) as any;
  console.log('[probe] fresh crate:', JSON.stringify(crate));
  if (!crate) throw new Error('fresh crate not registered client-side — @ci CreateObject dropped?');

  const useOnce = async (label: string, idx: number) => {
    const chatLen = await page.evaluate(`window.__chatTap.length`) as number;
    await page.evaluate(`window.__ac.gameUI.dragCallbacks.onDoubleClickItem(${idx})`);
    await page.waitForTimeout(9000);
    const out = await page.evaluate(`(() => ({
      chat: window.__chatTap.slice(${chatLen}),
      creates: window.__createTap.slice(),
      pets: (() => { const r = []; for (const [g,o] of window.__ac.serverObjectManager.getAllObjects()) if (o.name && (o.name.includes('Pet Baby Drudge') || o.name.includes("'s Golem"))) r.push({ guid: g, name: o.name }); return r; })(),
    }))()`) as any;
    console.log(`[probe] ${label}: pets=${JSON.stringify(out.pets)} chat=${JSON.stringify(out.chat)} creates(last3)=${JSON.stringify(out.creates.slice(-3))}`);
    return out;
  };

  const first = await useOnce('use-1 (expect ghost-stow: no pet, no error)', crate.idx);
  const second = await useOnce('use-2 (expect real summon)', crate.idx);

  writeFileSync(join(OUT, 'probe.json'), JSON.stringify({ utc: UTC, crate, first, second }, null, 2));
  await page.screenshot({ path: join(OUT, 'final.png') });
  await browser.close();
  console.log(`[probe] done — ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
