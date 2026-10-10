/**
 * probe-held-item-state — BUG.held-item-own-state, live. A held item is its
 * own CPhysicsObj in retail; ours draws a copy in the hand, which must carry
 * the item's own state:
 *   scale    — A spawns a 1.4x Tumerok Aun Tah Huirea (wcid 27280, wields a
 *              weapon): the weapon in its hand is at the WEAPON's scale, not
 *              1.4x it (CPhysicsObj::UpdateChild @ 00512d50).
 *   glow     — B wields a Shamshir of Flame (3855): its Setup DefaultScript's
 *              emitters run on the copy in B's hand, visible; the item's own
 *              hidden world mesh shows none.
 *   translucent — B wields a Crystal Caul orb (8022, Translucency 0.5): the
 *              copy in B's hand draws at opacity 0.5.
 * Writes verification/held-item-state/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-held-item-state.ts   (env: tools/lib/two-client.ts)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, shot } from './lib/game-session.ts';
import { openTwoClients } from './lib/two-client.ts';

const OUT = 'verification/held-item-state';
const TUMEROK = 27280;
const SHAMSHIR_FIRE = 3855;
const CRYSTAL_CAUL = 8022;

/** The copies held under `holderGuid`'s mesh, with what the checks read. */
const heldOn = (page: Page, holderGuid: number) => page.evaluate(`(() => {
  const ac = window.__ac; const som = ac.serverObjectManager; const psp = ac.physicsScriptPlayer;
  const h = som.getObject(${holderGuid}); if (!h || !h.mesh) return null;
  h.mesh.updateMatrixWorld(true);
  const out = [];
  h.mesh.traverse((o) => {
    if (!o.name || !o.name.startsWith('wielded_') || !o.userData || !o.userData.wieldedGuid) return;
    const item = som.getObject(o.userData.wieldedGuid);
    const ws = o.getWorldScale(new o.scale.constructor());
    const systems = [...(psp.objectSystems.get(o) || []), ...((psp.emittersById.get(o) || new Map()).values())];
    const ownSystems = item && item.mesh ? [...(psp.objectSystems.get(item.mesh) || []), ...((psp.emittersById.get(item.mesh) || new Map()).values())] : [];
    let minOpacity = 1; o.traverse((m) => { if (m.isMesh) for (const mat of [].concat(m.material)) minOpacity = Math.min(minOpacity, mat.opacity); });
    out.push({
      item: o.userData.wieldedGuid, name: item ? item.name : null, wcid: item ? item.weenieClassId : null,
      worldScale: +ws.x.toFixed(3), itemScale: item && item.physics ? item.physics.scale : 1, holderScale: +h.mesh.scale.x.toFixed(3),
      emitters: systems.length, emittersVisible: systems.filter((s) => s.object3D.visible).length,
      ownMeshEmittersVisible: ownSystems.filter((s) => s.object3D.visible).length, minOpacity: +minOpacity.toFixed(3),
    });
  });
  return out;
})()`) as Promise<Array<{ item: number; name: string | null; wcid: number | null; worldScale: number; itemScale: number; holderScale: number; emitters: number; emittersVisible: number; ownMeshEmittersVisible: number; minOpacity: number }> | null>;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { a, b, close } = await openTwoClients('held-item-state');
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const wieldOnB = async (wcid: number): Promise<number> => {
    await adminCommand(b.page, `@ci ${wcid}`);
    await b.page.waitForTimeout(3000);
    const id = await b.page.evaluate(`(() => { const ui = window.__ac.gameUI; const on = new Set((ui.equippedItems || []).map((e) => e.id));
      const i = (ui.inventoryItems || []).findIndex((it) => it.weenieClassId === ${wcid} && !on.has(it.id)); if (i < 0) return 0;
      const id = ui.inventoryItems[i].id; ui.dragCallbacks.onDoubleClickItem(i); return id; })()`) as number;
    await b.page.waitForTimeout(5000);
    return id;
  };
  try {
    // 1. scale — a 1.4x creature's weapon at the weapon's own scale.
    await adminCommand(a.page, `@create ${TUMEROK}`);
    await a.page.waitForTimeout(6000);
    const tumerok = await a.page.evaluate(`(() => { for (const o of window.__ac.serverObjectManager.objects.values()) if (o.weenieClassId === ${TUMEROK}) return o.guid; return 0; })()`) as number;
    const tHeld = tumerok ? await heldOn(a.page, tumerok) : null;
    results.scale = { tumerok, held: tHeld };
    await shot(a.page, `${OUT}/1-tumerok-a.png`);
    const scaleOk = !!tHeld && tHeld.length > 0 && tHeld.every((h) => Math.abs(h.worldScale - h.itemScale) < 0.01) && tHeld[0].holderScale > 1.3;
    if (!scaleOk) fails.push('scale');
    console.log(`${scaleOk ? 'PASS' : 'FAIL'} scale: ${JSON.stringify(results.scale)}`);
    await adminCommand(a.page, '@smite all');
    await a.page.waitForTimeout(2000);

    // 2. glow — the elemental weapon's DefaultScript runs on the copy in B's hand.
    // B stands 3 m in front of A (north, the way A's camera looks) so the screenshots show it.
    await adminCommand(b.page, '@teleloc 0xA9B40019 [85.0 24.5 94.0] 1 0 0 0');
    for (let i = 0; i < 60 && !(await b.page.evaluate('window.acDebug.collisionState().loginComplete')); i++) await b.page.waitForTimeout(250);
    await b.page.waitForTimeout(3000);
    for (const slot of ['MeleeWeapon', 'Held', 'TwoHanded', 'MissileWeapon']) await b.page.evaluate(`window.acDebug.unwield(${JSON.stringify(slot)})`);
    await b.page.waitForTimeout(3000);
    const shamshir = await wieldOnB(SHAMSHIR_FIRE);
    const sHeld = (await heldOn(a.page, b.guid))?.find((h) => h.item === shamshir) ?? null;
    results.glow = { shamshir, held: sHeld };
    await shot(a.page, `${OUT}/2-shamshir-a.png`);
    const glowOk = !!sHeld && sHeld.emittersVisible > 0 && sHeld.ownMeshEmittersVisible === 0;
    if (!glowOk) fails.push('glow');
    console.log(`${glowOk ? 'PASS' : 'FAIL'} glow: ${JSON.stringify(results.glow)}`);

    // 3. translucent — the Crystal Caul orb at its own 0.5.
    await b.page.evaluate(`window.acDebug.unwield('MeleeWeapon')`);
    await b.page.waitForTimeout(3000);
    const orb = await wieldOnB(CRYSTAL_CAUL);
    const oHeld = (await heldOn(a.page, b.guid))?.find((h) => h.item === orb) ?? null;
    results.translucent = { orb, held: oHeld };
    await shot(a.page, `${OUT}/3-orb-a.png`);
    const orbOk = !!oHeld && Math.abs(oHeld.minOpacity - 0.5) < 0.05;
    if (!orbOk) fails.push('translucent');
    console.log(`${orbOk ? 'PASS' : 'FAIL'} translucent: ${JSON.stringify(results.translucent)}`);
    await b.page.evaluate(`window.acDebug.unwield('Held')`);
  } finally {
    results.fails = fails;
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2) + '\n');
    await close();
  }
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
