/**
 * probe-object-lifecycle-orders — the object-lifecycle orderings an observer
 * sees (follow-up sweep to BUG.wielded-item-left-behind-on-teleport).
 *
 * Two clients: B walks a Focusing Stone (wcid 8904) through every holder
 * change while A watches, and A is checked after each step for what draws
 * the stone — its own world mesh (live = in the scene with every ancestor
 * visible) and `wielded_*` held copies:
 *   wield     → held copy only
 *   unwield   → nothing (in B's pack)
 *   drop      → world mesh only, at B's feet   (a Longbow: the stone is attuned)
 *   pickup    → nothing
 *   rewield   → held copy only
 *   teleport  → nothing (B portaled away)
 *   return    → held copy only (B portals back holding it)
 *   logout    → nothing
 * Writes verification/object-lifecycle-orders/{results.json,<step>-a.png};
 * exits 1 when any step draws something it should not (or misses the stone).
 *
 * Usage: npx tsx tools/probe-object-lifecycle-orders.ts   (env: tools/lib/two-client.ts)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, shot } from './lib/game-session.ts';
import { MEET_LOC, openTwoClients } from './lib/two-client.ts';

const OUT = 'verification/object-lifecycle-orders';
const FOCUSING_STONE = 8904;
/** The stone is attuned (PropertyInt 114) — ACE refuses to drop it — so the drop/pickup legs use a Longbow. */
const LONGBOW = 306;
const AWAY_LOC = '0x7D64000D [36.0 101.0 0.005] 1 0 0 0';

interface Seen { known: boolean; worldLive: boolean; heldLive: number; worldAt?: number[]; wielderId?: number; outOfWorld?: boolean }

/** What A draws for `stone`. */
const seen = (page: Page, stone: number) => page.evaluate(`(() => {
  const ac = window.__ac; const scene = ac.sceneManager.scene; const so = ac.serverObjectManager.getObject(${stone});
  const live = (o) => { for (let p = o; p; p = p.parent) { if (p === scene) return true; if (!p.visible) return false; } return false; };
  let heldLive = 0; scene.traverse((o) => { if (o.name && o.name.startsWith('wielded_') && o.userData && o.userData.wieldedGuid === ${stone} && live(o)) heldLive++; });
  const at = so && so.mesh ? so.mesh.getWorldPosition(new so.mesh.position.constructor()) : null;
  return { known: !!so, worldLive: !!(so && so.mesh && live(so.mesh)), heldLive, worldAt: at ? [Math.round(at.x), Math.round(at.z)] : undefined,
    wielderId: so ? so.wielderId : undefined, outOfWorld: so ? !!so.outOfWorld : undefined };
})()`) as Promise<Seen>;

type Want = 'held' | 'world' | 'none';
const matches = (s: Seen, want: Want): boolean =>
  want === 'held' ? (!s.worldLive && s.heldLive === 1)
    : want === 'world' ? (s.worldLive && s.heldLive === 0)
      : (!s.worldLive && s.heldLive === 0);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { a, b, close } = await openTwoClients('lifecycle-orders');
  const steps: Array<{ step: string; want: Want; seen: Seen; ok: boolean }> = [];
  let stone = 0;
  const bSide: Record<string, unknown> = {};
  const check = async (step: string, want: Want, settleMs = 4000): Promise<void> => {
    await a.page.waitForTimeout(settleMs);
    const s = await seen(a.page, stone);
    const ok = matches(s, want);
    steps.push({ step, want, seen: s, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: want ${want}, saw ${JSON.stringify(s)}`);
    await shot(a.page, `${OUT}/${step}-a.png`);
  };
  const aLog: string[] = [];
  a.page.on('console', (m) => { const t = m.text(); if (/\[Wield\]|\[ParentEvent\]|PickupEvent|Delete|0x5000/i.test(t)) aLog.push(`${Date.now()} ${t}`.slice(0, 300)); });
  const bDbg = (js: string) => b.page.evaluate(`(() => { const dbg = window.acDebug; return ${js}; })()`);
  try {
    // Start from an empty Held slot.
    await bDbg(`dbg.unwield('Held')`);
    await b.page.waitForTimeout(2500);
    await adminCommand(b.page, `@ci ${FOCUSING_STONE}`);
    await b.page.waitForTimeout(3000);
    stone = await b.page.evaluate(`(() => { const ui = window.__ac.gameUI; const on = new Set((ui.equippedItems || []).map((e) => e.id));
      const it = (ui.inventoryItems || []).find((i) => i.weenieClassId === ${FOCUSING_STONE} && !on.has(i.id)); return it ? it.id : 0; })()`) as number;
    if (!stone) throw new Error('B has no unequipped Focusing Stone after @ci');
    const wield = () => b.page.evaluate(`(() => { const ui = window.__ac.gameUI; const i = ui.inventoryItems.findIndex((it) => it.id === ${stone}); if (i >= 0) ui.dragCallbacks.onDoubleClickItem(i); return i; })()`);

    await wield();
    await check('wield', 'held');
    await bDbg(`dbg.unwield('Held')`);
    await check('unwield', 'none');
    await adminCommand(b.page, `@ci ${LONGBOW}`);
    await b.page.waitForTimeout(3000);
    const bow = await b.page.evaluate(`(() => { const it = (window.__ac.gameUI.inventoryItems || []).find((i) => i.weenieClassId === ${LONGBOW}); return it ? it.id : 0; })()`) as number;
    const stoneId = stone;
    stone = bow;
    const dropSent = await bDbg(`dbg.dropInventoryItem(${bow})`);
    await check('drop', 'world');
    bSide.chatAfterDrop = (await b.page.evaluate(`[...document.getElementById('chat-messages').children].slice(-4).map((e) => e.textContent)`));
    bSide.drop = { dropSent, onB: await seen(b.page, stone), bInPack: await b.page.evaluate(`!!window.__ac.playerState.inventory.getItem(${stone})`) };
    await bDbg(`dbg.putInPack(${bow}, window.__ac.charGuid)`);
    await check('pickup', 'none', 6000);
    stone = stoneId;
    await wield();
    await check('rewield', 'held');
    await adminCommand(b.page, `@teleloc ${AWAY_LOC}`);
    await check('teleport', 'none', 15_000);
    await adminCommand(b.page, `@teleloc ${MEET_LOC}`);
    for (let i = 0; i < 60 && !(await b.page.evaluate('window.acDebug.collisionState().loginComplete')); i++) await b.page.waitForTimeout(250);
    await check('return', 'held', 6000);
    await b.page.evaluate('window.__ac.gameUI.callbacks.onLogout()');
    await check('logout', 'none', 15_000);
  } finally {
    const failed = steps.filter((s) => !s.ok).map((s) => s.step);
    writeFileSync(`${OUT}/results.json`, JSON.stringify({ at: new Date().toISOString(), stone: `0x${stone.toString(16)}`, failed, bSide, steps, aLog }, null, 2) + '\n');
    await close();
    if (failed.length || steps.length < 8) { console.log(`FAILED: ${failed.join(', ') || 'incomplete run'}`); process.exitCode = 1; }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
