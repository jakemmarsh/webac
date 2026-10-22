// Same player flows in firefox / webkit / chromium against YOUR local stack (Vite :3051, bridge :9101 by default;
// edit url below). Records world arrival, panels, wheel zoom, chat typed with the real keyboard, an indoor walk +
// sweep with frame pacing, the vendor, and every console/page error. docs/verification-workflows.md "Cross-browser matrix".
import { firefox, webkit, chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const which = process.argv[2] ?? 'firefox';
const out = process.argv[3] ?? '/tmp/matrix';
const acct = process.argv[4] ?? 'testacjs3';
mkdirSync(out, { recursive: true });
const url = `http://localhost:3051/?ace&agent&bridge=ws://localhost:9101&account=${acct}&password=${acct}`;
const type = which === 'webkit' ? webkit : which === 'chromium' ? chromium : firefox;
const browser = await type.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
const errs: string[] = [];
const report: Record<string, unknown> = { browser: which, ua: '' };
page.on('pageerror', (e) => errs.push(`pageerror: ${String(e).slice(0, 300)}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
const wait = (ms: number) => page.waitForTimeout(ms);
const ev = <T>(s: string) => page.evaluate(s) as Promise<T>;
let n = 0;
const shot = async (name: string) => { await page.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${name}.png` }); };
const pacing = (ms: number) => ev<string>(`new Promise(res => { const t=[]; let last=performance.now(); const end=last+${ms}; function f(x){ t.push(x-last); last=x; if(x<end) requestAnimationFrame(f); else { t.sort((a,b)=>a-b); res(JSON.stringify({median:Math.round(t[t.length>>1]), p95:Math.round(t[Math.floor(t.length*0.95)]), max:Math.round(t[t.length-1])})); } } requestAnimationFrame(f); })`);
const log = (k: string, v: unknown) => { report[k] = v; console.log(k, typeof v === 'string' ? v.slice(0, 300) : JSON.stringify(v).slice(0, 300)); };

const t0 = Date.now();
await page.goto(url);
for (let i = 0; i < 150; i++) {
  if (await ev<boolean>(`!!(window.__acAgent && window.__acAgent.observe().screen === 'world')`).catch(() => false)) break;
  await wait(1000);
}
log('worldMs', Date.now() - t0);
report.ua = await ev<string>('navigator.userAgent');
await wait(6000);
await shot('world');
log('pacingOutside', await pacing(4000));

// Panels by their key-binding names
const keys = await ev<string>(`window.__acAgent.keys('')`).catch((e) => String(e));
writeFileSync(`${out}/keys.txt`, keys);
const names = keys.split('\n').map((l) => l.trim()).filter(Boolean);
const pick = (re: RegExp) => names.find((l) => re.test(l))?.split(/\s{2,}|:|\t/)[0]?.trim();
const panels: Record<string, string | undefined> = {
  inventory: pick(/inventory/i), spellbook: pick(/spell ?book|spells/i), map: pick(/\bmap\b/i),
  options: pick(/option/i), character: pick(/character|attributes/i), social: pick(/social|allegiance|fellowship/i),
};
log('panelBindings', panels);
for (const [k, name] of Object.entries(panels)) {
  if (!name) continue;
  const r1 = await ev<string>(`JSON.stringify(window.__acAgent.press(${JSON.stringify(name)}))`).catch((e) => String(e));
  await wait(1500); await shot(`panel-${k}`);
  await ev(`window.__acAgent.press(${JSON.stringify(name)})`).catch(() => null);
  await wait(800);
  log(`panel-${k}`, r1);
}

// Wheel zoom over the world: real wheel events in this engine
await page.mouse.move(784, 330);
await shot('zoom-before');
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 300); await wait(120); }
await wait(800); await shot('zoom-out');
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -300); await wait(120); }
await wait(800); await shot('zoom-in');

// Chat typed with the real keyboard
const before = await ev<number>(`(window.__acAgent.observe().chat||[]).length`).catch(() => -1);
await ev(`document.getElementById('chat-input')?.focus()`);
await page.keyboard.type('/em wave', { delay: 30 });
await page.keyboard.press('Enter');
await wait(1500);
log('chatInputAfter', await ev<string>(`document.getElementById('chat-input')?.value ?? 'missing'`));
log('chatTail', await ev<string>(`JSON.stringify((window.__acAgent.observe().chat||[]).slice(-3).map(c=>c.text))`));
await shot('chat');
await page.mouse.click(784, 330);

// Indoors + vendor
const w = await ev<string>(`window.__acAgent.walkTo('Nuya').then(r=>JSON.stringify(r)).catch(e=>String(e))`);
log('walk', w);
await wait(2500);
log('pacingInside', await pacing(4000));
for (let k = 0; k < 6; k++) { await page.keyboard.down('d'); await wait(450); await page.keyboard.up('d'); await wait(900); await shot(`turn-${k}`); }
log('pacingTurned', await pacing(4000));
const u = await ev<string>(`window.__acAgent.use ? Promise.resolve(window.__acAgent.use(2010529803)).then(r=>JSON.stringify(r)) : 'no use'`).catch((e) => String(e));
log('vendorOpen', u);
await wait(2500); await shot('vendor');

log('errors', errs);
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
await browser.close();
