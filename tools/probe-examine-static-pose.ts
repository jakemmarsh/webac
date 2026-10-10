/**
 * probe-examine-static-pose — BUG.examine-copies-live-pose.
 *
 * Jake (2026-10-06): examining a player should show a static figure like the
 * paperdoll, not their live movement. Two clients: A examines B while B runs
 * (W held), then again with B standing still. Retail's figure is a fresh
 * makeObject in its motion table's default state, so both portraits must be
 * the same pixels. A also examines B while B portals in (Hidden / fading):
 * MorphToExistingObject copies translucencyOriginal, so the figure is whole.
 * Saves the canvases + A's screenshots to verification/examine-static-pose/
 * and exits 1 on a difference or a blank fading portrait.
 *
 * Usage: npx tsx tools/probe-examine-static-pose.ts   (env: tools/lib/two-client.ts)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, shot } from './lib/game-session.ts';
import { openTwoClients } from './lib/two-client.ts';

const OUT = 'verification/examine-static-pose';

/** Select `guid` on A, press E (Examine) and return the portrait canvas as a data URL once it draws. */
async function examinePortrait(page: Page, guid: number): Promise<string | null> {
  await page.evaluate(`(() => { document.querySelectorAll('canvas.ac-examine-preview').forEach((c) => c.remove()); window.acDebug.select(${guid}); })()`);
  await page.mouse.click(700, 150);
  await page.evaluate(`window.acDebug.select(${guid})`);
  await page.keyboard.press('e');
  for (let t = 0; t < 8000; t += 250) {
    const url = await page.evaluate(`(() => { const c = document.querySelector('canvas.ac-examine-preview'); return c ? c.toDataURL('image/png') : null; })()`) as string | null;
    if (url) return url;
    await page.waitForTimeout(250);
  }
  return null;
}

/** Opaque pixels in a portrait data URL (decoded in the page). */
const opaquePixels = (page: Page, url: string) => page.evaluate(`(async () => { const img = new Image(); img.src = ${JSON.stringify(url)}; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })()`) as Promise<number>;

const closeExamine = async (page: Page): Promise<void> => { await page.keyboard.press('Escape'); await page.waitForTimeout(800); };

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { a, b, close } = await openTwoClients('examine-pose');
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const save = (name: string, url: string | null) => { if (url) writeFileSync(`${OUT}/portrait-${name}.png`, Buffer.from(url.split(',')[1], 'base64')); };
  try {
    // 1. B portaling in (Hidden / fading): the portrait still draws the whole figure.
    await adminCommand(a.page, `@teletome ${b.name}`);
    await a.page.waitForTimeout(700);
    const fading = await examinePortrait(a.page, b.guid);
    save('fading', fading);
    await shot(a.page, `${OUT}/1-fading-a.png`);
    results.fadingOpaquePixels = fading ? await opaquePixels(a.page, fading) : 0;
    await closeExamine(a.page);
    for (let i = 0; i < 60 && !(await b.page.evaluate('window.acDebug.collisionState().loginComplete')); i++) await b.page.waitForTimeout(250);
    await b.page.waitForTimeout(3000);

    // 2. B running.
    await b.page.mouse.click(780, 300);
    await b.page.keyboard.down('w');
    await b.page.waitForTimeout(800);
    const running = await examinePortrait(a.page, b.guid);
    results.bMotionWhileExamined = await a.page.evaluate(`(() => { const o = window.__ac.serverObjectManager.getObject(${b.guid}); const m = o && o.physics; return o ? { at: [o.worldX, o.worldZ], vel: m && m.velocity } : null; })()`);
    await shot(a.page, `${OUT}/2-running-a.png`);
    await b.page.keyboard.up('w');
    save('running', running);
    await closeExamine(a.page);
    await b.page.waitForTimeout(4000);

    // 3. B standing.
    const standing = await examinePortrait(a.page, b.guid);
    save('standing', standing);
    await shot(a.page, `${OUT}/3-standing-a.png`);
    results.bAfter = await a.page.evaluate(`(() => { const o = window.__ac.serverObjectManager.getObject(${b.guid}); return o ? [o.worldX, o.worldZ] : null; })()`);
    results.identical = !!running && running === standing;
    results.fadingDrawn = (results.fadingOpaquePixels as number) > 2000;
    results.pass = results.identical && results.fadingDrawn;
    console.log(JSON.stringify(results));
  } finally {
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2) + '\n');
    await close();
  }
  if (!results.pass) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
