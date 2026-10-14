/**
 * remaster-probe — hold one logged-in game page open and run commands dropped
 * into a folder, for iterating on the opt-in remaster renderer (docs/remaster.md).
 *
 *   AC_URL='http://localhost:3017/?ace&bridge=ws://localhost:9098&account=X&password=X&remaster' \
 *     npx tsx tools/remaster-probe.ts <dir> [--gpu]
 *
 * Drop `<dir>/<name>.js` (page JS; its value is written to `<name>.out`) or
 * `<dir>/<name>.shot` (a screenshot to `<name>.png`). `<dir>/stop` ends it.
 * A Vite reload re-enters the world on its own (the URL logs in).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { enterWorld, IN_WORLD_JS, isTrue, sessionArgs } from './lib/game-session.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: remaster-probe.ts <dir> [--gpu]');
mkdirSync(dir, { recursive: true });

const { browser, page } = await enterWorld({ ...sessionArgs(), cb: 'remaster-probe', viewport: { width: 1568, height: 775 }, settleMs: 5000 });
page.on('console', (m) => { const t = m.text(); if (/Shader Error|ERROR:|remaster/i.test(t)) console.log(`[page] ${t.slice(0, 400)}`); });
console.log(`[probe] in world; watching ${dir}`);
writeFileSync(join(dir, 'ready'), String(Date.now()));

for (;;) {
  if (existsSync(join(dir, 'stop'))) break;
  for (const f of readdirSync(dir).sort()) {
    const path = join(dir, f);
    if (f.endsWith('.js')) {
      const name = f.slice(0, -3);
      let out: string;
      try {
        await page.waitForFunction(IN_WORLD_JS, undefined, { timeout: 180_000 });
        const v = await page.evaluate(readFileSync(path, 'utf8'));
        out = typeof v === 'string' ? v : (JSON.stringify(v, null, 1) ?? String(v));
      } catch (e) { out = `ERROR ${(e as Error).message}`; }
      writeFileSync(join(dir, `${name}.out`), out);
      renameSync(path, `${path}.done`);
    } else if (f.endsWith('.shot')) {
      const name = f.slice(0, -5);
      if (await isTrue(page, IN_WORLD_JS)) await page.screenshot({ path: join(dir, `${name}.png`) });
      renameSync(path, `${path}.done`);
    }
  }
  await page.waitForTimeout(300);
}
await browser.close();
