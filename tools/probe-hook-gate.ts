/**
 * probe-hook-gate — live check of the housing-hook store gate
 * (ItemHolder::CheckHookStatus @ 00586e90 inside the placement path, and
 * gmExternalContainerUI::DragItemAcceptable @ 004cbb60 for the drag art).
 * fxprobe1 (an admin) buys the free cottage north of Holtburg (covenant
 * crystal 0x7ABBE0A1, ACE @purchase-house), opens its floor hook 0x7ABBE042
 * (hook_type 1 = floor, hook_item_types all) and drops:
 *  wall     a Chainmail Basinet (wcid 35, hook_type 2 = wall): the drag art
 *           refuses, the drop sends nothing and spews retail's refusal
 *  floor    a Bottle (wcid 140, hook_type 1 = floor): accepted, a
 *           PutItemInContainer to the hook goes out and it lands there
 *  full     a second Bottle on the now-occupied hook: refused here
 *           (WillItemFitInContainer on the hook's ViewContents), nothing sent
 * Then abandons the house (@house abandon, retail's command) so the town is
 * left as found. Writes verification/hook-gate/{results.json,*.png}.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-hook-gate.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, enterWorld, gameUrl, shot } from './lib/game-session.ts';
import { say, waitDialog, answerDialog } from './lib/two-client.ts';

const OUT = 'verification/hook-gate';
const SLUMLORD = 0x7abbe0a1;
const FLOOR_HOOK = 0x7abbe042;
const WCID = { basinet: 35, bottle: 140 } as const;
const HOOK_REFUSAL = 'That item cannot be placed on the hook.';

const ev = <T>(p: Page, js: string): Promise<T> => p.evaluate(js) as Promise<T>;
async function waitUntil(p: Page, fn: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  for (let t = 0; t < ms; t += 400) { if (await fn()) return true; await p.waitForTimeout(400); }
  return fn();
}
const heldOf = (p: Page, wcid: number) => ev<number>(p, `(() => { const i = window.__ac.playerState.inventory.getAll().find((x) => x.weenieClassId === ${wcid}); return i ? i.id >>> 0 : 0; })()`);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 600)}`); };
  const s = await enterWorld({ settleMs: 3000, url: gameUrl({ cb: 'hook-gate', env: { ...process.env, AC_ACCOUNT: 'fxprobe1', AC_PASSWORD: 'fxprobe1' } }) } as never);
  const P = s.page;
  const sent: string[] = [];
  P.on('console', (m) => { const t = m.text(); if (/Sent (PutItemInContainer|StackableMerge)|item list drop/.test(t)) sent.push(t.slice(0, 200)); });
  let bought = false;
  try {
    // Buy the cottage: appraise its covenant crystal, then @purchase-house.
    await adminCommand(P, '@teleloc 0xABBE001A [92.0 41.0 100.5] 1 0 0 0');
    await P.waitForTimeout(12_000);
    await ev(P, `window.__ac.identifyObject(${SLUMLORD})`);
    await P.waitForTimeout(1500);
    await adminCommand(P, '@purchase-house');
    await P.waitForTimeout(4000);
    bought = true;
    // ACE relinks the hooks to the new owner (House.UpdateLinks) without
    // resending them: leave the area so they are re-created with the owner.
    await adminCommand(P, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
    await P.waitForTimeout(10_000);
    // Into the house, next to the floor hook.
    await adminCommand(P, '@teleloc 0xABBE011A [87.0 33.5 100.2] 1 0 0 0');
    await P.waitForTimeout(10_000);
    for (const w of [WCID.basinet, WCID.bottle]) {
      if (!(await heldOf(P, w))) { await adminCommand(P, `@ci ${w}`); await waitUntil(P, async () => (await heldOf(P, w)) !== 0); }
    }
    const basinet = await heldOf(P, WCID.basinet);
    const bottle = await heldOf(P, WCID.bottle);
    const hookDesc = await ev(P, `(() => { const o = window.__ac.serverObjectManager.getObject(${FLOOR_HOOK}); return o ? { hookType: o.hookType, hookItemTypes: o.hookItemTypes >>> 0, houseOwnerId: (o.houseOwnerId >>> 0).toString(16) } : null; })()`);
    await ev(P, `window.acDebug.useObject(${FLOOR_HOOK})`);
    const opened = await waitUntil(P, async () => (await ev<number>(P, 'window.__ac.gameUI.openContainerGuid >>> 0')) === FLOOR_HOOK, 15_000);
    // Empty the hook (an earlier run's item stays with the house).
    const onHook = () => ev<number[]>(P, `[...document.querySelectorAll('[data-ac-container-guid]')].map((c) => Number(c.dataset.acContainerGuid) >>> 0)`);
    for (const g of await onHook()) {
      await ev(P, `window.__ac.gameUI.containerCallbacks.onTakeItem(${g})`);
      await waitUntil(P, async () => !(await onHook()).includes(g), 8000);
      await P.waitForTimeout(600);
    }
    await shot(P, `${OUT}/hook-open.png`);
    const accept = await ev<{ basinet: boolean; bottle: boolean }>(P, `(() => { const cb = window.__ac.gameUI.containerCallbacks; return { basinet: cb.dragAcceptable(${basinet}), bottle: cb.dragAcceptable(${bottle}) }; })()`);

    // wall item on a floor hook
    const spewMark = await ev(P, 'window.__ac.gameUI.spewBox.items.forEach((i) => { i.__hookSeen = true; })');
    void spewMark;
    sent.length = 0;
    await ev(P, `window.__ac.gameUI.containerCallbacks.onStoreItem(${basinet}, 0)`);
    await P.waitForTimeout(1500);
    const spew = await ev<string[]>(P, 'window.__ac.gameUI.spewBox.items.filter((i) => !i.__hookSeen).map((i) => i.text)');
    record('wall', opened && accept.basinet === false && sent.length === 0 && spew.includes(HOOK_REFUSAL), { hookDesc, opened, accept, sent: sent.slice(), spew });

    // floor item on a floor hook
    sent.length = 0;
    await ev(P, `window.__ac.gameUI.containerCallbacks.onStoreItem(${bottle}, 0)`);
    const landed = await waitUntil(P, async () => !(await heldOf(P, WCID.bottle)) || (await heldOf(P, WCID.bottle)) !== bottle, 8000);
    await shot(P, `${OUT}/hook-floor-item.png`);
    record('floor', accept.bottle === true && landed && sent.some((l) => l.includes(`→ 0x${FLOOR_HOOK.toString(16)}`)), { landed, sent: sent.slice() });

    // full: the hook holds its one item; a second floor item is refused here, nothing sent.
    await P.waitForTimeout(1000);
    await adminCommand(P, `@ci ${WCID.bottle}`);
    await waitUntil(P, async () => (await heldOf(P, WCID.bottle)) !== 0);
    const bottle2 = await heldOf(P, WCID.bottle);
    const cap = await ev(P, `window.__ac.serverObjectManager.getObject(${FLOOR_HOOK})?.itemsCapacity`);
    await ev(P, 'window.__ac.gameUI.spewBox.items.forEach((i) => { i.__hookSeen = true; })');
    sent.length = 0;
    await ev(P, `window.__ac.gameUI.containerCallbacks.onStoreItem(${bottle2}, 0)`);
    await P.waitForTimeout(1500);
    const spew2 = await ev<string[]>(P, 'window.__ac.gameUI.spewBox.items.filter((i) => !i.__hookSeen).map((i) => i.text)');
    record('full', sent.length === 0 && spew2.length > 0, { cap, onHook: await onHook(), sent: sent.slice(), spew: spew2 });
    // Leave the hook empty.
    for (const g of await onHook()) {
      await ev(P, `window.__ac.gameUI.containerCallbacks.onTakeItem(${g})`);
      await waitUntil(P, async () => !(await onHook()).includes(g), 8000);
      await P.waitForTimeout(600);
    }
  } finally {
    if (bought) {
      // Leave the town as found: abandon the cottage (retail @house abandon asks twice).
      await ev(P, 'window.__ac.gameUI.closeContainerPanelFromUi && window.__ac.gameUI.closeContainerPanelFromUi()').catch(() => {});
      await say(P, '@house abandon').catch(() => {});
      // Two Yes/No dialogs (HouseAbandonDialogCallback_First / _Second).
      for (let i = 0; i < 2; i++) {
        const d = await waitDialog(P, 6000);
        console.log(`abandon dialog ${i + 1}: ${d}`);
        if (d) { await answerDialog(P, true); await P.waitForTimeout(800); }
      }
      await P.waitForTimeout(3000);
      console.log(`abandon: ${JSON.stringify((await ev<string[]>(P, "[...document.querySelectorAll('#chat-messages > *')].slice(-4).map((e) => e.textContent)")))}`);
    }
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    await s.browser.close();
  }
  if (fails.length) { console.log(`FAILED: ${fails.join(', ')}`); process.exit(1); }
  console.log('ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
