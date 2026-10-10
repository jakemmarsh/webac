/**
 * verify-dblclick-fix — live verification for BUG.dblclick-vendor-npc-auto-attacks.
 *
 * Beats:
 *  A. peace-mode dblclick on the Holtburg blacksmith (flags 0x204) →
 *     must NOT enter combat, must NOT send an attack ("You cannot attack" chat),
 *     and SHOULD open the vendor Buy/Sell panel via the Use path.
 *  B. peace-mode dblclick on an attackable rabbit (wcid 2567) →
 *     must NOT auto-enter combat (retail never does from peace mode).
 *  C. melee-mode dblclick on the rabbit → attack still dispatches (combat
 *     evidence: swing chat lines / target death / health series).
 *
 * Output: verification/playtest/<utc>-dblclick-fix/ screenshots + observations.json
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=dblfix';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-dblclick-fix`);

const chatLog: string[] = [];
const steps: Array<Record<string, unknown>> = [];
let phase = 'boot';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
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

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
}

async function screenPos(page: Page, guid: number, yOff = 1.0): Promise<{ x: number; y: number; behind: boolean } | null> {
  return page.evaluate(`(() => {
    const so = window.__ac.serverObjectManager.getObject(${guid});
    if (!so || !so.mesh) return null;
    const sm = window.__ac.sceneManager;
    const cam = sm.camera;
    const rect = sm.renderer.domElement.getBoundingClientRect();
    const v = so.mesh.position.clone();
    so.mesh.getWorldPosition(v); // interior meshes are parented into cell groups — .position is local
    v.y += ${yOff};
    v.project(cam);
    return {
      x: rect.left + (v.x + 1) / 2 * rect.width,
      y: rect.top + (1 - v.y) / 2 * rect.height,
      behind: v.z > 1,
    };
  })()`) as Promise<{ x: number; y: number; behind: boolean } | null>;
}

async function objects(page: Page): Promise<Array<{ guid: number; name: string; dist: number }>> {
  return page.evaluate(`(() => {
    const me = window.acDebug.collisionState();
    return window.acDebug.getObjects()
      .filter(o => o.pos && o.name)
      .map(o => ({ guid: o.guid, name: o.name,
        dist: Math.hypot(o.pos.x - me.x, o.pos.z - me.z) }))
      .sort((a, b) => a.dist - b.dist);
  })()`) as any;
}

async function faceObject(page: Page, guid: number, yOff = 1.0): Promise<{ x: number; y: number; behind: boolean } | null> {
  for (let i = 0; i < 24; i++) {
    const sp = await screenPos(page, guid, yOff);
    if (sp && !sp.behind && sp.x > 20 && sp.x < VIEW.width - 20 && sp.y > 40 && sp.y < VIEW.height - 20) return sp;
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(350);
    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(250);
  }
  return screenPos(page, guid, yOff);
}

/** Dense in-page dblclick sweep: dispatch real dblclick MouseEvents on the canvas
 * over a grid around the object's projected mesh position, detecting a hit
 * synchronously via gameUI.hudState.target (set by onCanvasDblClick). */
async function dblClickObject(page: Page, guid: number): Promise<boolean> {
  const res = await page.evaluate(`(() => {
    const sm = window.__ac.sceneManager;
    const c = sm.renderer.domElement;
    const ui = window.__ac.gameUI;
    const selId = () => (ui.hudState.target ? ui.hudState.target.id : 0);
    const som = window.__ac.serverObjectManager;
    const so = som.getObject ? som.getObject(${guid}) : (som.objects && som.objects.get && som.objects.get(${guid}));
    if (!so || !so.mesh) return 'no-mesh';
    const rect = c.getBoundingClientRect();
    ui.hudState.target = null;
    let tried = 0;
    const wp = so.mesh.position.clone();
    so.mesh.getWorldPosition(wp); // interior meshes are parented into cell groups — .position is local
    for (const yOff of [1.0, 0.7, 0.4, 1.3, 0.1, 1.6, 1.9]) {
      const v = wp.clone(); v.y += yOff; v.project(sm.camera);
      if (v.z > 1) continue;
      const sx = rect.left + (v.x + 1) / 2 * rect.width;
      const sy = rect.top + (1 - v.y) / 2 * rect.height;
      for (const dx of [0, -8, 8, -16, 16, -24, 24, -32, 32, -48, 48]) {
        const x = sx + dx, y = sy;
        if (x < 5 || x > rect.width - 5 || y < 40 || y > rect.height - 5) continue;
        tried++;
        c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        if (selId() === ${guid}) return JSON.stringify({ x, y, tried });
        if (selId() !== 0) ui.hudState.target = null; // grazed a different object; keep sweeping
      }
    }
    // FALLBACK: the object never projects on-screen (wedged camera, interior).
    // Synchronously aim the camera at it and dblclick screen center — the real
    // handler + real raycast run against the aimed camera before the next
    // frame re-asserts the rig (equivalent to the user having turned).
    const aim = wp.clone(); aim.y += 1.0;
    sm.camera.lookAt(aim);
    sm.camera.updateMatrixWorld(true);
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const wrongHits = [];
    for (const [ox, oy] of [[0,0],[0,-20],[0,20],[-20,0],[20,0],[0,-45],[0,45]]) {
      tried++;
      c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: cx + ox, clientY: cy + oy }));
      if (selId() === ${guid}) return JSON.stringify({ x: cx + ox, y: cy + oy, tried, via: 'camera-aim' });
      if (selId() !== 0) { wrongHits.push(selId().toString(16)); ui.hudState.target = null; }
    }
    // LAST RESORT: park the camera 1.5m from the target with clear LOS and
    // dblclick dead center (still the real handler + real raycast).
    const dir = sm.camera.position.clone().sub(aim).normalize();
    const savedPos = sm.camera.position.clone();
    sm.camera.position.copy(aim.clone().add(dir.multiplyScalar(1.5)));
    sm.camera.lookAt(aim);
    sm.camera.updateMatrixWorld(true);
    tried++;
    c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    const sel = selId();
    sm.camera.position.copy(savedPos);
    if (sel === ${guid}) return JSON.stringify({ x: cx, y: cy, tried, via: 'camera-park', wrongHits });
    if (sel !== 0) { wrongHits.push('park:' + sel.toString(16)); ui.hudState.target = null; }
    if (wrongHits.length) return 'miss-wrong-hits:' + JSON.stringify(wrongHits);
    const diag = [];
    for (const yOff of [0.1, 1.0, 1.9]) {
      const v = wp.clone(); v.y += yOff; v.project(sm.camera);
      diag.push({ yOff, z: +v.z.toFixed(3),
        sx: +(rect.left + (v.x + 1) / 2 * rect.width).toFixed(0),
        sy: +(rect.top + (1 - v.y) / 2 * rect.height).toFixed(0) });
    }
    return 'miss:' + tried + ' diag=' + JSON.stringify({ wp: { x: +wp.x.toFixed(1), y: +wp.y.toFixed(1), z: +wp.z.toFixed(1) },
      local: { x: +so.mesh.position.x.toFixed(1), y: +so.mesh.position.y.toFixed(1), z: +so.mesh.position.z.toFixed(1) },
      visible: so.mesh.visible, parentType: so.mesh.parent && so.mesh.parent.type,
      cam: { x: +sm.camera.position.x.toFixed(1), y: +sm.camera.position.y.toFixed(1), z: +sm.camera.position.z.toFixed(1) },
      rect: { w: rect.width, h: rect.height }, proj: diag });
  })()`) as string;
  console.log(`[verify] dblclick sweep guid=0x${guid.toString(16)}: ${res}`);
  return typeof res === 'string' && res.startsWith('{');
}

async function combatState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => ({
    isInCombat: window.__ac.combatController.isInCombat,
    combatMode: window.__ac.gameUI.hudState.combatMode,
  }))()`) as any;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  page.on('console', (m) => {
    const txt = m.text();
    if (/\[AC\]|\[Chat\]/.test(txt)) chatLog.push(`${phase}| ${txt.slice(0, 300)}`);
  });

  console.log(`[verify] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[verify] create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[verify] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* loop */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await shot(page, '00-never-entered'); await browser.close(); throw new Error('never entered world'); }
  phase = 'settle';
  await page.waitForTimeout(10_000);
  await shot(page, '01-spawn');

  // ── Beat A: peace-mode dblclick on the blacksmith ──
  phase = 'beat-a-vendor';
  await page.evaluate(`window.acDebug.tele('0xA9B40100', 84, 127, 66.005)`);
  await page.waitForTimeout(10_000);
  const objs1 = await objects(page);
  console.log('[verify] interior:', objs1.slice(0, 6).map(o => `${o.name}@${o.dist.toFixed(1)}`).join(', '));
  const vendor = objs1.find(o => /blacksmith|smith|armorer/i.test(o.name));
  if (!vendor) throw new Error('no vendor found in blacksmith interior');
  await faceObject(page, vendor.guid);
  const chatMarkA = chatLog.length;
  const before = await combatState(page);
  const hitA = await dblClickObject(page, vendor.guid);
  // give the Use→ApproachVendor round-trip time
  let vendorOpened = false;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    if (await page.evaluate(`window.__ac.gameUI.vendorVisible`)) { vendorOpened = true; break; }
  }
  const after = await combatState(page);
  const cannotAttack = chatLog.slice(chatMarkA).filter(l => /cannot attack/i.test(l));
  await shot(page, '02-after-dblclick-vendor');
  steps.push({ step: 'beat-a-dblclick-vendor', vendor, raycastHit: hitA, before, after, vendorOpened, cannotAttackLines: cannotAttack });
  console.log(`[verify] BEAT A: hit=${hitA} inCombat ${JSON.stringify(before)} -> ${JSON.stringify(after)} vendorOpened=${vendorOpened} cannotAttack=${cannotAttack.length}`);
  await page.evaluate(`window.__ac.gameUI.hideVendorWindow?.()`).catch(() => {});
  await page.waitForTimeout(800);

  if (process.env.BEAT === 'A') {
    await browser.close();
    writeFileSync(join(OUT, 'observations.json'), JSON.stringify({ utc: UTC, beatAOnly: true, steps, chatLog }, null, 2));
    const a0 = steps.find(s => s.step === 'beat-a-dblclick-vendor') as any;
    console.log(`[verify] BEAT-A-ONLY VERDICT: ${a0.raycastHit && !a0.after.isInCombat && a0.cannotAttackLines.length === 0 && a0.vendorOpened}`);
    return;
  }

  // ── Beat B: peace-mode dblclick on an attackable rabbit ──
  phase = 'beat-b-peace-monster';
  await page.evaluate(`window.acDebug.tele('0xA9B40000', 101.9, 25, 94.1)`);
  await page.waitForTimeout(10_000);
  await page.evaluate(`window.acDebug.sendTalk('@create 2567')`);
  await page.waitForTimeout(5000);
  const objs2 = await objects(page);
  const rabbit = objs2.find(o => /rabbit/i.test(o.name) && o.dist < 30);
  if (!rabbit) throw new Error('rabbit did not spawn');
  await faceObject(page, rabbit.guid, 0.5);
  const chatMarkB = chatLog.length;
  const beforeB = await combatState(page);
  const hitB = await dblClickObject(page, rabbit.guid);
  await page.waitForTimeout(3000);
  const afterB = await combatState(page);
  await shot(page, '03-after-peace-dblclick-rabbit');
  steps.push({ step: 'beat-b-peace-dblclick-rabbit', rabbit, raycastHit: hitB, beforeB, afterB, chat: chatLog.slice(chatMarkB) });
  console.log(`[verify] BEAT B: hit=${hitB} ${JSON.stringify(beforeB)} -> ${JSON.stringify(afterB)}`);

  // ── Beat C: melee-mode dblclick on the rabbit still attacks ──
  phase = 'beat-c-combat-monster';
  await page.evaluate(`window.acDebug.combatMode('melee')`);
  await page.waitForTimeout(2500);
  const modeC = await combatState(page);
  const chatMarkC = chatLog.length;
  const hitC = await dblClickObject(page, rabbit.guid);
  const series: Array<Record<string, unknown>> = [];
  let rabbitGone = false;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(4000);
    const st = await page.evaluate(`(() => {
      const objs = window.acDebug.getObjects();
      const d = objs.find(o => o.guid === ${rabbit.guid});
      return { rabbitPresent: !!d, inCombat: window.__ac.combatController.isInCombat };
    })()`) as Record<string, unknown>;
    series.push(st);
    if (i === 1) await shot(page, '04-combat-mid');
    if (!st.rabbitPresent) { rabbitGone = true; break; }
  }
  const combatChat = chatLog.slice(chatMarkC);
  const swingEvidence = combatChat.filter(l => /you (hit|mangle|slash|smash|bash|jab|nick|graze|evade|miss)|evades? your|killed|died|death/i.test(l));
  await shot(page, '05-combat-end');
  steps.push({ step: 'beat-c-melee-dblclick-rabbit', modeC, raycastHit: hitC, rabbitGone, series, swingEvidence, combatChat: combatChat.slice(0, 40) });
  console.log(`[verify] BEAT C: hit=${hitC} mode=${JSON.stringify(modeC)} rabbitGone=${rabbitGone} swingLines=${swingEvidence.length}`);
  await page.evaluate(`window.acDebug.combatMode('peace')`).catch(() => {});

  await browser.close();
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({
    utc: UTC, url: URL, task: 'BUG.dblclick-vendor-npc-auto-attacks', steps, chatLog: chatLog.slice(-250),
  }, null, 2));
  console.log(`\n[verify] done — wrote ${OUT}`);

  // verdict
  const a = steps.find(s => s.step === 'beat-a-dblclick-vendor') as any;
  const b = steps.find(s => s.step === 'beat-b-peace-dblclick-rabbit') as any;
  const c = steps.find(s => s.step === 'beat-c-melee-dblclick-rabbit') as any;
  const passA = a.raycastHit && !(a.after.isInCombat) && a.cannotAttackLines.length === 0 && a.vendorOpened;
  const passB = b.raycastHit && !(b.afterB.isInCombat);
  const passC = c.raycastHit && (c.rabbitGone || c.swingEvidence.length > 0);
  console.log(`[verify] VERDICT: A(vendor-use)=${passA} B(no-auto-combat)=${passB} C(combat-attack-stays)=${passC}`);
  if (!passA || !passB || !passC) process.exit(2);
}

main().catch((err) => { console.error(err); process.exit(1); });
