/**
 * BUG.agent-inside-building-outdoor-cell probe: Holtburg building 0x01000827
 * at 0xA9B3 (180, 84, 116) has an exterior notch at local (2.2..3.5, -5.75..-4.9)
 * where a player reported being "sealed in". Teleloc to each START (block-local
 * AC metres), run toward GOAL with W held, then try to walk back out to START.
 * OUT=<dir> AC_ACCOUNT=<own probe account> AC_BASE/AC_BRIDGE as usual.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collisionState, enterWorld, sessionArgs, shot, teleloc } from './lib/game-session.js';
const OUT = process.env.OUT ?? 'verification/building-notch';
const BLOCK = 0xa9b3;
const GOAL = { x: 182.7, y: 78.4 };
const STARTS = [
  { label: 'south', x: 182.7, y: 72.0 },
  { label: 'southeast', x: 188.0, y: 73.0 },
  { label: 'east', x: 190.0, y: 78.4 },
  { label: 'southwest', x: 178.0, y: 73.0 },
];
const cellOf = (x: number, y: number): string =>
  '0x' + (((BLOCK << 16) | (Math.floor(x / 24) * 8 + Math.floor(y / 24) + 1)) >>> 0).toString(16).toUpperCase().padStart(8, '0');
const world = (x: number, y: number) => ({ wx: (BLOCK >> 8) * 192 + x, wz: (BLOCK & 0xff) * 192 + y });
const local = (p: { x: number; z: number; feetY?: number }) => ({ x: +(p.x - (BLOCK >> 8) * 192).toFixed(2), y: +(p.z - (BLOCK & 0xff) * 192).toFixed(2), feet: +(p.feetY ?? 0).toFixed(2) });
/** The building's collision sources registered with outdoor collision (collisionKey.building). */
const BLDG_KEYS = `[...window.__ac.outdoorCollision.cells.keys()].filter(k => String(k).startsWith('bl:${BLOCK}:'))`;

async function runToward(page: import('playwright').Page, x: number, y: number, ms: number) {
  const { wx, wz } = world(x, y);
  await page.evaluate(`(() => { const cc = window.__ac.cameraController; const cs = window.acDebug.collisionState();
    cc.playerYaw = Math.atan2(-(${wx} - cs.x), -(${wz} - cs.z)); })()`);
  await page.waitForTimeout(300);
  await page.evaluate(`window.__ac.cameraController.simulateKeyDown('KeyW')`);
  const track: Array<{ x: number; y: number }> = [];
  for (let t = 0; t < ms; t += 250) { await page.waitForTimeout(250); track.push(local(await collisionState(page))); }
  await page.evaluate(`window.__ac.cameraController.simulateKeyUp('KeyW')`);
  await page.waitForTimeout(500);
  return track;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const out: unknown[] = [];
  const { browser, page } = await enterWorld({ ...sessionArgs(), createCharacter: process.env.AC_CHAR_NAME ?? 'Notchprobe', timeoutMs: 300_000 });
  await page.waitForTimeout(6000);
  for (const s of STARTS) {
    await teleloc(page, `${cellOf(s.x, s.y)} [${s.x} ${s.y} 117] 1 0 0 0`, 12_000);
    const keys = await page.evaluate(BLDG_KEYS) as string[];
    const inbound = await runToward(page, GOAL.x, GOAL.y, 4000);
    const mid = await collisionState(page);
    await shot(page, join(OUT, `${s.label}-in.png`));
    const outbound = await runToward(page, s.x, s.y, 4000);
    const end = await collisionState(page);
    const r = { start: s, bldgKeys: keys, in: local(mid), inCell: (mid as any).cellId, out: local(end), outCell: (end as any).cellId, inbound, outbound };
    console.log(s.label, 'bldgKeys', keys.length, JSON.stringify({ in: r.in, inCell: r.inCell, out: r.out, outCell: r.outCell }));
    out.push(r);
  }
  writeFileSync(join(OUT, 'probe.json'), JSON.stringify(out, null, 1));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
