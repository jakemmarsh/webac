/**
 * probe-anim-hooks — DECOMP.anim-hooks-filtered live check. Every animation
 * hook type must reach CAnimHook::Execute (CSequence::execute_hooks @ 00524830
 * → process_hooks @ 00511550), not only sound + particle hooks.
 *
 * Patches PhysicsScriptPlayer.prototype (the same module instance the client
 * runs, via Vite's dev-server URL) to record every dispatched hook type per
 * anchor (named through the SOM) and every DefaultScript hook's resolved
 * PhysicsDesc script; spawns a monster beside the probe character, lets it
 * attack, screencasts it, then @smite all.
 * The probe character runs @god first so it survives long enough to draw
 * every maneuver (the gromnie's SpecialAttack1 0x100000cd carries the
 * DefaultScript hook → its PhysicsDesc BreatheLightning/Flame script).
 *
 *   npx tsx tools/probe-anim-hooks.ts [--create 1614] [--ms 20000] [--out verification/anim-hooks]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, adminCommand, shot } from './lib/game-session.js';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const WCID = arg('create') ?? '1614';
const MS = Number(arg('ms') ?? 20000);
const OUT = arg('out') ?? 'verification/anim-hooks';

const HOOK = `(async () => {
  const mod = await import('/src/effects/PhysicsScriptPlayer.ts');
  const som = window.__ac.serverObjectManager;
  const rec = window.__hk = { t0: performance.now(), byObj: {}, defaultScripts: [], emitters: 0 };
  const nameOf = (a) => { let o = a; while (o) { const s = som.objectForAnchor ? som.objectForAnchor(o) : null; if (s) return s.name + ' 0x' + (s.guid >>> 0).toString(16); o = o.parent; } return a.name || '?'; };
  const P = mod.PhysicsScriptPlayer.prototype;
  const origDispatch = P.dispatchHook;
  P.dispatchHook = function (hook, anchor) {
    if (hook) { const k = nameOf(anchor); const m = rec.byObj[k] = rec.byObj[k] || {}; m[hook.hookType] = (m[hook.hookType] || 0) + 1; }
    return origDispatch.call(this, hook, anchor);
  };
  const origDef = P.playDefaultScript;
  P.playDefaultScript = function (target) {
    const s = this.deps.resolveDefaultScript ? this.deps.resolveDefaultScript(target) : null;
    rec.defaultScripts.push({ t: Math.round(performance.now() - rec.t0), obj: nameOf(target), script: s ? '0x' + (s.id >>> 0).toString(16) : null, entries: s && s.scriptData ? s.scriptData.length : (s && s.hooks ? s.hooks.length : null) });
    return origDef.call(this, target);
  };
  rec.ramps = {}; rec._anchors = []; rec.partsSeen = {};
  // What the parts actually DRAW, sampled every 16 ms: the part's applied
  // translucency and whether/how opaque its materials render.
  const sample = () => {
    rec.ticks = (rec.ticks || 0) + 1;
    try { sampleOnce(); } catch (e) { rec.sampleError = String(e && e.stack || e).slice(0, 300); }
  };
  const sampleOnce = () => {
    for (const a of rec._anchors) for (const part of a.children) {
      if (!part.name.startsWith('part_')) continue;
      const k = nameOf(a) + ' ' + part.name;
      const r = rec.partsSeen[k] = rec.partsSeen[k] || { frames: 0, hiddenFrames: 0, minOpacity: 1, maxTranslucency: 0 };
      r.frames++;
      let hidden = false;
      part.traverse((n) => { if (!n.isMesh) return; for (const m of [].concat(n.material)) { if (!m.visible) hidden = true; else r.minOpacity = Math.min(r.minOpacity, +m.opacity.toFixed(3)); } });
      if (hidden) r.hiddenFrames++;
      r.maxTranslucency = Math.max(r.maxTranslucency, part.userData.acPartTranslucency || 0);
    }
  };
  setInterval(sample, 16);
  const origRamp = P.addRamp;
  P.addRamp = function (anchor, kind, from, to, time, part) {
    const k = nameOf(anchor) + ' ' + kind + (part ? ' part' + part : '') + ' ' + (+from).toFixed(2) + '>' + (+to).toFixed(2);
    rec.ramps[k] = (rec.ramps[k] || 0) + 1;
    if (kind === 'partTranslucency' && !rec._anchors.includes(anchor)) {
      rec._anchors.push(anchor);
      rec.anchorShape = rec.anchorShape || { name: anchor.name, type: anchor.type, children: anchor.children.map((c) => c.name + ':' + c.type).slice(0, 24) };
    }
    return origRamp.apply(this, arguments);
  };
  const origCreate = P.createParticleEmitter;
  P.createParticleEmitter = function (...a) { rec.emitters++; return origCreate.apply(this, a); };
  return 'hooked ' + typeof origDispatch + ' ' + typeof origDef;
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'probe-anim-hooks', settleMs: 5000, createCharacter: arg('create-char') });
  const { page } = s;
  console.log(await page.evaluate(HOOK));
  await adminCommand(page, '@god');
  await page.waitForTimeout(2000);
  await adminCommand(page, `@create ${WCID}`);
  const frames: string[] = [];
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < MS) {
    await page.waitForTimeout(5000);
    const f = `${OUT}/frame-${String(i++).padStart(2, '0')}.png`;
    await shot(page, f);
    frames.push(f);
  }
  const res = await page.evaluate("JSON.stringify(window.__hk, (k, v) => k === '_anchors' ? undefined : v)") as string;
  writeFileSync(`${OUT}/report.json`, JSON.stringify(JSON.parse(res), null, 2));
  console.log(res);
  await adminCommand(page, '@smite all');
  await page.waitForTimeout(2000);
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
