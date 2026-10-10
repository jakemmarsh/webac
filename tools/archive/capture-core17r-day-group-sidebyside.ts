/**
 * CORE.17.r — live evidence for the sky day-group determinism fix.
 *
 * Two headless sessions against the local ACE stack (SwiftShader). In each:
 * enter the world, weather off, time of day frozen at noon, @telepoi
 * holtburg, yaw 0 — exactly the `capture-ui-screens.ts --scenes
 * world-town-day` setup — then:
 *   1. read acDebug.dayGroup() UNPINNED and check the live index against the
 *      retail SkyDesc::CalcPresentDayGroup hash of the server clock's
 *      absolute day (retailDayGroupIndex / absoluteDayFromClock, the same
 *      exports the renderer uses, fed the live gameClock);
 *   2. screenshot unpinned, then pinned "Sunny" (the harness default);
 *   3. session A also pins "Cloudy" and "Rainy" (+ weather on) to show the
 *      pin really swaps the sky, and then unpins.
 * Pixel metrics (sky band mean RGB, fraction of differing pixels) are
 * computed in-browser; the composite is
 * verification/core17r/core17r-day-group-sidebyside.png.
 *
 * Usage: npx tsx tools/capture-core17r-day-group-sidebyside.ts [--compose-only]
 * Requires: vite (:3000), ws-tcp-bridge (:9090), the ACE stack; nothing else
 * logged in as testacjs.
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retailDayGroupIndex, absoluteDayFromClock, aceEmuTicksNow } from '../../packages/renderer/src/effects/SkyboxRenderer.js';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17r');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const RAWG07 = join(REPO, 'reference/images/hud/rawg_07.jpg');
const J_BEFORE = join(REPO, 'verification/core17j/before-world-town-day.png');
const J_AFTER = join(REPO, 'verification/core17j/after-world-town-day.png');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const TAG = '[core17r]';
const EOL_GT = { zeroTimeOfYear: 3600, zeroYear: 10, dayLength: 7620, daysPerYear: 360 };

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}
const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}
async function driveCharacterCreate(page: Page, name: string): Promise<string> {
  return ev<string>(page, `(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = ${JSON.stringify(name)};
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`);
}
async function enterWorld(page: Page, tag: string): Promise<void> {
  console.log(`${TAG} ${tag}: navigating`);
  await page.goto(`${URL}&cb=r${tag}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, `_login-failed-${tag}.png`) }); throw new Error('never entered world'); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await driveCharacterCreate(page, 'Sky Tester').catch(() => 'error');
      if (r === 'sent') { console.log(`${TAG} ${tag}: character creation submitted`); lastReload = Date.now(); }
      lastCreate = Date.now();
    }
    if (Date.now() - lastReload > 90_000) {
      console.log(`${TAG} ${tag}: not in world yet — reloading (phantom-session retry)`);
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
}

interface DayGroupState { name: string; index: number; absoluteDay: number; gameClock: number | null; pinned: boolean; groups: Array<{ index: number; name: string; chanceOfOccur: number }> }
interface SessionState {
  tag: string; wallTicks: number; unpinned: DayGroupState; timeOfDay: unknown;
  expectedFromClock: { absoluteDay: number; index: number; name: string } | null;
  clockMinusWall: number | null;
  pins: Record<string, { ok: boolean; name: string; index: number; pinned: boolean }>;
  skyObjects: Record<string, { count: number; visibleWeather: number }>;
}

async function session(tag: string, extraPins: boolean): Promise<SessionState> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120_000);
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (msg) => { const t = msg.text(); if (/\[Sky\]|rror/.test(t)) console.log(`  [page ${tag}] ${t.slice(0, 160)}`); });
  await enterWorld(page, tag);
  await ev(page, `window.__ac.skybox.setWeatherEnabled(false)`);
  await ev(page, `window.acDebug.freezeTimeOfDay(0.5)`);
  await ev(page, `window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(12_000);
  await page.waitForFunction(() => !document.getElementById('portal-spew-box'), undefined, { timeout: 20_000 }).catch(() => {});
  await ev(page, `window.acDebug.setPlayerYaw(0)`);
  await page.waitForTimeout(6000);

  const wallTicks = aceEmuTicksNow();
  const unpinned = await ev<DayGroupState>(page, `window.acDebug.dayGroup()`);
  const timeOfDay = await ev<unknown>(page, `window.acDebug.timeOfDay()`);
  let expected: SessionState['expectedFromClock'] = null;
  let clockMinusWall: number | null = null;
  if (typeof unpinned.gameClock === 'number') {
    const day = absoluteDayFromClock(unpinned.gameClock, EOL_GT);
    const idx = retailDayGroupIndex(day, unpinned.groups.length);
    expected = { absoluteDay: day, index: idx, name: unpinned.groups[idx]?.name ?? '?' };
    clockMinusWall = unpinned.gameClock - wallTicks;
  }
  console.log(`${TAG} ${tag}: UNPINNED live day group "${unpinned.name}" #${unpinned.index} day ${unpinned.absoluteDay} clock ${unpinned.gameClock}; retail hash of the clock → ${expected ? `#${expected.index} "${expected.name}" day ${expected.absoluteDay}` : 'n/a'}; clock − wall ${clockMinusWall?.toFixed(1)} s`);
  const shot = async (file: string) => { await page.screenshot({ path: join(OUT, file) }); console.log(`${TAG} ${tag}: ${file}`); };
  const skyObjects = async () => ev<{ count: number; visibleWeather: number }>(page, `(() => { const s = window.acDebug.skyObjects(); return { count: s.count, visibleWeather: (s.objects || []).filter((o) => o.visible && (parseInt(o.properties, 16) & 4)).length }; })()`);
  await shot(`unpinned-${tag}.png`);
  const pins: SessionState['pins'] = {};
  const skyObj: SessionState['skyObjects'] = { unpinned: await skyObjects() };
  const pin = async (which: string | number, file: string) => {
    pins[String(which)] = await ev(page, `window.acDebug.pinDayGroup(${JSON.stringify(which)})`);
    await page.waitForTimeout(4000);
    skyObj[String(which)] = await skyObjects();
    console.log(`${TAG} ${tag}: pin ${which} → ${JSON.stringify(pins[String(which)])} sky objects ${JSON.stringify(skyObj[String(which)])}`);
    await shot(file);
  };
  await pin('Sunny', `pinned-sunny-${tag}.png`);
  if (extraPins) {
    await pin('Cloudy', `pinned-cloudy-${tag}.png`);
    await ev(page, `window.__ac.skybox.setWeatherEnabled(true)`);
    await pin('Rainy', `pinned-rainy-weather-${tag}.png`);
    await ev(page, `window.__ac.skybox.setWeatherEnabled(false)`);
    const un = await ev<{ ok: boolean; pinned: boolean }>(page, `window.acDebug.pinDayGroup(null)`);
    console.log(`${TAG} ${tag}: unpin → ${JSON.stringify(un)}`);
  }
  await browser.close();
  return { tag, wallTicks, unpinned, timeOfDay, expectedFromClock: expected, clockMinusWall, pins, skyObjects: skyObj };
}

const CSS = `<style>body{margin:0;background:#111;color:#ddd;font:13px/1.35 system-ui}h1{font-size:15px;margin:8px 10px}.row{display:flex;gap:8px;padding:0 8px}.cell{background:#000;flex:1}.lbl{font-size:11px;color:#bbb;padding:3px 4px;min-height:58px}.full img{width:100%}table{border-collapse:collapse;margin:6px 10px}td,th{border:1px solid #444;padding:2px 8px;font-size:12px}</style>`;
const dataUrl = (f: string) => `data:image/${f.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${readFileSync(f).toString('base64')}`;

/** Sky-band (y 0..120, x 0..1568 — above the tree line at yaw 0) mean RGB + the pixel diff vs another frame.
 *  Source passed as a STRING: tsx/esbuild injects a `__name` helper into function
 *  bodies handed to page.evaluate, which the page does not have. */
async function metrics(page: Page, a: string, b: string | null): Promise<{ mean: number[]; diffFrac: number | null; maxDelta: number | null }> {
  const src = `(async () => {
    const ua = ${JSON.stringify(dataUrl(a))}; const ub = ${b ? JSON.stringify(dataUrl(b)) : 'null'};
    const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
    const ia = await load(ua);
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
    const ctx = c.getContext('2d'); ctx.drawImage(ia, 0, 0);
    const H = Math.min(120, ia.height);
    const da = ctx.getImageData(0, 0, ia.width, H).data;
    const mean = [0, 0, 0]; const n = ia.width * H;
    for (let i = 0; i < da.length; i += 4) { mean[0] += da[i]; mean[1] += da[i + 1]; mean[2] += da[i + 2]; }
    const out = { mean: mean.map((v) => Math.round(v / n)), diffFrac: null, maxDelta: null };
    if (ub) {
      const ib = await load(ub);
      ctx.drawImage(ib, 0, 0);
      const db = ctx.getImageData(0, 0, ia.width, H).data;
      let diff = 0, mx = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
        if (d > 3) diff++; if (d > mx) mx = d;
      }
      out.diffFrac = diff / n; out.maxDelta = mx;
    }
    return out;
  })()`;
  return page.evaluate(src) as Promise<{ mean: number[]; diffFrac: number | null; maxDelta: number | null }>;
}

async function compose(): Promise<void> {
  const st = JSON.parse(readFileSync(join(OUT, 'live-state.json'), 'utf8')) as { A: SessionState; B: SessionState };
  const files = {
    unA: join(OUT, 'unpinned-A.png'), unB: join(OUT, 'unpinned-B.png'),
    sunA: join(OUT, 'pinned-sunny-A.png'), sunB: join(OUT, 'pinned-sunny-B.png'),
    cloudyA: join(OUT, 'pinned-cloudy-A.png'), rainyA: join(OUT, 'pinned-rainy-weather-A.png'),
  };
  for (const f of [WINE, RAWG07, ...Object.values(files)]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2600, height: 1800 } });
  await page.setContent('<html><body></body></html>');
  const m = {
    unA: await metrics(page, files.unA, files.unB),
    sunA: await metrics(page, files.sunA, files.sunB),
    sunB: await metrics(page, files.sunB, null),
    cloudyA: await metrics(page, files.cloudyA, files.sunA),
    rainyA: await metrics(page, files.rainyA, files.sunA),
    jBefore: existsSync(J_BEFORE) ? await metrics(page, J_BEFORE, J_AFTER) : null,
    jAfter: existsSync(J_AFTER) ? await metrics(page, J_AFTER, null) : null,
    wine: await metrics(page, WINE, null),
  };
  // The real harness, run twice: run1/run2 before the cloud-scroll reset
  // (same pinned group, blue both times, but the cloud UV phase differed),
  // run3/run4 after freezeTimeOfDay() also zeroes cloudUvTime.
  const H = (n: number, scene = 'world-town-day') => join(OUT, 'harness', `run${n}-${scene}.png`);
  const harness = {
    pre: existsSync(H(1)) && existsSync(H(2)) ? await metrics(page, H(1), H(2)) : null,
    post: existsSync(H(3)) && existsSync(H(4)) ? await metrics(page, H(3), H(4)) : null,
    weatherPost: existsSync(H(4, 'world-weather')) && existsSync(H(1, 'world-weather')) ? await metrics(page, H(4, 'world-weather'), H(1, 'world-weather')) : null,
  };
  Object.assign(m, { harness });
  writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(m, null, 2));
  console.log(`${TAG} metrics ${JSON.stringify(m)}`);
  const rgb = (x: { mean: number[] } | null) => x ? `(${x.mean.join(',')})` : 'n/a';
  const pct = (x: { diffFrac: number | null; maxDelta: number | null } | null) => x && x.diffFrac !== null ? `${(x.diffFrac * 100).toFixed(2)} % of sky pixels differ (max Δ ${x.maxDelta})` : 'n/a';
  const A = st.A, B = st.B;
  const clockLine = (s: SessionState) => `unpinned live "${s.unpinned.name}" #${s.unpinned.index} (day ${s.unpinned.absoluteDay}); retail hash of the server clock ${s.unpinned.gameClock?.toFixed(0)} → #${s.expectedFromClock?.index} "${s.expectedFromClock?.name}" (day ${s.expectedFromClock?.absoluteDay}); clock − wall ${s.clockMinusWall?.toFixed(1)} s`;
  await page.setContent(`${CSS}
    <h1>CORE.17.r — the sky's day group is the retail hash of the server day (SkyDesc::CalcPresentDayGroup @ 00500e10), not a per-session Math.random() roll; the scene harness pins it. Two sessions, noon frozen, weather off, Holtburg yaw 0 (SwiftShader).</h1>
    <table><tr><th>frame</th><th>sky band mean RGB (y 0..120)</th><th>vs</th></tr>
      <tr><td>CORE.17.j before (2026-09-08, the BLUE run)</td><td>${rgb(m.jBefore)}</td><td>vs the .j after run: ${pct(m.jBefore)}</td></tr>
      <tr><td>CORE.17.j after (five minutes later, the OVERCAST run)</td><td>${rgb(m.jAfter)}</td><td></td></tr>
      <tr><td>ours session A unpinned</td><td>${rgb(m.unA)}</td><td>vs session B unpinned: ${pct(m.unA)} — same server day → same hashed group</td></tr>
      <tr><td>ours session A pinned Sunny (#0, the harness default)</td><td>${rgb(m.sunA)}</td><td>vs session B pinned Sunny: ${pct(m.sunA)}</td></tr>
      <tr><td>ours session B pinned Sunny</td><td>${rgb(m.sunB)}</td><td></td></tr>
      <tr><td>ours session A pinned Cloudy</td><td>${rgb(m.cloudyA)}</td><td>vs A Sunny: ${pct(m.cloudyA)} — the pin swaps the sky</td></tr>
      <tr><td>ours session A pinned Rainy + weather on</td><td>${rgb(m.rainyA)}</td><td>vs A Sunny: ${pct(m.rainyA)}; weather sky objects visible: ${A.skyObjects['Rainy']?.visibleWeather ?? '?'}</td></tr>
      <tr><td>retail EoL client under Wine, Holtburg</td><td>${rgb(m.wine)}</td><td>(1024x768, its own day group, pale sky)</td></tr>
      <tr><td>the REAL harness, world-town-day run 1 vs run 2 (group pinned "Sunny", BEFORE the cloud-scroll reset)</td><td>${rgb(harness.pre)}</td><td>${pct(harness.pre)} — same group, cloud UV phase differed per login</td></tr>
      <tr><td>the REAL harness, world-town-day run 3 vs run 4 (freezeTimeOfDay also zeroes cloudUvTime)</td><td>${rgb(harness.post)}</td><td>${pct(harness.post)}</td></tr>
      <tr><td>the REAL harness, world-weather run 4 vs run 1 (group pinned "Rainy" + weather)</td><td>${rgb(harness.weatherPost)}</td><td>${pct(harness.weatherPost)} (run 1 predates the cloud reset)</td></tr>
    </table>
    <div style="margin:0 10px;font-size:12px">session A: ${clockLine(A)}<br/>session B: ${clockLine(B)}</div>
    <h1>whole screen: retail EoL client (Wine 1024x768) | retail rawg_07.jpg | ours A pinned Sunny | ours B pinned Sunny (separate session)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine, Holtburg</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">retail rawg_07.jpg</div><img src="${dataUrl(RAWG07)}"/></div>
      <div class="cell"><div class="lbl">ours, session A, day group pinned "Sunny" #0 (the harness default), noon frozen, weather off</div><img src="${dataUrl(files.sunA)}"/></div>
      <div class="cell"><div class="lbl">ours, session B, the same pin — a separate login</div><img src="${dataUrl(files.sunB)}"/></div>
    </div>
    ${existsSync(H(3)) && existsSync(H(4)) ? `<h1>the real harness after the fix: world-town-day run 3 | run 4 (separate logins, both "Sunny" #0, noon frozen, cloud scroll zeroed) | world-weather run 4 ("Rainy" #3 pinned, weather on)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">capture-ui-screens.ts --scenes world-town-day, run 3</div><img src="${dataUrl(H(3))}"/></div>
      <div class="cell"><div class="lbl">the same, run 4 — a separate login</div><img src="${dataUrl(H(4))}"/></div>
      <div class="cell"><div class="lbl">world-weather, run 4 — the Rainy pin makes the DAT rain domes exist; before CORE.17.r this scene had rain only when the session rolled Rainy</div>${existsSync(H(4, 'world-weather')) ? `<img src="${dataUrl(H(4, 'world-weather'))}"/>` : ''}</div>
      <div class="cell"><div class="lbl">world-town-day run 1 (BEFORE the cloud-scroll reset): same group, different cloud phase</div>${existsSync(H(1)) ? `<img src="${dataUrl(H(1))}"/>` : ''}</div>
    </div>` : ''}
    <h1>the pin swaps the sky: ours A unpinned (live hash "${A.unpinned.name}" #${A.unpinned.index}) | pinned Cloudy | pinned Rainy + weather on | CORE.17.j's overcast run (the symptom)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">ours A unpinned — the live hashed group "${A.unpinned.name}" #${A.unpinned.index}</div><img src="${dataUrl(files.unA)}"/></div>
      <div class="cell"><div class="lbl">ours A pinned "Cloudy" (#12)</div><img src="${dataUrl(files.cloudyA)}"/></div>
      <div class="cell"><div class="lbl">ours A pinned "Rainy" (#3) with the weather gate on — the DAT rain domes exist only in a Rainy group</div><img src="${dataUrl(files.rainyA)}"/></div>
      <div class="cell"><div class="lbl">CORE.17.j after-world-town-day.png (2026-09-08): the overcast run that filed this task</div>${existsSync(J_AFTER) ? `<img src="${dataUrl(J_AFTER)}"/>` : ''}</div>
    </div>`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17r-day-group-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote ${join(OUT, 'core17r-day-group-sidebyside.png')}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!process.argv.includes('--compose-only')) {
    const A = await session('A', true);
    const B = await session('B', false);
    writeFileSync(join(OUT, 'live-state.json'), JSON.stringify({ A, B }, null, 2));
  }
  await compose();
}
main().catch((e) => { console.error(e); process.exit(1); });
