/**
 * VISUAL.sylsfear-canopy-bright-cards.a — live check of the fog a login
 * straight into a sealed dungeon gets: retail's SetDefaultDeviceStates fog
 * (white, 0..1000 m; SkyboxRenderer RETAIL_DEFAULT_DEVICE_FOG), never the
 * pre-world clock's. Enters the world, teleports into the 0x8602 dungeon
 * (capture-scenes DUNGEON), reloads so the next login lands there directly,
 * reads the fog, then shows the old path in the same frame (the clock's fog
 * tick) for a before/after. Returns the character to Holtburg.
 *
 *   npx tsx tools/probe-direct-dungeon-fog.ts [--gpu]
 *
 * Writes verification/sylsfear-canopy-bright-cards/direct-login-fog-{after,before,after2}.png + -fog-probe.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, enterWorld, sessionArgs, teleloc, telepoi, waitForWorld, shot } from './lib/game-session.js';
import { DUNGEON } from './capture-scenes.js';

const OUT = join(REPO, 'verification', 'sylsfear-canopy-bright-cards');
mkdirSync(OUT, { recursive: true });

const FOG_JS = `(() => { const a = window.__ac; const f = a.sceneManager.scene.fog; const s = a.skybox;
  return { sealed: s.isSealedInterior, tod: Math.round(s.currentTimeOfDay * 1000) / 1000,
    fog: f ? { c: f.color.getHexString('srgb'), near: Math.round(f.near * 10) / 10, far: Math.round(f.far * 10) / 10 } : null }; })()`;

async function main(): Promise<void> {
  const { browser, page, url } = await enterWorld({ ...sessionArgs(), settleMs: 8000 });
  try {
    await teleloc(page, DUNGEON.replace(/^@teleloc /, ''));
    const entered = await page.evaluate(FOG_JS);
    console.log('teleported in (landscape was loaded):', JSON.stringify(entered));
    // A direct login: the next session starts in the dungeon cell.
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (!(await waitForWorld(page, { url }))) throw new Error('no world after reload');
    await page.waitForTimeout(12_000);
    const after = await page.evaluate(FOG_JS);
    console.log('direct login:', JSON.stringify(after));
    await shot(page, join(OUT, 'direct-login-fog-after.png'));
    // The old path in the same frame: the clock's fog tick (what the pre-world ticks had left).
    await page.evaluate('window.__ac.skybox.fogTick(false)');
    const before = await page.evaluate(FOG_JS);
    console.log('old path (clock fog):', JSON.stringify(before));
    await shot(page, join(OUT, 'direct-login-fog-before.png'));
    // A/B/A: the dungeon's animated lights change between frames, so the
    // second retail-fog frame measures that noise against the fog's effect.
    await page.evaluate('window.__ac.skybox.applyDefaultDeviceFog()');
    await shot(page, join(OUT, 'direct-login-fog-after2.png'));
    // Reach check: the cells and their objects must read this fog at all.
    // The same white fog pulled to 0..10 m whitens everything past the player.
    await page.evaluate('window.__ac.sceneManager.scene.fog.far = 10');
    await page.waitForTimeout(500);
    await shot(page, join(OUT, 'direct-login-fog-reach-10m.png'));
    await page.evaluate('window.__ac.skybox.applyDefaultDeviceFog()');
    writeFileSync(join(OUT, 'direct-login-fog-probe.json'), JSON.stringify({ entered, after, before }, null, 1));
    await telepoi(page, 'holtburg');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
