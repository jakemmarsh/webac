/**
 * probe-sweepb-magic — live checks for the SWEEP1006B magic-casting fixes,
 * one client (fxprobe1 / Fxprobe, admin) in Holtburg against ACE:
 *  untargeted     Acid Wave (3946; NonComponentTargetType 0x10, formula
 *                 untargeted) with nothing selected goes out as
 *                 CastUntargetedSpell (CSpellBase::InqTargetType @ 00597230)
 *  needstarget    Frost Blast III (107; NCT 0, formula Creature) with nothing
 *                 selected is refused locally: "You must select a suitable
 *                 target before casting this spell", nothing sent
 *  self           Flame Bolt I (27) with yourself selected: "You cannot cast
 *                 this spell upon yourself", nothing sent
 *                 (ObjectCompatibleWithSpellTargetType @ 00567230)
 *  incompatible   Flame Bolt I at a chest: "This spell cannot be cast on
 *                 <name>", nothing sent
 *  stack          Blade Bane I (37) at a pyreal stack: "Cannot cast spell on
 *                 a stack of items.", nothing sent
 *  casting        Flame Bolt I at a drudge: "Casting Flame Bolt I" on the
 *                 spew and a CastTargetedSpell at the drudge
 *  comps          PlayerDescription without bool 68 → spellComponentsRequired
 *                 false: the "casting" cast went out with no components held
 *                 (AreSpellComponentsRequired @ 00567b90); reports ACE's reply
 *  forget         Strength Self I (2) on tabs 1 and 3, then the spellbook's
 *                 Delete → Yes:
 *                 gone from both tabs, one RemoveSpellFavorite per tab
 *                 (RecvNotice_SpellRemoved @ 004c6a00)
 *  delete         the spellbook Delete prompt is retail's .rdata 0x7a3ea8 text
 *                 (gmSpellbookUI::DeleteSpell @ 0048bd50); No sends nothing
 *  bookselect     select Flame Bolt I, toggle the War filter off and on: no
 *                 row highlighted, Delete still names Flame Bolt I
 *  learn          @addspell Blade Bane I with the spellbook open selects and
 *                 highlights it (RecvNotice_SpellAdded @ 0048b8d0)
 * Writes verification/sweepb-magic/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-sweepb-magic.ts [--only a,b]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, enterWorld, gameUrl, shot, deleteSpawnsNear } from './lib/game-session.ts';
import { MEET_LOC, waitDialog, answerDialog, dialogText } from './lib/two-client.ts';

const OUT = 'verification/sweepb-magic';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (k: string) => !ONLY || ONLY.has(k);

const STRENGTH_SELF_I = 2;
const FLAME_BOLT_I = 27;
const BLADE_BANE_I = 37;
const FROST_BLAST_III = 107;
const ACID_WAVE = 3946;
const CHEST_WCID = 143;
const PYREAL_WCID = 273;
const DRUDGE_WCID = 19257;
const DELETE_TEXT = (name: string) => `Are you sure you want to remove ${name} from your spellbook? You will no longer be able to cast this spell unless you learn it again!`;

const ev = <T>(p: Page, js: string): Promise<T> => p.evaluate(js) as Promise<T>;
/** Mark the spew lines on screen now; newSpew returns the ones added since (lines expire, so no counting). */
const markSpew = (p: Page) => ev(p, 'window.__ac.gameUI.spewBox.items.forEach((i) => { i.__probeSeen = true; })');
const newSpew = (p: Page) => ev<string[]>(p, 'window.__ac.gameUI.spewBox.items.filter((i) => !i.__probeSeen).map((i) => i.text)');
const click = async (p: Page, id: number) => p.locator(`[data-element-id="0x${id.toString(16)}"]`).first().click({ force: true });

/** Cast `spellId` through the real onCastSpell (the spell bar's Cast). */
const cast = (p: Page, spellId: number) => ev<boolean>(p, `(() => { const ui = window.__ac.gameUI;
  const i = ui.knownSpells.findIndex((s) => s.id === ${spellId}); if (i < 0) return false;
  ui.spellCallbacks.onCastSpell(i); return true; })()`);
/** Drop the world selection (currentTargetGuid via the inventory-selection hook) and the toolbar target. */
const deselect = (p: Page) => ev(p, `(() => { const ui = window.__ac.gameUI; ui.onInventorySelectionToToolbar && ui.onInventorySelectionToToolbar(); ui.hudState.target = null; })()`);
const select = (p: Page, guid: number) => ev(p, `window.__ac.gameUI.onSelectObject(${guid})`);
/**
 * Forget a spell the way the spellbook's Delete → Yes does (RemoveSpellC2S;
 * ACE answers Magic_RemoveSpell). @removespell edits the biota only and
 * never tells the client, which would leave our spellbook stale.
 */
const forget = async (p: Page, id: number) => { await ev(p, `window.__ac.gameUI.callbacks.onRemoveSpellFromSpellbook(${id})`); await p.waitForTimeout(1500); };
const knows = (p: Page, id: number) => ev<boolean>(p, `window.__ac.gameUI.knownSpells.some((s) => s.id === ${id})`);

/** Spawn a weenie with @create and return the new object's guid. */
async function spawn(p: Page, wcid: number, extra = ''): Promise<number> {
  const before = await ev<number[]>(p, '[...window.__ac.serverObjectManager.objects.keys()]');
  await adminCommand(p, `@create ${wcid}${extra}`);
  await p.waitForTimeout(3500);
  return ev<number>(p, `(() => { const b = new Set(${JSON.stringify(before)});
    const o = [...window.__ac.serverObjectManager.objects.values()].filter((o) => o.weenieClassId === ${wcid} && !b.has(o.guid)).pop();
    return o ? o.guid : 0; })()`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 500)}`); };

  const account = process.env.AC_CLIENT_A ?? 'fxprobe1';
  const s = await enterWorld({
    createCharacter: process.env.AC_CLIENT_A_CHAR ?? 'Fxprobe',
    url: gameUrl({ cb: 'sweepb-magic', env: { ...process.env, AC_ACCOUNT: account, AC_PASSWORD: account } }),
  } as never);
  const A = s.page;
  const logs: string[] = [];
  A.on('console', (m) => { const t = m.text(); if (/CastTargetedSpell|CastUntargetedSpell|Cast suppressed/.test(t)) logs.push(t.slice(0, 200)); });
  const magicLines: string[] = [];
  A.on('console', (m) => { const t = m.text(); if (/\[Magic\]|RemoveSpell|UpdateSpell|0x01A8|0x02C1/.test(t)) magicLines.push(t.slice(0, 160)); });
  const sentSince = (n: number) => logs.slice(n).filter((t) => /CastTargetedSpell|CastUntargetedSpell/.test(t));
  /** Cast and collect what went out + the new spew lines. */
  const castAndRead = async (spellId: number): Promise<{ sent: string[]; spew: string[] }> => {
    const n = logs.length;
    await markSpew(A);
    await cast(A, spellId);
    await A.waitForTimeout(1500);
    return { sent: sentSince(n), spew: await newSpew(A) };
  };

  try {
    await A.waitForTimeout(3000);
    await adminCommand(A, `@teleloc ${MEET_LOC}`);
    await A.waitForTimeout(8000);
    // A PlayerDescription without bool 68 (read before any @requirecomps).
    const compsRequired = await ev<boolean>(A, 'window.__ac.playerState.spellComponentsRequired');
    for (const id of [STRENGTH_SELF_I, FLAME_BOLT_I, FROST_BLAST_III, ACID_WAVE]) {
      if (!(await knows(A, id))) { await adminCommand(A, `@addspell ${id}`); await A.waitForTimeout(800); }
    }
    if (await knows(A, BLADE_BANE_I)) await forget(A, BLADE_BANE_I);
    await A.waitForTimeout(1500);

    if (want('untargeted')) {
      await deselect(A);
      const r = await castAndRead(ACID_WAVE);
      record('untargeted', r.sent.some((t) => /CastUntargetedSpell: spellId=3946/.test(t)), r);
      await A.waitForTimeout(4000);
    }

    if (want('needstarget')) {
      await deselect(A);
      const r = await castAndRead(FROST_BLAST_III);
      record('needstarget', r.sent.length === 0 && r.spew.includes('You must select a suitable target before casting this spell'), r);
    }

    if (want('self')) {
      await select(A, await ev<number>(A, 'window.__ac.charGuid'));
      const state = await ev(A, '({ mode: window.__ac.combatController.mode, target: window.__ac.gameUI.hudState.target?.id ?? 0 })');
      const r = await castAndRead(FLAME_BOLT_I);
      record('self', r.sent.length === 0 && r.spew.includes('You cannot cast this spell upon yourself'), { ...r, state });
      await deselect(A);
    }

    if (want('incompatible')) {
      const chest = await spawn(A, CHEST_WCID);
      await select(A, chest);
      const name = await ev<string>(A, `window.__ac.serverObjectManager.getObject(${chest})?.name ?? ''`);
      const r = await castAndRead(FLAME_BOLT_I);
      record('incompatible', !!chest && r.sent.length === 0 && r.spew.includes(`This spell cannot be cast on ${name}`), { chest, name, ...r });
      await deselect(A);
    }

    if (want('stack')) {
      await adminCommand(A, `@addspell ${BLADE_BANE_I}`);
      await A.waitForTimeout(1500);
      const pile = await spawn(A, PYREAL_WCID, ' 25');
      const stackSize = await ev<number>(A, `window.__ac.serverObjectManager.getObject(${pile})?.stackSize ?? 0`);
      await select(A, pile);
      const r = await castAndRead(BLADE_BANE_I);
      record('stack', !!pile && stackSize >= 2 && r.sent.length === 0 && r.spew.includes('Cannot cast spell on a stack of items.'), { pile, stackSize, ...r });
      await deselect(A);
      await forget(A, BLADE_BANE_I);
    }

    if (want('casting') || want('comps')) {
      const drudge = await spawn(A, DRUDGE_WCID);
      await select(A, drudge);
      const r = await castAndRead(FLAME_BOLT_I);
      await A.waitForTimeout(2500);
      const later = (await ev<string[]>(A, 'window.__ac.gameUI.spewBox.items.map((i) => i.text)')).slice(-6);
      const sentAtDrudge = r.sent.some((t) => new RegExp(`CastTargetedSpell: .*spellId=${FLAME_BOLT_I} target=0x${drudge.toString(16)}`).test(t));
      if (want('casting')) record('casting', !!drudge && r.spew.includes('Casting Flame Bolt I') && sentAtDrudge, { drudge, ...r });
      if (want('comps')) {
        const ownsScarab = await ev<boolean>(A, `window.__ac.playerState.inventory.getAll().some((i) => /scarab/i.test(i.name))`);
        record('comps', compsRequired === false && sentAtDrudge && !r.spew.includes("You do not have all of this spell's components"),
          { compsRequired, ownsScarab, sentAtDrudge, aceReply: later });
      }
      await deselect(A);
    }

    const openBook = async () => {
      await ev(A, `(() => { const ui = window.__ac.gameUI; ui.magicPanelTab = 'spells'; if (!ui.magicVisible) ui.toggleMagicPanel(); else ui.renderMagicPanel(); ui.setSpellbookFilters(0x3fff); })()`);
      await A.waitForTimeout(1500);
    };
    const highlighted = () => ev<number[]>(A, `[...window.__ac.gameUI.magicPanel.querySelectorAll('[data-spell-id]')]
      .filter((r) => { const o = r.querySelector('[data-element-id="0x10000342"]'); return o && o.style.display !== 'none'; })
      .map((r) => Number(r.dataset.spellId))`);

    if (want('forget')) {
      const calls = await ev<number>(A, `(() => { const ui = window.__ac.gameUI; window.__sweepbRemoved = [];
        const cb = ui.spellCallbacks.onRemoveSpellFavorite;
        ui.spellCallbacks.onRemoveSpellFavorite = (id, bar) => { window.__sweepbRemoved.push([id, bar]); cb && cb(id, bar); };
        const idx = ui.knownSpells.findIndex((s) => s.id === ${STRENGTH_SELF_I});
        for (const tab of [1, 3]) { ui.activeSpellBarTab = tab; ui.assignSpellToBar(idx, 0); }
        ui.activeSpellBarTab = 0;
        window.__sweepbRemoved = []; // placing an already-barred spell moves it (a remove + add)
        return [1, 3].filter((t) => ui.spellBarSlots[t].some((s) => s && s.id === ${STRENGTH_SELF_I})).length; })()`);
      await A.waitForTimeout(1000);
      // The spellbook's Delete → Yes (RemoveSpellC2S): ACE answers with
      // Magic_RemoveSpell (Player_Spells HandleActionMagicRemoveSpell);
      // @removespell edits the biota only and tells the client nothing.
      await openBook();
      await A.locator(`[data-spell-id="${STRENGTH_SELF_I}"]`).first().click({ force: true });
      await A.waitForTimeout(400);
      await click(A, 0x100002a5);
      await waitDialog(A, 5000);
      await answerDialog(A, true);
      await A.waitForTimeout(3000);
      const after = await ev<{ onTabs: number[]; removed: number[][] }>(A, `(() => { const ui = window.__ac.gameUI;
        return { onTabs: ui.spellBarSlots.map((t, i) => t.some((s) => s && s.id === ${STRENGTH_SELF_I}) ? i : -1).filter((i) => i >= 0),
          removed: window.__sweepbRemoved }; })()`);
      const removedTabs = after.removed.filter(([id]) => id === STRENGTH_SELF_I).map(([, t]) => t).sort();
      record('forget', calls === 2 && after.onTabs.length === 0 && JSON.stringify(removedTabs) === '[1,3]', { placedOn: calls, ...after, magic: magicLines.slice(-6) });
      await adminCommand(A, `@addspell ${STRENGTH_SELF_I}`);
      await A.waitForTimeout(1500);
    }

    if (want('delete')) {
      await openBook();
      await A.locator(`[data-spell-id="${FLAME_BOLT_I}"]`).first().click({ force: true });
      await A.waitForTimeout(400);
      const n = logs.length;
      await click(A, 0x100002a5);
      const text = await waitDialog(A, 5000);
      await shot(A, `${OUT}/delete-confirm.png`);
      await answerDialog(A, false);
      await A.waitForTimeout(1000);
      record('delete', text === DELETE_TEXT('Flame Bolt I') && (await knows(A, FLAME_BOLT_I)) && (await dialogText(A)) === null, { text, stillKnown: await knows(A, FLAME_BOLT_I), sends: sentSince(n) });
    }

    if (want('bookselect')) {
      await openBook();
      await A.locator(`[data-spell-id="${FLAME_BOLT_I}"]`).first().click({ force: true });
      await A.waitForTimeout(400);
      const hiBefore = await highlighted();
      await click(A, 0x1000029b); // War off
      await A.waitForTimeout(600);
      await click(A, 0x1000029b); // War on
      await A.waitForTimeout(600);
      const hiAfter = await highlighted();
      const selection = await ev<number>(A, 'window.__ac.gameUI.spellbookSelection');
      await click(A, 0x100002a5);
      const text = await waitDialog(A, 5000);
      await answerDialog(A, false);
      record('bookselect', JSON.stringify(hiBefore) === `[${FLAME_BOLT_I}]` && hiAfter.length === 0 && selection === FLAME_BOLT_I && text === DELETE_TEXT('Flame Bolt I'),
        { hiBefore, hiAfter, selection, text });
    }

    if (want('learn')) {
      await openBook();
      if (await knows(A, BLADE_BANE_I)) await forget(A, BLADE_BANE_I);
      await adminCommand(A, `@addspell ${BLADE_BANE_I}`);
      await A.waitForTimeout(2500);
      const selection = await ev<number>(A, 'window.__ac.gameUI.spellbookSelection');
      const hi = await highlighted();
      await shot(A, `${OUT}/learn-selects.png`);
      record('learn', selection === BLADE_BANE_I && JSON.stringify(hi) === `[${BLADE_BANE_I}]`, { selection, highlighted: hi, magic: magicLines.slice(-6) });
      await forget(A, BLADE_BANE_I);
    }
  } finally {
    // Probe hygiene: remove what this probe spawned (it would show up in other sessions' captures).
    await deleteSpawnsNear(A, [CHEST_WCID, PYREAL_WCID, DRUDGE_WCID]).catch(() => 0);
    results.castLog = logs;
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    await s.browser.close().catch(() => {});
  }
  if (fails.length) { console.log(`FAILED: ${fails.join(', ')}`); process.exit(1); }
  console.log('ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
