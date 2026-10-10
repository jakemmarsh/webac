/**
 * probe-sweepb-world — live checks for the SWEEP1006B world-objects fixes,
 * one client against ACE:
 *  radius.noncreature  every non-creature server object with a Setup (chests,
 *                      doors, portals, lifestones…) reports Setup radius/height
 *                      × ObjScale to MoveTo (targetInfo), not 0
 *                      (CPartArray::GetRadius/GetHeight @ 005180a0/005180b0)
 *  radius.creature     creatures report Setup radius/height × ObjScale (no 0.3 fallback)
 *  radius.rescale      a live ObjScale change (setObjectScale) rescales the cylinder
 *  anim.dungeon        cell 0x00110170's stab 0x02001027 loops DefaultAnimation
 *                      0x030009E3 (CPhysicsObj::animate_static_object @ 00513df0)
 *  anim.scenery        Holtburg-area DAT statics/scenery with a DefaultAnimation are
 *                      tagged and move (CLandBlock::get_land_scenes → InitDefaults)
 * Writes verification/sweepb-world/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-sweepb-world.ts [--only a,b]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { enterWorld, teleloc, telepoi, REPO } from './lib/game-session.js';

const OUT = `${REPO}/verification/sweepb-world`;
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (k: string) => !ONLY || [...ONLY].some((o) => k.startsWith(o));

interface CylRow { name: string; guid: string; creature: boolean; setup: string; scale: number; radius: number; height: number; expR: number; expH: number }

/** Every placed server object with a Setup: its targetInfo cylinder vs Setup × mesh scale. */
function cylinders(page: Page): Promise<CylRow[]> {
  return page.evaluate(`(() => {
    const ac = window.__ac; const som = ac.serverObjectManager; const smr = ac.setupModelRenderer;
    const rows = [];
    for (const o of som.objects.values()) {
      if (!o.mesh || !o.setupId || o.wielderId || o.containerId || som.projectiles?.has?.(o.guid)) continue;
      const t = som.targetInfo(o.guid); if (!t) continue;
      const s = smr.loadSetupModel(o.setupId); const k = o.mesh.scale.x || 1;
      rows.push({ name: o.name, guid: o.guid.toString(16), creature: (o.itemType & 0x10) !== 0, setup: o.setupId.toString(16), scale: k,
        radius: t.radius, height: t.height, expR: (s ? s.radius : 0) * k, expH: (s ? s.height : 0) * k });
    }
    return rows;
  })()`) as Promise<CylRow[]>;
}

/** Part-0 transforms of the tagged animated statics (optionally one setup), sampled `n` times `gapMs` apart. */
async function animSamples(page: Page, setupId: number | null, n = 5, gapMs = 400) {
  const read = () => page.evaluate(`(() => {
    const out = [];
    window.__ac.sceneManager.scene.traverse((o) => {
      if (!o.userData || !o.userData.staticDefaultAnimation) return;
      if (${setupId ?? 0} && o.userData.setupId !== ${setupId ?? 0}) return;
      if (out.length >= 6) return;
      const parts = o.children.filter((c) => /^part_\\d+$/.test(c.name));
      out.push({ live: window.acDebug.staticAnimating ? window.acDebug.staticAnimating(o) : null, inScene: (() => { let n = o; while (n.parent) n = n.parent; return n === window.__ac.sceneManager.scene; })(), visible: o.visible, setup: (o.userData.setupId >>> 0).toString(16), anim: (o.userData.staticDefaultAnimation >>> 0).toString(16),
        pose: parts.map((p) => [p.position.x, p.position.y, p.position.z, p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w].map((v) => +v.toFixed(4)).join(',')).join('|') });
    });
    return { running: window.acDebug.staticAnimations ? window.acDebug.staticAnimations() : -1, tagged: out };
  })()`) as Promise<{ running: number; tagged: Array<{ setup: string; anim: string; pose: string }> }>;
  const samples: Array<Awaited<ReturnType<typeof read>>> = [];
  for (let i = 0; i < n; i++) { samples.push(await read()); if (i < n - 1) await page.waitForTimeout(gapMs); }
  const first = samples[0];
  const moved = first.tagged.map((t, i) => new Set(samples.map((s) => s.tagged[i]?.pose)).size > 1);
  return { running: first.running, tagged: first.tagged.map((t) => ({ setup: t.setup, anim: t.anim, live: (t as any).live, visible: (t as any).visible, pose0: t.pose.slice(0, 120) })), moved };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 600)}`); };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  const { browser, page } = await enterWorld({ settleMs: 4000 });
  try {
    await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(0.5));
    await telepoi(page, 'holtburg', 20_000);

    if (want('radius')) {
      const rows = await cylinders(page);
      const non = rows.filter((r) => !r.creature);
      const cre = rows.filter((r) => r.creature);
      const bad = (rs: CylRow[]) => rs.filter((r) => !near(r.radius, r.expR) || !near(r.height, r.expH));
      if (want('radius.noncreature')) {
        record('radius.noncreature', non.some((r) => r.radius > 0) && bad(non).length === 0,
          { count: non.length, withRadius: non.filter((r) => r.radius > 0).length, sample: non.slice(0, 8), mismatches: bad(non).slice(0, 8) });
      }
      if (want('radius.creature')) {
        record('radius.creature', cre.length > 0 && bad(cre).length === 0 && !cre.some((r) => r.radius === 0.3 && r.expR !== 0.3),
          { count: cre.length, sample: cre.slice(0, 8), mismatches: bad(cre).slice(0, 8) });
      }
      if (want('radius.rescale')) {
        const pick = non.find((r) => r.radius > 0) ?? cre.find((r) => r.radius > 0);
        if (!pick) record('radius.rescale', false, 'no object with a radius');
        else {
          const after = await page.evaluate(`(() => {
            const som = window.__ac.serverObjectManager; const g = 0x${pick.guid};
            const before = som.getObject(g).mesh.scale.x;
            som.setObjectScale(g, before * 1.5); const t = som.targetInfo(g);
            som.setObjectScale(g, before); const back = som.targetInfo(g);
            return { radius: t.radius, height: t.height, backRadius: back.radius };
          })()`) as { radius: number; height: number; backRadius: number };
          record('radius.rescale', near(after.radius, pick.expR * 1.5) && near(after.height, pick.expH * 1.5) && near(after.backRadius, pick.radius),
            { pick, after });
        }
      }
    }

    if (want('anim.scenery')) {
      // Holtburg's 3×3 ring (block 0xA8B4 carries animated scenery placements).
      await page.waitForTimeout(4000);
      const s = await animSamples(page, null);
      await page.screenshot({ path: `${OUT}/holtburg.png` });
      record('anim.scenery', s.running > 0 && s.tagged.length > 0 && s.moved.some(Boolean), s);
    }

    if (want('anim.dungeon')) {
      await teleloc(page, '0x00110170 [89 -261 -29.99] 1 0 0 0', 20_000);
      const s = await animSamples(page, 0x02001027);
      await page.screenshot({ path: `${OUT}/dungeon-00110170.png` });
      record('anim.dungeon', s.tagged.length > 0 && s.tagged.every((t) => t.anim === '30009e3') && s.moved.some(Boolean), s);
    }
  } finally {
    results.fails = fails;
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
    await browser.close();
  }
  if (fails.length) { console.error(`FAILED: ${fails.join(', ')}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
