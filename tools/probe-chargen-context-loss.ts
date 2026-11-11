/**
 * probe-chargen-context-loss — does character creation still draw its 3D preview after a WebGL context
 * loss at character select? (2026-11-11 monitor: an Edge player lost the context at char select while the
 * tab was hidden, later opened chargen on the same page and reloaded on the appearance step.)
 * Loses every WebGL context on the page through WEBGL_lose_context at char select, restores it after
 * 2 s, opens Create Character, and screenshots it; MODE=baseline skips the loss.
 * MODE=world: enter the world, screenshot, lose + restore the context, wait, screenshot again (the
 * 2026-11-11 11:00Z loss was in the world on Intel UHD / Edge).
 * Usage: AC_BASE=http://localhost:5393/ AC_ACCOUNT=testacjs3 npx tsx tools/probe-chargen-context-loss.ts [--gpu]
 */
import { openSession, gameUrl, sessionArgs, waitForCharSelect, enterWorld } from './lib/game-session.js';

const MODE = process.env.MODE ?? 'loss';
const OUT = process.env.OUT ?? `/tmp/chargen-ctx-${MODE}`;

async function world(): Promise<void> {
  const { browser, page } = await enterWorld({ ...sessionArgs() });
  try {
    await page.waitForTimeout(8000);
    await page.screenshot({ path: `${OUT}-before.png` });
    const r = await page.evaluate(`(async () => {
      const c = document.querySelector('#game-canvas'); const gl = c.getContext('webgl2');
      const ext = gl.getExtension('WEBGL_lose_context'); ext.loseContext();
      await new Promise((r) => setTimeout(r, 2000)); ext.restoreContext();
      await new Promise((r) => setTimeout(r, 8000));
      return { lost: gl.isContextLost(), health: { l: window.__acHealth.webglLost, r: window.__acHealth.webglRestored } };
    })()`);
    console.log('world context loss:', JSON.stringify(r));
    await page.screenshot({ path: `${OUT}-after.png` });
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  if (MODE === 'world') return world();
  const { browser, page } = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(gameUrl({ autoenter: false, cb: `ctx-${MODE}` }), { waitUntil: 'domcontentloaded' });
    await waitForCharSelect(page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
    await page.waitForTimeout(2000);
    if (MODE === 'loss') {
      const lost = await page.evaluate(`(async () => {
        const exts = [];
        for (const c of document.querySelectorAll('canvas')) {
          const gl = c.getContext('webgl2') || c.getContext('webgl');
          const ext = gl && gl.getExtension('WEBGL_lose_context');
          if (ext && !gl.isContextLost()) { ext.loseContext(); exts.push(ext); }
        }
        await new Promise((r) => setTimeout(r, 2000));
        for (const e of exts) e.restoreContext();
        await new Promise((r) => setTimeout(r, 1000));
        return { lost: exts.length, health: window.__acHealth ? { l: window.__acHealth.webglLost, r: window.__acHealth.webglRestored } : null };
      })()`);
      console.log('context loss:', JSON.stringify(lost));
    }
    await page.evaluate(`window.__ac.gameUI.showCharacterCreate()`);
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${OUT}-heritage.png` });
    const info = await page.evaluate(`(() => {
      const cs = [...document.querySelectorAll('canvas')].filter((c) => c.offsetWidth > 0).map((c) => {
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        return { w: c.width, h: c.height, gl: !!gl, lost: gl ? gl.isContextLost() : null, cls: c.className || c.id };
      });
      return { canvases: cs, step: window.__ac.gameUI.wizard?.step ?? null, health: window.__acHealth ?? null };
    })()`);
    console.log('after chargen:', JSON.stringify(info));
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
