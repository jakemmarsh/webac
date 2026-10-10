/**
 * probe-created-state-no-replay — live check for
 * SWEEP1006B.world-objects.objects-created-already-state-replay: an object
 * whose CreateObject already carries a state enters the world in that
 * state's cycle (CPhysicsObj::enter_world → remove_all_link_animations).
 *
 * Spawns a drudgeskulker-noaggro (wcid 19257) at Holtburg, @smites it, then
 * samples the corpse's MotionManager from the first frame it exists: it must
 * never be playing a link (the fall), and its animation must be the Dead
 * cycle's. Then teleports out of visibility and back so the corpse arrives
 * as a second fresh CreateObject, and samples it again.
 *
 * Usage: npx tsx tools/probe-created-state-no-replay.ts [outDir]
 */
import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, enterWorld, telepoi } from './lib/game-session.js';

const OUT = process.argv[2] ?? 'verification/created-state-no-replay';

const SAMPLE_JS = `(() => {
  const som = window.__ac.serverObjectManager;
  const out = [];
  for (const o of window.acDebug.listServerObjects()) {
    if (!/corpse of .*skulker/i.test(o.name)) continue;
    const a = som.getAnimated(o.guid);
    if (!a) { out.push({ guid: o.guid, animated: false }); continue; }
    const mm = a.motionManager;
    const p = mm.animationPlayer;
    const dead = mm.activeMotionTable && mm.activeMotionTable.cycles.get(mm.stance);
    out.push({ guid: o.guid, animated: true, dead: mm.isDead, playingLink: mm.isPlayingAction,
      anim: p.currentAnimation ? p.currentAnimation.id : 0, deadCycleAnim: dead ? dead.anims[0].animId : 0,
      frame: p.currentFrameIndex });
  }
  return out;
})()`;

interface Sample { guid: number; animated: boolean; dead?: boolean; playingLink?: boolean; anim?: number; deadCycleAnim?: number; frame?: number }

/** Sample every 50 ms for `ms`; returns every sample of corpses created after `known`. */
async function watch(page: Page, ms: number, known: Set<number>): Promise<Sample[]> {
  const all: Sample[] = [];
  for (let t = 0; t < ms; t += 50) {
    const s = await page.evaluate(SAMPLE_JS) as Sample[];
    for (const x of s) if (!known.has(x.guid)) all.push(x);
    await page.waitForTimeout(50);
  }
  return all;
}

function judge(label: string, samples: Sample[]): boolean {
  const animated = samples.filter((s) => s.animated);
  const bad = animated.filter((s) => s.playingLink || !s.dead || s.anim !== s.deadCycleAnim);
  const first = animated[0];
  console.log(`${label}: ${animated.length} samples; first ${JSON.stringify(first)}; link/non-dead-cycle samples: ${bad.length}`);
  return animated.length > 0 && bad.length === 0;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ cb: 'createdstate', settleMs: 6000 });
  try {
    await telepoi(page, 'Holtburg');
    await adminCommand(page, '@create 19257');
    await page.waitForTimeout(5000);
    const skulkers = await page.evaluate(`window.acDebug.listServerObjects().filter(o => /skulker/i.test(o.name) && !/corpse/i.test(o.name)).map(o => o.guid)`) as number[];
    if (skulkers.length < 1) throw new Error('no skulker spawned');
    const before = new Set((await page.evaluate(SAMPLE_JS) as Sample[]).map((s) => s.guid));
    await page.evaluate(`window.acDebug.selectServerObject(${skulkers[skulkers.length - 1]})`);
    await page.waitForTimeout(800);
    await adminCommand(page, '@smite');
    const fresh = await watch(page, 9000, before);
    await page.screenshot({ path: `${OUT}/corpse-created.png` });
    const okFresh = judge('corpse after the kill', fresh);

    // Out of visibility and back: the corpse is created again.
    await telepoi(page, 'Arwic', 15_000);
    await adminCommand(page, '@telepoi Holtburg');
    const again = await watch(page, 15_000, new Set());
    await page.screenshot({ path: `${OUT}/corpse-recreated.png` });
    const okAgain = judge('corpse re-created on return', again);

    console.log(okFresh && okAgain ? 'PASS' : 'FAIL');
    process.exitCode = okFresh && okAgain ? 0 : 1;
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
