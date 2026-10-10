// BUG.uihidden-never-read — live verification.
//
// Drives the REAL server round-trip: appraise a nearby radar-visible NPC,
// then `@setproperty PropertyBool.UiHidden true` (ACE DeveloperCommands
// HandleSetProperty broadcasts a genuine PublicUpdatePropertyBool), and
// asserts the client honors it end-to-end:
//   - radar dot for the guid disappears (gmRadarUI::AddObject guard)
//   - hovering the object produces NO name label + default cursor
//     (RecvNotice_SmartBoxObjectFound guard: treated as nothing found)
//   - clicking it clears the selection instead of targeting it
// Then flips it back false and asserts everything returns.
//
// Usage: npx tsx tools/playtest-uihidden-pick-radar.ts <outDir>
import { chromium, Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'verification/uihidden';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 882 };

async function inWorld(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(`(() => {
      const ac = window.__ac;
      return !!(ac && ac.gameUI && ac.gameUI.ui && ac.gameUI.ui.currentScreen === 'game');
    })()`) as boolean;
  } catch { return false; }
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

/** List radar-dotted, on-screen candidates sorted nearest-first. */
async function listCandidates(page: Page): Promise<Array<{ guid: number; name: string; sx: number; sy: number }>> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const som = ac.serverObjectManager;
    const cam = ac.sceneManager.camera;
    const dots = ac.gameUI.hudState.radarDots || [];
    const dotGuids = new Set(dots.map(d => d.guid));
    const out = [];
    for (const [guid, obj] of som.getAllObjects()) {
      if (!dotGuids.has(guid) || !obj.mesh || !obj.mesh.visible) continue;
      const p = obj.mesh.position.clone();
      p.y += 1.0; // aim at the torso, not the feet
      p.project(cam);
      if (p.z > 1 || Math.abs(p.x) > 0.85 || Math.abs(p.y) > 0.85) continue;
      const dx = obj.mesh.position.x - cam.position.x;
      const dz = obj.mesh.position.z - cam.position.z;
      out.push({ guid, name: obj.name, d: dx*dx + dz*dz,
        sx: (p.x + 1) / 2 * ${VIEW.width},
        sy: (1 - p.y) / 2 * ${VIEW.height} });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  })()`) as Promise<Array<{ guid: number; name: string; sx: number; sy: number }>>;
}

/** Pick the first candidate whose screen point actually hovers IT (the
 *  projection can land on an occluder — a door frame, another NPC). */
async function pickTarget(page: Page): Promise<{ guid: number; name: string; sx: number; sy: number } | null> {
  const cands = await listCandidates(page);
  const offsets = [[0, 0], [0, -25], [0, 25], [-20, 0], [20, 0], [0, -50], [-15, -25], [15, -25]];
  for (const c of cands.slice(0, 10)) {
    for (const [ox, oy] of offsets) {
      const sx = c.sx + ox, sy = c.sy + oy;
      await page.mouse.move(sx, sy);
      await page.waitForTimeout(400);
      // CORE.17.k.b.b.a.g.a/.b: the hover is the 3D-view tooltip tag (retail RecvNotice_SmartBoxObjectFound), not an overhead label.
      const hovered = await page.evaluate(`(document.querySelector('canvas') && document.querySelector('canvas').dataset.acTooltipText) || ''`) as string;
      if (hovered === c.name) return { ...c, sx, sy };
    }
    console.log(`  candidate ${c.name} 0x${c.guid.toString(16)} occluded at all sample points, skipping`);
  }
  return null;
}

async function probe(page: Page, guid: number, sx: number, sy: number) {
  // hover
  await page.mouse.move(sx, sy);
  await page.waitForTimeout(400); // hover raycast is throttled to 10 Hz
  const afterHover = await page.evaluate(`(() => {
    const ac = window.__ac;
    return {
      hoveredName: (ac.sceneManager.renderer.domElement.dataset.acTooltipText) || '',
      cursor: ac.sceneManager.renderer.domElement.style.cursor,
    };
  })()`) as { hoveredName: string; cursor: string };
  // click-select
  await page.mouse.click(sx, sy);
  await page.waitForTimeout(300);
  const afterClick = await page.evaluate(`(() => {
    const ac = window.__ac;
    const t = ac.gameUI.hudState.target;
    return { targetGuid: t ? t.id : 0 };
  })()`) as { targetGuid: number };
  const state = await page.evaluate(`(() => {
    const ac = window.__ac;
    const obj = ac.serverObjectManager.getObject(${guid});
    const dots = ac.gameUI.hudState.radarDots || [];
    return {
      uiHidden: obj ? !!obj.uiHidden : null,
      meshVisible: obj && obj.mesh ? obj.mesh.visible : null,
      onRadar: dots.some(d => d.guid === ${guid}),
    };
  })()`) as { uiHidden: boolean | null; meshVisible: boolean | null; onRadar: boolean };
  return { ...afterHover, ...afterClick, ...state };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log('create:', created); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('reload retry');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch {}
      lastReload = Date.now();
    }
    await page.waitForTimeout(2000);
  }
  if (!(await inWorld(page))) { console.log('FAILED: never entered world'); await browser.close(); process.exit(1); }
  console.log('in world');
  await page.waitForTimeout(10000); // let world + radar stream in

  let target = await pickTarget(page);
  if (!target) {
    // Spawn vantage occluded — hop to town center where NPCs stand in the open.
    for (const poi of ['Holtburg', 'Rithwic', 'Shoushi']) {
      console.log('teleporting: @telepoi', poi);
      await page.evaluate(`window.acDebug.sendChat('@telepoi ${poi}')`);
      await page.waitForTimeout(12000); // portal + object stream-in
      target = await pickTarget(page);
      if (target) break;
    }
  }
  if (!target) { console.log('FAILED: no on-screen radar-dotted object found'); await browser.close(); process.exit(1); }
  console.log('target:', target.name, '0x' + target.guid.toString(16), '@', Math.round(target.sx), Math.round(target.sy));

  // ── baseline ──
  const baseline = await probe(page, target.guid, target.sx, target.sy);
  console.log('BASELINE', JSON.stringify(baseline));
  await page.screenshot({ path: `${OUT}/1-baseline.png` });

  // ── appraise (sets ACE last-appraised) then flip UiHidden=true ──
  await page.evaluate(`window.__ac.identifyObject(${target.guid})`);
  await page.waitForTimeout(1500);
  await page.evaluate(`window.acDebug.sendChat('@setproperty PropertyBool.UiHidden true')`);
  await page.waitForTimeout(2500);

  // clear any lingering selection state from the baseline click, then re-probe
  const hidden = await probe(page, target.guid, target.sx, target.sy);
  console.log('HIDDEN  ', JSON.stringify(hidden));
  await page.screenshot({ path: `${OUT}/2-uihidden.png` });

  // ── flip back ──
  await page.evaluate(`window.acDebug.sendChat('@setproperty PropertyBool.UiHidden false')`);
  await page.waitForTimeout(2500);
  const restored = await probe(page, target.guid, target.sx, target.sy);
  console.log('RESTORED', JSON.stringify(restored));
  await page.screenshot({ path: `${OUT}/3-restored.png` });

  const pass =
    baseline.uiHidden === false && baseline.onRadar && baseline.hoveredName === target.name && baseline.targetGuid === target.guid &&
    hidden.uiHidden === true && !hidden.onRadar && hidden.hoveredName === '' && hidden.targetGuid === 0 &&
    restored.uiHidden === false && restored.onRadar && restored.hoveredName === target.name && restored.targetGuid === target.guid;
  console.log(pass ? 'PASS' : 'FAIL');
  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
