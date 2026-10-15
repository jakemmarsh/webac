/**
 * probe-rain-visibility — how much the Rainy day group's rain domes add to the frame
 * (BUG.rain-invisible-thunder-audible: thunder heard, no rain seen).
 *
 * Logs in, pins a Rainy day group, freezes the time of day, and captures the same view
 * with the weather gate on and off (acDebug.setWeatherEnabled). Reports the mean absolute
 * per-channel difference and the share of pixels that changed by more than 8/255, for a
 * night time inside a thunder window and for noon. Run it against the code under test and
 * against the old code to compare.
 *
 * Usage: AC_URL='http://localhost:<vite>/?ace&bridge=ws://localhost:<bridge>&account=<a>&password=<a>' \
 *   npx tsx tools/probe-rain-visibility.ts [outDir]
 * The account's character must stand outdoors. Uses a real GPU (headful) window.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const URL = process.env.AC_URL;
if (!URL) throw new Error('set AC_URL');
const OUT = process.argv[2] ?? '/tmp/rain-probe';
const TIMES: Array<[string, number]> = [['night-thunder', 0.95], ['noon', 0.5]];

function diff(a: Buffer, b: Buffer): { mean: number; changed: number } {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  let sum = 0, changed = 0;
  const n = pa.width * pa.height;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(pa.data[i * 4 + c] - pb.data[i * 4 + c]));
    sum += d;
    if (d > 8) changed++;
  }
  return { mean: sum / n, changed: changed / n };
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const cs = (window as any).acDebug?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: false, args: ['--ignore-gpu-blocklist', '--window-size=1290,860'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    page.setDefaultTimeout(120_000);
    page.on('dialog', (d) => void d.dismiss());
    // The sky's own log from page load: which day group the login built first, and any re-roll.
    const skyLog: string[] = [];
    page.on('console', (m) => { const t = m.text(); if (/^\[(Sky|Weather)\]/.test(t)) skyLog.push(t); });
    await page.goto(URL!, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline && !(await inWorld(page))) await page.waitForTimeout(2000);
    if (!(await inWorld(page))) throw new Error('never entered the world (at character select? enter it once by hand)');
    await page.waitForTimeout(8000);
    console.log(`sky log at login:\n  ${skyLog.join('\n  ')}`);
    const before = await page.evaluate(() => (window as any).acDebug.dayGroup());
    console.log(`live day group: "${before.name}" #${before.index} (day ${before.absoluteDay})`);
    const pin = await page.evaluate(() => (window as any).acDebug.pinDayGroup('Rainy'));
    console.log(`pinned: ${JSON.stringify(pin)}`);
    await page.waitForTimeout(5000);
    const report: Record<string, unknown> = { liveDayGroup: before.name, pinned: pin.name };
    const objs = await page.evaluate(() => (window as any).acDebug.skyObjects());
    console.log(`sky objects after the pin: ${objs.objects.map((o: any) => o.gfxId + '/' + o.properties).join(' ')}`);
    for (const o of objs.objects.filter((x: any) => (parseInt(x.properties, 16) & 0x4) !== 0)) console.log(`weather ${o.gfxId}: ${JSON.stringify(o.meshes)}`);
    report.skyObjects = objs.objects;
    for (const [label, t] of TIMES) {
      await page.evaluate((tt) => (window as any).acDebug.freezeTimeOfDay(tt), t);
      // Three on/off pairs; the smallest difference wins, so a spell effect or a passer-by
      // landing in one pair can't inflate the result.
      let best: { mean: number; changed: number } | null = null;
      for (let k = 0; k < 3; k++) {
        await page.evaluate(() => (window as any).acDebug.setWeatherEnabled(true));
        await page.waitForTimeout(1500);
        const on = await page.screenshot({ type: 'png' });
        await page.evaluate(() => (window as any).acDebug.setWeatherEnabled(false));
        await page.waitForTimeout(1500);
        const off = await page.screenshot({ type: 'png' });
        writeFileSync(`${OUT}/${label}-${k}-weather-on.png`, on);
        writeFileSync(`${OUT}/${label}-${k}-weather-off.png`, off);
        const d = diff(on, off);
        if (!best || d.mean < best.mean) best = d;
      }
      report[label] = best;
      console.log(`${label} (t=${t}): mean |Δ| ${best!.mean.toFixed(2)}/255, ${(best!.changed * 100).toFixed(1)}% of pixels changed > 8 (min of 3 pairs)`);
    }
    await page.evaluate(() => (window as any).acDebug.setWeatherEnabled(true));
    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
