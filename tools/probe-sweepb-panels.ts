/**
 * probe-sweepb-panels — live checks for the SWEEP1006B ui-panels fixes
 * (client A = fxprobe1, an admin, in Holtburg; B only stands by):
 *  charinfo   the Character Information report carries retail's
 *             UpdateEnduranceInfo block ("Natural Resistances: X / Drain
 *             Resistances: X / Regeneration Bonus: Y", tiers from BASE
 *             Str+End and Str+2·End) between the deaths line and the innate
 *             line, and the innate line prints the creation (_init_level)
 *             values
 *  usemsg     a pack double-click (the real cell's dblclick) on a Prismatic
 *             Taper (ItemUseable No) prints "The Prismatic Taper cannot be
 *             used" and sends nothing; on a healing kit prints "Choose a
 *             target for the Handy Healing Kit" (ItemHolder::UseObject)
 *  automerge  a Prismatic Taper on the ground, used, merges into the carried
 *             taper stack (StackableMerge, no new stack): AttemptAutoMerge
 *  shownpack  a Dagger on the ground, used with the side pack shown, goes into
 *             that pack (PlaceInBackpack → mOpenContainerID)
 *  unwield    the wielded Dagger's paperdoll-slot double-click puts it in the
 *             shown pack (UseObject → DetermineUseResult 2), not the main pack
 *  worndrop   the wielded Dagger dropped on an empty cell of the shown pack's
 *             grid lands in that pack (AcceptDragObject)
 *  chest      a Dagger in an open chest, double-clicked in the container
 *             panel, goes to the shown pack (UseObject → PlaceInBackpack)
 *  fullpack   with the shown pack full, a used ground Dagger falls back to the
 *             main pack; dropped on the full pack's column slot it is refused
 *             with "The Pack is completely full!" and nothing is sent
 * Writes verification/sweepb-panels/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-sweepb-panels.ts [--only a,b]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, shot, deleteSpawnsNear } from './lib/game-session.ts';
import { openTwoClients } from './lib/two-client.ts';

const OUT = 'verification/sweepb-panels';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (k: string) => !ONLY || ONLY.has(k);

const WCID = { pack: 136, taper: 20631, dagger: 314, healingKit: 628, chest: 143 } as const;

interface Held { id: number; wcid: number; name: string; containerId: number; stackSize: number; itemType: number; itemsCapacity?: number }

const ev = <T>(p: Page, js: string): Promise<T> => p.evaluate(js) as Promise<T>;
const spew = (p: Page) => ev<string[]>(p, 'window.__ac.gameUI.spewBox.items.map((i) => i.text)');
const me = (p: Page) => ev<number>(p, 'window.__ac.charGuid >>> 0');
const held = (p: Page) => ev<Held[]>(p, `window.__ac.playerState.inventory.getAll().map((i) => ({ id: i.id >>> 0, wcid: i.weenieClassId, name: i.name,
  containerId: i.containerId >>> 0, stackSize: i.stackSize, itemType: i.itemType ?? 0, itemsCapacity: i.itemsCapacity }))`);
const worn = (p: Page) => ev<Array<{ id: number; slot: number; wcid: number }>>(p,
  'window.__ac.playerState.equipment.getAll().map((e) => ({ id: e.id >>> 0, slot: e.slot, wcid: e.weenieClassId }))');
const sidePacks = (p: Page) => ev<number[]>(p, '(window.__ac.gameUI.sidePackGuids || []).map((g) => g >>> 0)');
/** A ground (non-carried) object of this wcid, newest guid. */
const groundOf = (p: Page, wcid: number) => ev<number>(p, `(() => { let g = 0; const inv = new Set(window.__ac.playerState.inventory.getAll().map((i) => i.id >>> 0));
  for (const [k, o] of window.__ac.serverObjectManager.getAllObjects()) { const id = k >>> 0; if (o.weenieClassId === ${wcid} && !inv.has(id) && !o.wielderId && id > g) g = id; } return g; })()`);
async function waitUntil(p: Page, fn: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  for (let t = 0; t < ms; t += 400) { if (await fn()) return true; await p.waitForTimeout(400); }
  return fn();
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 600)}`); };
  const { a, close } = await openTwoClients('sweepb-panels');
  const A = a.page;
  const sent: string[] = [];
  const useLog: string[] = [];
  A.on('console', (m) => { const t = m.text(); if (/Use (suppressed|refused)|UseObject|placement|PlaceInBackpack|Sent Use|refused|InventoryServerSaysFailure|WeenieError/i.test(t)) useLog.push(t.slice(0, 200)); });
  A.on('console', (m) => { const t = m.text(); if (/\[AC\] Sent (Use|StackableMerge|PutItemInContainer|StackableSplitToContainer|GetAndWieldItem)\b/.test(t)) sent.push(t.slice(0, 220)); });
  const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
  try {
    const player = await me(A);
    // Open the inventory so the grid / paperdoll cells exist.
    await ev(A, '(() => { const ui = window.__ac.gameUI; if (!ui.inventoryVisible) ui.toggleInventory(); })()');

    // A side pack to show.
    let packs = await sidePacks(A);
    if (packs.length < 2) {
      await adminCommand(A, `@ci ${WCID.pack}`);
      await waitUntil(A, async () => (await sidePacks(A)).length >= 2, 10_000);
      packs = await sidePacks(A);
    }
    const packSlot = packs.length - 1;
    const pack = packs[packSlot];
    const showPack = (slot: number) => ev(A, `(() => { const ui = window.__ac.gameUI; ui.selectedPackSlot = ${slot}; ui.renderInventoryPanel(); })()`);
    // Earlier runs leave the shown pack full of Daggers (fullpack): drop them
    // so every placement below has room. (The ground copies decay.)
    const dropPackDaggers = async () => {
      for (const it of (await held(A)).filter((i) => i.containerId === pack && i.wcid === WCID.dagger)) {
        await ev(A, `window.acDebug.dropInventoryItem(${it.id})`);
        await waitUntil(A, async () => !(await held(A)).some((i) => i.id === it.id), 5000);
      }
    };
    await dropPackDaggers();
    console.log(`shown pack holds ${(await held(A)).filter((i) => i.containerId === pack).length} item(s) after the drain`);
    await showPack(packSlot);
    const packName = (await held(A)).find((i) => i.id === pack)?.name ?? 'Pack';
    console.log(`player ${hex(player)} shown pack ${hex(pack)} (slot ${packSlot}, "${packName}")`);

    if (want('charinfo')) {
      await ev(A, '(() => { const ui = window.__ac.gameUI; if (!ui.charInfoTextPanelVisible) ui.toggleCharacterInfoTextPanel(); })()');
      await A.waitForTimeout(800);
      const lines = await ev<string[]>(A, 'window.__ac.gameUI.characterInfoReportLines()');
      const attrs = await ev<{ str: number; end: number; innateStr: number }>(A, `(() => { const a = window.__ac.playerState.attributes;
        return { str: a.getCurrent(1), end: a.getCurrent(2), innateStr: a.getInnate(1) }; })()`);
      const tier = (v: number, cuts: number[]) => ['None', 'Poor', 'Mediocre', 'Hardy', 'Resilient', 'Indomitable'][cuts.findIndex((c) => v <= c) === -1 ? 5 : cuts.findIndex((c) => v <= c)];
      const resist = tier(attrs.str + attrs.end, [200, 260, 320, 380, 440]);
      const regen = tier(attrs.str + 2 * attrs.end, [200, 346, 470, 580, 690]);
      const want1 = `Natural Resistances: ${resist}\nDrain Resistances: ${resist}\nRegeneration Bonus: ${regen}`;
      const iEnd = lines.indexOf(want1);
      const iInnate = lines.findIndex((l) => l.startsWith('Innate Strength'));
      const iDeaths = lines.findIndex((l) => /died|never died/.test(l));
      const innateOk = iInnate >= 0 && lines[iInnate].startsWith(`Innate Strength: ${attrs.innateStr}\n`);
      await shot(A, `${OUT}/charinfo.png`);
      record('charinfo', iEnd >= 0 && iDeaths < iEnd && iEnd < iInnate && innateOk, { attrs, expected: want1, lines: lines.slice(0, 6) });
      await ev(A, '(() => { const ui = window.__ac.gameUI; if (ui.charInfoTextPanelVisible) ui.toggleCharacterInfoTextPanel(); })()');
    }

    if (want('usemsg')) {
      await adminCommand(A, `@ci ${WCID.taper} 5`);
      await adminCommand(A, `@ci ${WCID.healingKit}`);
      await waitUntil(A, async () => { const h = await held(A); return h.some((i) => i.wcid === WCID.taper) && h.some((i) => i.wcid === WCID.healingKit); });
      const h = await held(A);
      const taper = h.find((i) => i.wcid === WCID.taper)!;
      const kit = h.find((i) => i.wcid === WCID.healingKit)!;
      const dbl = async (guid: number, container: number) => {
        await showPack(container === player || container === 0 ? 0 : Math.max(0, packs.indexOf(container)));
        await A.waitForTimeout(300);
        return ev<boolean>(A, `(() => { const c = document.querySelector('[data-ac-sel-guid="${guid}"]'); if (!c) return false;
          c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
      };
      sent.length = 0;
      const t1 = await dbl(taper.id, taper.containerId);
      await A.waitForTimeout(800);
      const s1 = await spew(A);
      const sends1 = sent.slice();
      await A.waitForTimeout(300);
      const t2 = await dbl(kit.id, kit.containerId);
      await A.waitForTimeout(800);
      const s2 = await spew(A);
      await shot(A, `${OUT}/usemsg.png`);
      record('usemsg', t1 && t2 && s1.includes('The Prismatic Taper cannot be used') && !sends1.some((l) => /Sent Use/.test(l))
        && s2.includes('Choose a target for the Handy Healing Kit'), { t1, t2, spew: s2.slice(-4), sends1 });
      await A.keyboard.press('Escape').catch(() => {}); // leave the healing kit's target mode
      await showPack(packSlot);
    }

    if (want('automerge')) {
      if (!(await held(A)).some((i) => i.wcid === WCID.taper)) {
        await adminCommand(A, `@ci ${WCID.taper} 5`);
        await waitUntil(A, async () => (await held(A)).some((i) => i.wcid === WCID.taper));
      }
      const before = (await held(A)).filter((i) => i.wcid === WCID.taper);
      await adminCommand(A, `@create ${WCID.taper}`);
      let ground = 0;
      await waitUntil(A, async () => (ground = await groundOf(A, WCID.taper)) !== 0);
      sent.length = 0;
      await A.waitForTimeout(500);
      await ev(A, `window.acDebug.useObject(${ground})`);
      await A.waitForTimeout(4000);
      const after = (await held(A)).filter((i) => i.wcid === WCID.taper);
      const merged = sent.some((l) => /StackableMerge \(place in backpack\)/.test(l) && l.includes(`from=${hex(ground)}`));
      record('automerge', !!ground && merged && after.length === before.length
        && after.reduce((n, i) => n + i.stackSize, 0) === before.reduce((n, i) => n + i.stackSize, 0) + 1,
      { ground: hex(ground), before: before.map((i) => [hex(i.id), i.stackSize]), after: after.map((i) => [hex(i.id), i.stackSize]), sent: sent.slice() });
    }

    const groundDagger = async (): Promise<number> => {
      await adminCommand(A, `@create ${WCID.dagger}`);
      let g = 0;
      await waitUntil(A, async () => (g = await groundOf(A, WCID.dagger)) !== 0);
      await A.waitForTimeout(500);
      return g;
    };

    if (want('shownpack') || want('unwield') || want('worndrop')) {
      await showPack(packSlot);
      const g = await groundDagger();
      sent.length = 0;
      await ev(A, `window.acDebug.useObject(${g})`);
      await waitUntil(A, async () => (await held(A)).some((i) => i.id === g));
      const inPack = (await held(A)).find((i) => i.id === g)?.containerId === pack;
      record('shownpack', !!g && inPack && sent.some((l) => l.includes(`item=${hex(g)} → ${hex(pack)}`)), { dagger: hex(g), pack: hex(pack), sent: sent.slice(), useLog: useLog.slice(-6) });

      if (want('unwield') || want('worndrop')) {
        const wield = async () => {
          await ev(A, `(() => { const it = window.__ac.playerState.inventory.getItem(${g}); return it ? window.__ac.gameUI.dragCallbacks.onUseObject(${g}) : 0; })()`);
          return waitUntil(A, async () => (await worn(A)).some((e) => e.id === g), 8000);
        };
        if (want('unwield')) {
          const wielded = await wield();
          await A.waitForTimeout(800);
          await showPack(packSlot);
          sent.length = 0;
          const slotOk = await ev<boolean>(A, `(() => { const el = document.querySelector('[data-equip-slot="Weapon"]'); if (!el) return false;
            el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
          await waitUntil(A, async () => (await held(A)).find((i) => i.id === g)?.containerId === pack && !(await worn(A)).some((e) => e.id === g));
          const back = (await held(A)).find((i) => i.id === g);
          await shot(A, `${OUT}/unwield.png`);
          record('unwield', wielded && slotOk && back?.containerId === pack && sent.some((l) => l.includes(`item=${hex(g)} → ${hex(pack)}`)),
            { wielded, slotOk, containerId: back && hex(back.containerId), sent: sent.slice() });
        }
        if (want('worndrop')) {
          const wielded = await wield();
          await A.waitForTimeout(800);
          const slot = (await worn(A)).find((e) => e.id === g)?.slot ?? 0;
          sent.length = 0;
          await ev(A, `window.__ac.gameUI.dragCallbacks.onItemListDrop({ kind: 'equipped', slot: ${slot} }, { list: 'items', packSlot: ${packSlot}, cellItemId: 0 })`);
          await waitUntil(A, async () => (await held(A)).find((i) => i.id === g)?.containerId === pack && !(await worn(A)).some((e) => e.id === g));
          const back = (await held(A)).find((i) => i.id === g);
          record('worndrop', wielded && back?.containerId === pack && sent.some((l) => l.includes(`item=${hex(g)} → ${hex(pack)}`)),
            { wielded, slot, containerId: back && hex(back.containerId), sent: sent.slice() });
        }
      }
    }

    if (want('chest')) {
      // The chest @create makes now (an older probe chest may still stand by).
      const chestsBefore = await ev<number[]>(A, `[...window.__ac.serverObjectManager.getAllObjects()].filter(([, o]) => o.weenieClassId === ${WCID.chest}).map(([k]) => k >>> 0)`);
      await adminCommand(A, `@create ${WCID.chest}`);
      const newChest = () => ev<number>(A, `(() => { const old = new Set(${JSON.stringify(chestsBefore)}); for (const [k, o] of window.__ac.serverObjectManager.getAllObjects()) if (o.weenieClassId === ${WCID.chest} && !old.has(k >>> 0)) return k >>> 0; return 0; })()`);
      await waitUntil(A, async () => (await newChest()) !== 0, 12_000);
      const chest = await newChest();
      await ev(A, `window.acDebug.useObject(${chest})`);
      const opened = await waitUntil(A, async () => (await ev<number>(A, 'window.__ac.gameUI.openContainerGuid >>> 0')) === chest, 15_000);
      // Store a carried Dagger in the chest, then take it back by its double-click.
      let d = (await held(A)).find((i) => i.wcid === WCID.dagger)?.id ?? 0;
      if (!d) { await adminCommand(A, `@ci ${WCID.dagger}`); await waitUntil(A, async () => (d = (await held(A)).find((i) => i.wcid === WCID.dagger)?.id ?? 0) !== 0); }
      await ev(A, `window.__ac.gameUI.containerCallbacks.onStoreItem(${d})`);
      const stored = await waitUntil(A, async () => !(await held(A)).some((i) => i.id === d), 8000);
      await A.waitForTimeout(800);
      await showPack(packSlot);
      sent.length = 0; useLog.length = 0;
      await ev(A, `window.__ac.gameUI.containerCallbacks.onTakeItem(${d})`);
      await waitUntil(A, async () => (await held(A)).some((i) => i.id === d), 10_000);
      const got = (await held(A)).find((i) => i.id === d);
      await shot(A, `${OUT}/chest.png`);
      record('chest', !!chest && opened && stored && got?.containerId === pack && sent.some((l) => l.includes(`item=${hex(d)} → ${hex(pack)}`)),
        { chest: hex(chest), opened, stored, item: hex(d), containerId: got && hex(got.containerId), sent: sent.slice(), useLog: useLog.slice(0, 8) });
      await ev(A, 'window.__ac.gameUI.closeContainerPanelFromUi && window.__ac.gameUI.closeContainerPanelFromUi()');
      await A.waitForTimeout(2000);
    }

    if (want('fullpack')) {
      // Fill the shown pack with Daggers (made in the main pack, moved in).
      const cap = (await held(A)).find((i) => i.id === pack)?.itemsCapacity ?? 24;
      const count = async () => (await held(A)).filter((i) => i.containerId === pack && (i.itemType & 0x200) === 0).length;
      for (let n = await count(); n < cap; n = await count()) {
        const mainDagger = (await held(A)).find((i) => i.wcid === WCID.dagger && i.containerId === player);
        if (!mainDagger) { await adminCommand(A, `@ci ${WCID.dagger}`); await A.waitForTimeout(1200); continue; }
        await ev(A, `window.acDebug.putInPack(${mainDagger.id}, ${pack})`);
        await waitUntil(A, async () => (await count()) > n, 5000);
      }
      await showPack(packSlot);
      const g = await groundDagger();
      sent.length = 0;
      await ev(A, `window.acDebug.useObject(${g})`);
      await waitUntil(A, async () => (await held(A)).some((i) => i.id === g), 10_000);
      const landed = (await held(A)).find((i) => i.id === g)?.containerId;
      const fallbackOk = landed === player && sent.some((l) => l.includes(`item=${hex(g)} → ${hex(player)}`));
      // A world object dropped on the full pack's column slot is refused out loud.
      const g2 = await groundDagger();
      sent.length = 0;
      await ev(A, `window.__ac.gameUI.dragCallbacks.onItemListDrop({ kind: 'world', guid: ${g2} }, { list: 'packs', packSlot: ${packSlot} })`);
      await A.waitForTimeout(1500);
      const s = await spew(A);
      const refusal = `The ${packName} is completely full!`;
      await shot(A, `${OUT}/fullpack.png`);
      record('fullpack', fallbackOk && s.includes(refusal) && sent.length === 0,
        { cap, landed: landed && hex(landed), refusal, spew: s.slice(-3), sentAfterDrop: sent.slice() });
      await dropPackDaggers();
    }
  } finally {
    // Probe hygiene: remove what this probe spawned (it would show up in other sessions' captures).
    await deleteSpawnsNear(A, [WCID.chest, WCID.dagger, WCID.taper, WCID.healingKit]).catch(() => 0);
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    await close();
  }
  console.log(fails.length ? `FAILED: ${fails.join(', ')}` : 'ALL PASS');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
