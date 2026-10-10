/**
 * VISUAL.dat-static-default-scripts — live probe: the DAT statics running their
 * Setup DefaultScript at the Holtburg Dungeon stone hall (0x01F6) and at the
 * Holtburg spawn, the emitters they own, and 4x crops of the nearest sconces.
 *
 *   npx tsx tools/probe-static-default-scripts.ts
 * Writes verification/static-default-scripts/{dungeon,holtburg}.png + sconce-*.png + probe.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { enterWorld, teleloc, telepoi, REPO } from './lib/game-session.js';
import { DUNGEON_STONE, HOLTBURG } from './capture-scenes.js';

const OUT = `${REPO}/verification/static-default-scripts`;

async function census(page: Page) {
  return page.evaluate(() => {
    const ac = (window as any).__ac;
    const cam = ac.sceneManager.camera;
    const THREE_V = cam.position.constructor;
    const anchors: Array<{ setup: string; script: string; visible: boolean; sx: number; sy: number; dist: number }> = [];
    let systems = 0, systemsVisible = 0;
    const byEmitter: Record<string, number> = {};
    ac.sceneManager.scene.traverse((o: any) => {
      if (typeof o.name === 'string' && o.name.startsWith('particles_')) {
        systems++;
        let vis = true; for (let n = o; n; n = n.parent) if (!n.visible) vis = false;
        if (vis) { systemsVisible++; byEmitter[o.name] = (byEmitter[o.name] ?? 0) + 1; }
      }
      if (!o.userData?.staticDefaultScript) return;
      let vis = true; for (let n = o; n; n = n.parent) if (!n.visible) vis = false;
      const p = new THREE_V(); o.getWorldPosition(p);
      const dist = p.distanceTo(cam.position);
      p.project(cam);
      anchors.push({
        setup: '0x' + (o.userData.setupId >>> 0).toString(16), script: '0x' + (o.userData.staticDefaultScript >>> 0).toString(16),
        visible: vis, sx: Math.round((p.x + 1) / 2 * innerWidth), sy: Math.round((1 - p.y) / 2 * innerHeight), dist: +dist.toFixed(1),
      });
    });
    return { running: (window as any).acDebug?.staticScripts?.(), anchors: anchors.length, anchorsVisible: anchors.filter(a => a.visible).length,
      systems, systemsVisible, byEmitter, onScreen: anchors.filter(a => a.visible && a.sx > 0 && a.sx < innerWidth && a.sy > 0 && a.sy < innerHeight).sort((a, b) => a.dist - b.dist).slice(0, 6) };
  });
}

async function zoomCrop(page: Page, x: number, y: number, file: string) {
  const w = 90, h = 90;
  const clip = { x: Math.max(0, x - w / 2), y: Math.max(0, y - h / 2), width: w, height: h };
  const buf = await page.screenshot({ clip });
  const out = await page.evaluate(async (b64) => {
    const im = new Image(); await new Promise(r => { im.onload = r; im.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas'); c.width = im.width * 4; c.height = im.height * 4;
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false; ctx.drawImage(im, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  }, buf.toString('base64'));
  writeFileSync(file, Buffer.from(out, 'base64'));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld();
  const result: Record<string, unknown> = {};
  try {
    await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(0.5));
    await teleloc(page, DUNGEON_STONE.replace(/^@teleloc /, ''), 20_000);
    await page.evaluate(() => (window as any).acDebug?.setPlayerYaw?.(1.6));
    await page.waitForTimeout(6000);
    const dungeon = await census(page);
    result.dungeon = dungeon;
    await page.screenshot({ path: `${OUT}/dungeon.png` });
    for (const [i, a] of dungeon.onScreen.slice(0, 3).entries()) await zoomCrop(page, a.sx, a.sy, `${OUT}/sconce-${i}.png`);
    // Close-up: walk the camera in (retail rawg_04's torch sits ~3-4 m from the camera).
    await page.evaluate(() => { const c = (window as any).__ac?.cameraController; if (c) c.cameraDistance = 2; });
    await page.keyboard.down('w'); await page.waitForTimeout(2600); await page.keyboard.up('w');
    await page.waitForTimeout(3000);
    const close = await census(page);
    result.dungeonClose = close.onScreen;
    await page.screenshot({ path: `${OUT}/dungeon-close.png` });
    if (close.onScreen[0]) await zoomCrop(page, close.onScreen[0].sx, close.onScreen[0].sy, `${OUT}/sconce-close.png`);
    await telepoi(page, HOLTBURG.replace(/^@telepoi /, ''), 20_000);
    await page.evaluate(() => (window as any).acDebug?.setPlayerYaw?.(Math.PI)); // face north, the oven
    await page.waitForTimeout(6000);
    result.holtburg = await census(page);
    await page.screenshot({ path: `${OUT}/holtburg.png` });
  } finally {
    writeFileSync(`${OUT}/probe.json`, JSON.stringify(result, null, 1));
    console.log(JSON.stringify(result, null, 1));
    await browser.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
