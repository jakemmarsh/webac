/**
 * probe-decomp-environs — live check for DECOMP S2/S3 (environs override
 * replaces the ambient and blends in at +0.04 per fog tick; clear is instant)
 * via ACE's `@setlbenviron`. Real GPU, testacjs2.
 * Usage: npx tsx tools/probe-decomp-environs.ts
 */
import { enterWorld, adminCommand } from './lib/game-session.ts';
const { browser, page } = await enterWorld({ gpu: true });
let done = false; page.on('console', (m) => { if (/Sent LoginComplete/.test(m.text())) done = true; });
await adminCommand(page, '@telepoi Holtburg'); for (let i = 0; i < 90 && !done; i++) await page.waitForTimeout(500); await page.waitForTimeout(3000);
const st = () => page.evaluate(`(() => { const a = window.__ac; const sc = a.sceneManager.scene; let amb = 0; const lv = []; sc.traverse(o => { if (o.isAmbientLight) { amb++; lv.push(+o.intensity.toFixed(3)); } });
  const f = sc.fog; return JSON.stringify({ t: +(a.skybox.environOverrideTransition ?? -1).toFixed(2), ov: !!a.skybox.environOverrideState, ambLights: amb, amb: lv, fog: f ? [+f.near.toFixed(0), +f.far.toFixed(0), '#' + f.color.getHexString()] : null }); })()`);
console.log('before', await st());
await adminCommand(page, '@setlbenviron RedFog');
for (let i = 0; i < 14; i++) { await page.waitForTimeout(2000); console.log('red +' + (2 * (i + 1)) + 's', await st()); }
await adminCommand(page, '@setlbenviron');
await page.waitForTimeout(1500); console.log('cleared +1.5s', await st());
await browser.close();
