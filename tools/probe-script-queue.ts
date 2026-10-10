/**
 * probe-script-queue — DECOMP.scripts-not-queued live check. Scripts sent to
 * one object play back to back: ScriptManager::AddScriptInternal @ 0051b310
 * starts a new script at prev.start + prev.script.length (the last sorted
 * hook's time), or now when the queue is empty.
 *
 * Patches PhysicsScriptPlayer.prototype (the module instance the client runs,
 * via Vite's dev-server URL) to record, per anchor, every play() call: the
 * queue start the player assigned, the object clock at the call, and the
 * previous queued script's start + length. Then `@buff`s the probe character
 * (a burst of spell PlayScripts on one object) and checks every queued start
 * equals the previous script's end.
 *
 *   npx tsx tools/probe-script-queue.ts [--cmd "@buff"] [--ms 15000] [--out verification/script-queue]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, adminCommand, shot } from './lib/game-session.js';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const CMD = arg('cmd') ?? '@buff';
const MS = Number(arg('ms') ?? 15000);
const OUT = arg('out') ?? 'verification/script-queue';

const HOOK = `(async () => {
  const mod = await import('/src/effects/PhysicsScriptPlayer.ts');
  const rec = window.__sq = { plays: [] };
  const P = mod.PhysicsScriptPlayer.prototype;
  const origPlay = P.play;
  P.play = function (script, anchor) {
    const st = this.states.get(anchor);
    const last = st && st.scripts.length ? st.scripts[st.scripts.length - 1] : null;
    const clock = st ? st.clock : 0;
    const expect = last ? last.start + last.length : clock;
    const queuedBefore = st ? st.scripts.length : 0;
    origPlay.call(this, script, anchor);
    const st2 = this.states.get(anchor);
    const mine = st2 ? st2.scripts.find((d) => d.script === script) : null;
    rec.plays.push({ anchor: anchor.uuid, name: anchor.name || '', id: '0x' + (script.id >>> 0).toString(16),
      clock: +clock.toFixed(3), queuedBefore, expect: +expect.toFixed(3),
      start: mine ? +mine.start.toFixed(3) : null, length: mine ? +mine.length.toFixed(3) : null });
  };
  return true;
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'probe-script-queue', settleMs: 5000, createCharacter: arg('create-char') ?? 'Scriptqueue' });
  const { page } = s;
  await page.evaluate(HOOK);
  await adminCommand(page, CMD);
  await page.waitForTimeout(1500);
  await shot(page, `${OUT}/during.png`);
  await page.waitForTimeout(MS);
  const rec = await page.evaluate('window.__sq') as { plays: Array<{ anchor: string; queuedBefore: number; expect: number; start: number | null }> };
  const queued = rec.plays.filter((p) => p.queuedBefore > 0);
  const bad = queued.filter((p) => p.start === null || Math.abs(p.start - p.expect) > 1e-3);
  const perAnchor = new Map<string, number>();
  for (const p of rec.plays) perAnchor.set(p.anchor, (perAnchor.get(p.anchor) ?? 0) + 1);
  const summary = { cmd: CMD, plays: rec.plays.length, anchors: perAnchor.size, maxPerAnchor: Math.max(0, ...perAnchor.values()),
    queuedBehindAnother: queued.length, startMismatches: bad.length };
  writeFileSync(`${OUT}/result.json`, JSON.stringify({ summary, plays: rec.plays }, null, 2));
  console.log(JSON.stringify(summary));
  await s.browser.close();
  process.exit(bad.length === 0 && queued.length > 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
