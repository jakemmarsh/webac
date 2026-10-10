import { chromium, type Page } from 'playwright';
import { existsSync } from 'node:fs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=intchk' + Date.now();
async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(`(() => { const d=window.acDebug; const c=d&&d.collisionState&&d.collisionState(); return !!(c&&c.x>0); })()`) as Promise<boolean>;
}
async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(120000);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 300_000; let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) { try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch {} lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  await page.waitForTimeout(8000);
  // Teleport into the Training Academy dungeon (landblock 0x8602)
  const r = await page.evaluate(`window.acDebug.admin('@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0')`);
  console.log('teleloc:', JSON.stringify(r));
  await page.waitForTimeout(20000);
  await page.evaluate(`window.acDebug.setTimeOfDay(0.5)`);
  await page.waitForTimeout(3000);
  const census = await page.evaluate(`(() => {
    let furn = 0, furnInst = 0, parts = 0;
    window.__ac.sceneManager.scene.traverse(o => {
      if (o.isInstancedMesh && o.name.indexOf('envfurninst_') === 0) { furn++; furnInst += o.count; }
      if (o.isMesh && !o.isInstancedMesh && o.parent && /^part_\\d+$/.test(o.parent.name||'')) parts++;
    });
    const info = window.__ac.sceneManager.renderer.info;
    return { furnBatches: furn, furnInstances: furnInst, loosePartMeshes: parts, drawCalls: info.render.calls };
  })()`);
  console.log('interior census:', JSON.stringify(census));
  for (const [name, yaw] of [['a', 0.8], ['b', 2.4], ['c', 4.0]] as [string, number][]) {
    await page.evaluate(`window.acDebug.setPlayerYaw(${yaw})`);
    await page.waitForTimeout(1500);
    await page.locator('canvas').first().screenshot({ path: `verification/perf1-building-pool/interior-${name}.png` });
  }
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
