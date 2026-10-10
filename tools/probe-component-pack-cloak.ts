/**
 * probe-component-pack-cloak — live checks for two retail details ported
 * from the decomp, two clients (A fxprobe1 / B fxprobe2):
 *  pack    A spawns a focus (packwaressence 15271, RequiresPackSlot; ACE won't
 *          let one be dropped) on the ground and uses it: it goes back into the pack and no Use is sent
 *          (ItemHolder::DetermineUseResult @ 00588460 → IsComponentPack @ 00588400).
 *  cloak   On B, fade script 0x33000790 (Transparent 0→1 over 1 s) hides A's
 *          parts; after A's `@cloak on` the same script leaves them drawn
 *          (CPhysicsPart::SetTranslucency @ 0050e670 skips a Cloaked object).
 *          A's own model carries the Cloaked state too.
 * Writes verification/component-pack-cloak/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-component-pack-cloak.ts [--only pack,cloak]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, shot } from './lib/game-session.ts';
import { openTwoClients } from './lib/two-client.ts';

const OUT = 'verification/component-pack-cloak';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (k: string) => !ONLY || ONLY.has(k);
const FOCUS = 15271;
const FADE_OUT = 0x33000790;
const FADE_IN = 0x33000719;

/** A's object on B: [found, parts not drawn, Cloaked bit on its root]. */
const remoteParts = (p: Page, guid: number) => p.evaluate(`(() => {
  const o = window.__ac.serverObjectManager.getObject(${guid}); if (!o || !o.mesh) return { found: false, undrawn: 0, meshes: 0, cloaked: false };
  let undrawn = 0, meshes = 0; o.mesh.traverse((m) => { if (m.isMesh) { meshes++; if (m.userData.acPartUndrawn) undrawn++; } });
  return { found: true, undrawn, meshes, cloaked: ((o.mesh.userData.acPhysicsState ?? 0) & 0x100000) !== 0, state: o.physicsState };
})()`) as Promise<{ found: boolean; undrawn: number; meshes: number; cloaked: boolean; state?: number }>;

/** A's own player model (the scene object the PhysicsScript player anchors on): parts not drawn, Cloaked bit. */
const ownParts = (p: Page) => p.evaluate(`(() => {
  const root = window.acDebug.playerModelRoot(); if (!root) return { found: false, undrawn: 0, meshes: 0, cloaked: false };
  let undrawn = 0, meshes = 0; root.traverse((m) => { if (m.isMesh && !m.parent?.userData?.wieldedGuid) { meshes++; if (m.userData.acPartUndrawn) undrawn++; } });
  return { found: true, undrawn, meshes, cloaked: ((root.userData.acPhysicsState ?? 0) & 0x100000) !== 0 };
})()`) as Promise<{ found: boolean; undrawn: number; meshes: number; cloaked: boolean }>;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 500)}`); };
  const { a, b, close } = await openTwoClients('packcloak');
  const sends: string[] = [];
  a.page.on('console', (m) => { const t = m.text(); if (/Sent Use \(0x0036\)|PutItemInContainer|placeInBackpack/i.test(t)) sends.push(t.slice(0, 200)); });
  try {
    if (want('pack')) {
      // Foci are undroppable on ACE ("The Foci of Strife can't be dropped"), so spawn one on the ground.
      await adminCommand(a.page, `@create ${FOCUS}`);
      await a.page.waitForTimeout(3500);
      const focus = await a.page.evaluate(`(() => { let best = 0, bd = 1e9; const cs = window.acDebug.collisionState();
        for (const o of window.__ac.serverObjectManager.objects.values()) { if (o.weenieClassId !== ${FOCUS}) continue;
          const d = Math.hypot(o.worldX - cs.x, o.worldZ - cs.z); if (d < bd) { bd = d; best = o.guid; } } return best; })()`) as number;
      const onGround = focus !== 0 && await a.page.evaluate(`!window.__ac.playerState.inventory.getItem(${focus})`) as boolean;
      const groundFlags = await a.page.evaluate(`window.__ac.serverObjectManager.getObject(${focus})?.objectDescFlags ?? null`);
      await shot(a.page, `${OUT}/pack-on-ground.png`);
      sends.length = 0;
      await a.page.evaluate(`window.acDebug.useObject(${focus})`);
      await a.page.waitForTimeout(4000);
      const backInPack = await a.page.evaluate(`!!window.__ac.playerState.inventory.getItem(${focus})`);
      const used = sends.some((t) => /Sent Use \(0x0036\)/.test(t));
      record('pack', focus !== 0 && onGround === true && backInPack === true && !used,
        { focus: focus.toString(16), groundFlags: groundFlags === null ? null : (groundFlags as number).toString(16), onGround, backInPack, sends: sends.slice() });
      await shot(a.page, `${OUT}/pack-picked-up.png`);
    }

    if (want('cloak')) {
      // Control: an uncloaked A fades out on B and on A's own client, then back in.
      await b.page.evaluate(`window.acDebug.playScriptOn(${FADE_OUT}, ${a.guid})`);
      await a.page.evaluate(`window.acDebug.playScriptOn(${FADE_OUT}, ${a.guid})`);
      await b.page.waitForTimeout(1800);
      const before = await remoteParts(b.page, a.guid);
      const ownBefore = await ownParts(a.page);
      await shot(b.page, `${OUT}/cloak-control-faded.png`);
      await b.page.evaluate(`window.acDebug.playScriptOn(${FADE_IN}, ${a.guid})`);
      await a.page.evaluate(`window.acDebug.playScriptOn(${FADE_IN}, ${a.guid})`);
      await b.page.waitForTimeout(1800);
      const restored = await remoteParts(b.page, a.guid);
      const ownRestored = await ownParts(a.page);

      await adminCommand(a.page, '@cloak on');
      await a.page.waitForTimeout(4000);
      const ownCloaked = await a.page.evaluate(`(() => { let n = 0; window.__ac.sceneManager.scene.traverse((o) => { if (((o.userData.acPhysicsState ?? 0) & 0x100000) !== 0) n++; }); return n; })()`) as number;
      const cloakedView = await remoteParts(b.page, a.guid);
      await b.page.evaluate(`window.acDebug.playScriptOn(${FADE_OUT}, ${a.guid})`);
      const ownPlay = await a.page.evaluate(`window.acDebug.playScriptOn(${FADE_OUT}, ${a.guid})`);
      await b.page.waitForTimeout(1800);
      const after = await remoteParts(b.page, a.guid);
      const ownAfter = await ownParts(a.page);
      await shot(a.page, `${OUT}/cloak-a-own.png`);
      await shot(b.page, `${OUT}/cloak-b-view.png`);
      await adminCommand(a.page, '@cloak off');
      await a.page.waitForTimeout(3000);
      record('cloak',
        before.found && before.undrawn > 0 && restored.undrawn === 0 && ownBefore.undrawn > 0 && ownRestored.undrawn === 0
          && ownCloaked > 0 && ownAfter.cloaked && ownAfter.undrawn === 0 && (!after.found || (after.cloaked && after.undrawn === 0)),
        { before, restored, ownBefore, ownRestored, ownCloaked, ownPlay, ownAfter, cloakedView, after });
    }
  } finally {
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    await close();
  }
  if (fails.length) { console.log(`FAILED: ${fails.join(', ')}`); process.exit(1); }
  console.log('ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
