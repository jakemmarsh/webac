/**
 * probe-timeofday-pin — does acDebug.setTimeOfDay() actually STICK?
 *
 * The scene-capture harness (and tools/capture-*-ab.ts before it) pin time of
 * day so frames are lighting-comparable. But the first scene run produced a
 * `world-night` capture that was plainly daylight, so the pin is suspect.
 *
 * This samples skybox.currentTimeOfDay immediately after setting it and then
 * once a second, which distinguishes the two candidate causes:
 *   - value never applied        -> first sample already wrong
 *   - live day/night clock wins  -> first sample right, later samples drift
 *
 * Usage: npx tsx tools/probe-timeofday-pin.ts
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=todprobe';

async function main(): Promise<void> {
  const REMOTE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE) ? { executablePath: REMOTE } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());

  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // wait for world entry
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => {
      const cs = (window as any).acDebug?.collisionState?.();
      return !!(cs && cs.x > 0);
    });
    if (ok) break;
    await page.waitForTimeout(3000);
  }
  console.log('[tod] in world');
  await page.waitForTimeout(5000);

  for (const target of [0.0, 0.5, 0.25]) {
    const applied = await page.evaluate((t) => (window as any).acDebug?.setTimeOfDay?.(t), target);
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1000);
      samples.push(await page.evaluate(() => (window as any).__ac?.skybox?.currentTimeOfDay));
    }
    const drift = Math.abs((samples[samples.length - 1] ?? 0) - target);
    console.log(
      `[tod] set ${target.toFixed(2)} -> returned ${Number(applied).toFixed(4)} | ` +
      `samples ${samples.map((s) => Number(s).toFixed(4)).join(' ')} | ` +
      `drift after 8s ${drift.toFixed(4)} ${drift > 0.01 ? '*** PIN DOES NOT HOLD' : '(holds)'}`,
    );
  }

  // Does the option-driven daylight clamp explain it?
  const forced = await page.evaluate(() => ({
    forceDaylight: (window as any).__ac?.skybox?.forceDaylight,
    weatherEnabled: (window as any).__ac?.skybox?.isWeatherEnabled,
  }));
  console.log('[tod] skybox flags:', JSON.stringify(forced));

  // Does freezeTimeOfDay hold where setTimeOfDay did not?
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(0.0));
  const frozen: number[] = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1000);
    frozen.push(await page.evaluate(() => (window as any).__ac?.skybox?.currentTimeOfDay));
  }
  const fDrift = Math.max(...frozen.map((s) => Math.abs(Number(s) - 0.0)));
  console.log(`[tod] FROZEN at 0.00 | samples ${frozen.map((s) => Number(s).toFixed(4)).join(' ')} | max drift ${fDrift.toFixed(4)} ${fDrift > 0.01 ? '*** STILL DRIFTS' : '(holds)'}`);

  // Does the weather kill hold, or is it the same class of bug? The scene
  // harness turns weather OFF for every scene except world-weather, but the
  // world-night capture still showed falling specks.
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  const wx: Array<{ enabled: boolean; visibleWeatherMeshes: number }> = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1000);
    wx.push(await page.evaluate(() => {
      const sky = (window as any).__ac?.skybox;
      const entries = sky?.skyObjectEntries ?? [];
      return {
        enabled: !!sky?.isWeatherEnabled,
        visibleWeatherMeshes: entries.filter((e: any) => e.isWeather && e.mesh?.visible).length,
      };
    }));
  }
  const stuckOn = wx.some((w) => w.enabled || w.visibleWeatherMeshes > 0);
  console.log(`[wx] setWeatherEnabled(false) | ${wx.map((w) => `${w.enabled ? 'on' : 'off'}/${w.visibleWeatherMeshes}`).join(' ')} | ${stuckOn ? '*** WEATHER NOT SUPPRESSED' : '(suppressed)'}`);

  // What else could the falling specks be? Count live particle systems.
  const particles = await page.evaluate(() => {
    let systems = 0;
    (window as any).__ac?.sceneManager?.scene?.traverse((o: any) => {
      if (typeof o.name === 'string' && o.name.startsWith('particles_')) systems++;
    });
    return systems;
  });
  console.log(`[wx] live particle systems in scene: ${particles}`);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
