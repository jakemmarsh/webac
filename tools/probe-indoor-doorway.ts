// Walk into a building (default: the Yaraq grocer, Nuya) in firefox or chromium and record frame pacing outside,
// inside and through an 8-step 360° turn, with a screenshot per step. Regression probe for the 2026-10-21 indoor
// doorway bugs. npx tsx tools/probe-indoor-doorway.ts <firefox|chromium> <outdir> [walk target]
import { firefox, chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const which = process.argv[2] ?? 'firefox';
const out = process.argv[3] ?? '/tmp/ff-indoor';
mkdirSync(out, { recursive: true });
const url = 'http://localhost:3051/?ace&agent&bridge=ws://localhost:9101&account=testacjs3&password=testacjs3';
const browser = await (which === 'chromium' ? chromium : firefox).launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
await page.goto(url);
const wait = (ms: number) => page.waitForTimeout(ms);
const ev = <T>(s: string) => page.evaluate(s) as Promise<T>;
for (let i = 0; i < 120; i++) {
  const ok = await ev<boolean>(`!!(window.__acAgent && window.__acAgent.observe && window.__acAgent.observe().screen === 'world')`).catch(() => false);
  if (ok) break;
  await wait(1000);
}
await wait(8000);
const pacing = (ms: number) => ev<string>(`new Promise(res => { const t=[]; let last=performance.now(); const end=last+${ms}; function f(n){ t.push(n-last); last=n; if(n<end) requestAnimationFrame(f); else { t.sort((a,b)=>a-b); res(JSON.stringify({frames:t.length, median:Math.round(t[t.length>>1]), p95:Math.round(t[Math.floor(t.length*0.95)]), max:Math.round(t[t.length-1])})); } } requestAnimationFrame(f); })`);
const step = async (name: string) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  const obs = await ev<string>(`JSON.stringify((({self, location, where, place, coords, cell}) => ({self: self && {name:self.name, loc: self.location ?? self.coords ?? self.where}, location, where, place, coords, cell}))(window.__acAgent.observe()))`).catch((e) => String(e));
  console.log(name, obs.slice(0, 400));
};
const target = process.argv[4] ?? '';
await step('01-start');
console.log('pacing outside', await pacing(5000));
const vendors = await ev<string>(`JSON.stringify(window.__acAgent.observe({filter:'vendor', radius:400}).nearby?.slice(0,6) ?? window.__acAgent.nearby(400,'vendor').slice(0,6))`).catch((e) => String(e));
console.log('vendors', vendors.slice(0, 1200));
let tgt = target;
if (!tgt) { try { const v = JSON.parse(vendors); tgt = v[0]?.guid ?? v[0]?.id ?? v[0]?.name ?? ''; } catch { /* */ } }
console.log('walking to', tgt);
const walk = await ev<string>(`window.__acAgent.walkTo(${JSON.stringify(tgt)}).then(r => JSON.stringify(r)).catch(e => String(e))`);
console.log('walk', walk.slice(0, 400));
for (let i = 0; i < 12; i++) { const busy = await ev<string>(`JSON.stringify(window.__acAgent.observe().task ?? null)`).catch(() => 'null'); if (busy === 'null' || /done|idle|arrived/.test(busy)) break; await wait(5000); }
await wait(3000);
await step('02-inside');
console.log('pacing inside', await pacing(5000));
// face back toward the door: turn 180
await page.mouse.click(784, 300);
for (let k = 0; k < 8; k++) { await page.keyboard.down('d'); await wait(450); await page.keyboard.up('d'); await wait(1200); await step(`03-turn-${k}`); }
console.log('pacing inside turned', await pacing(5000));
writeFileSync(`${out}/errors.txt`, errs.join('\n'));
console.log('errors', errs.length, errs.slice(0, 8).join(' | '));
await browser.close();
