/**
 * probe-barber — GAP.barber-ui-retail live check (scorecard flow-barber).
 *
 * Opens gmBarberUI (layout 0x21000068) with ACE's `@barbershop` (developer
 * command; sends GameEventStartBarber), then with real mouse clicks: steps the
 * hair row once, picks colour spot 2, rotates the preview, and presses Apply.
 * Checks that the panel opened at its smartbox slot, that Apply sent
 * FinishBarber and closed the page, and that the server answered with an
 * ObjDescEvent for the player (the player model is rebuilt with new materials). Re-opens the page to show the
 * new face read back from StartBarber. Screenshots go to verification/barber/.
 *
 * Usage: npx tsx tools/probe-barber.ts   (run under tools/with-gpu-lock.sh)
 *   AC_ACCOUNT defaults to fxprobe3 here (an admin account the GPU worker does not use).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, enterWorld, gameUrl, shot } from './lib/game-session.ts';

const OUT = 'verification/barber';
const ACCOUNT = process.env.AC_ACCOUNT ?? 'fxprobe3';
const el = (id: number) => `[data-element-id="0x${id.toString(16)}"]`;
const ROOT = 0x10000599, HAIR_ROW = 0x1000059e, ARROW_NEXT = 0x1000030b, SPOT2 = 0x1000030f + 2;
const ROTATE = 0x100005a4, APPLY = 0x100005a6;

async function click(page: Page, selector: string, label: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${label}: ${selector} not on screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(800);
}

/** The player model's material/texture identities: applyPlayerAppearance (own ObjDescEvent) rebuilds them. */
const modelSignature = (page: Page): Promise<string> => page.evaluate(`(() => { const m = window.__ac.playerModel; if (!m) return '';
  const ids = []; m.traverse((o) => { const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const x of mats) ids.push(x.uuid + ':' + (x.map ? x.map.uuid : '-')); }); return ids.join('|'); })()`) as Promise<string>;

const panelOpen = (page: Page): Promise<boolean> =>
  page.evaluate(`(() => { const r = document.querySelector('${el(ROOT)}'); return !!r && r.getBoundingClientRect().width > 0; })()`) as Promise<boolean>;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const log: string[] = [];
  const s = await enterWorld({ settleMs: 6000, url: gameUrl({ cb: 'barber', env: { ...process.env, AC_ACCOUNT: ACCOUNT, AC_PASSWORD: ACCOUNT } }) } as never);
  const page = s.page;
  page.on('console', (m) => { const t = m.text(); if (/barber|error|exception/i.test(t)) log.push(t.slice(0, 200)); });
  const results: Record<string, unknown> = {};
  try {
    await adminCommand(page, '@barbershop');
    for (let i = 0; i < 20 && !(await panelOpen(page)); i++) await page.waitForTimeout(500);
    results.opened = await panelOpen(page);
    if (!results.opened) throw new Error('gmBarberUI never opened after @barbershop');
    results.rootBox = await page.locator(el(ROOT)).first().boundingBox();
    await page.waitForTimeout(2500); // preview model load
    await shot(page, `${OUT}/1-open.png`);

    await click(page, `${el(HAIR_ROW)} ${el(ARROW_NEXT)}`, 'hair next');
    await click(page, el(SPOT2), 'colour spot 2');
    await click(page, el(ROTATE), 'rotate');
    await page.waitForTimeout(1500);
    await shot(page, `${OUT}/2-edited.png`);

    const sigBefore = await modelSignature(page);
    await click(page, el(APPLY), 'apply');
    await page.waitForTimeout(6000);
    results.closedAfterApply = !(await panelOpen(page));
    const sigAfter = await modelSignature(page);
    results.playerModelRebuilt = sigBefore !== '' && sigAfter !== '' && sigBefore !== sigAfter;
    await shot(page, `${OUT}/3-applied.png`);

    await adminCommand(page, '@barbershop');
    for (let i = 0; i < 20 && !(await panelOpen(page)); i++) await page.waitForTimeout(500);
    await page.waitForTimeout(2500);
    await shot(page, `${OUT}/4-reopened.png`);
  } finally {
    results.log = log;
    writeFileSync(`${OUT}/results.json`, `${JSON.stringify(results, null, 1)}\n`);
    console.log(JSON.stringify(results, null, 1));
    await s.browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
