/**
 * probe-ac1999-silent-refusals — BUG.ac1999-silent-refusals live repro against the local AC1999 server.
 *
 * Logs an admin account into the 1999 world, wields a wand, enters magic mode, then:
 *   1. research: a 2-component formula through the Create Spell panel's Test callback → the server's
 *      "That is not a valid spell formula." line + 0x1C 0x405 (MAGIC_SPELLBOOK_ADDSPELL_FAILURE);
 *   2. cast: a known war spell at a creature about 110 m off → bare 0x1C 0x550 (out of range);
 *   3. heal: a Plain Healing Kit on a creature → bare 0x1C 0x501 (HEAL_PLAYERS_ONLY).
 * Records what showed (spew + chat) and the refusal telemetry each produced, and screenshots each.
 *
 * Usage (own Vite, local 1999 bridge):
 *   AC_BASE=http://localhost:5477/ npx tsx tools/probe-ac1999-silent-refusals.ts [outDir]
 * env: AC_BRIDGE (ws://localhost:9163), AC_ACCOUNT (agentw99, an admin), AC_GPU=1 for the real GPU.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { adminCommand, DEFAULT_VIEWPORT, GPU_ARGS, SWIFTSHADER_ARGS, waitForWorld } from './lib/game-session.ts';
import { createRunProfile } from './lib/temp-profile.ts';

const OUT = process.argv[2] ?? 'verification/ac1999-silent-refusals';
const BASE = process.env.AC_BASE ?? 'http://localhost:5477/';
const BRIDGE = process.env.AC_BRIDGE ?? 'ws://localhost:9163';
const ACCOUNT = process.env.AC_ACCOUNT ?? 'agentw99';
const DATS = 'datSet=https://dats.playwebac.com/v1/sets/eol-p2072-c982-h497-l994.json'
  + '&eraDatSet=ac1999-retail:https://dats.playwebac.com/v1/sets/ac1999-retail-world-p102-c67.json&era=ac1999-retail';
const URL = `${BASE}?ace&bridge=${BRIDGE}&account=${ACCOUNT}&password=${process.env.AC_PASSWORD ?? ACCOUNT}&${DATS}&debug&agent`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const profile = createRunProfile('acjs-silent-refusals-', { tool: 'probe-ac1999-silent-refusals' });
  const ctx = await chromium.launchPersistentContext(profile.dir, {
    headless: true, viewport: DEFAULT_VIEWPORT, args: process.env.AC_GPU === '1' ? GPU_ARGS : SWIFTSHADER_ARGS,
  });
  profile.setCloser(() => ctx.close());
  const refusals: unknown[] = [];
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.setDefaultTimeout(150_000);
  page.on('console', (m) => { const t = m.text(); if (/WeenieError|ResearchSpell|Cast/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`); });
  // The refusal telemetry posts (RefusalReporter → /client-preworld on the bridge's http side).
  page.on('request', (r) => { const b = r.postData(); if (b && b.includes('"outcome":"refusal"')) refusals.push(JSON.parse(b)); });
  try {
    await page.goto(URL);
    if (!await waitForWorld(page, { timeoutMs: 240_000 })) throw new Error('never reached the world');
    await page.waitForTimeout(4000);
    const ev = <T>(js: string): Promise<T> => page.evaluate(js) as Promise<T>;
    // What the player saw: every spew-box line and chat line, recorded at GameUI's own two sinks.
    await ev(`(() => {
      const ui = window.__ac.gameUI; const seen = window.__seen = { spew: [], chat: [] };
      const spew = ui.displayErrorText.bind(ui), chat = ui.addSystemMessage.bind(ui);
      ui.displayErrorText = (t, ...r) => { seen.spew.push(t); return spew(t, ...r); };
      ui.addSystemMessage = (t, ...r) => { seen.chat.push(t); return chat(t, ...r); };
    })()`);
    const lines = async (): Promise<{ spew: string[]; chat: string[] }> => {
      const s = await ev<{ spew: string[]; chat: string[] }>('window.__seen');
      await ev('window.__seen.spew = []; window.__seen.chat = [];');
      return s;
    };

    // A wand in hand and magic mode (1999 magic needs a held caster).
    const hasWand = await ev<boolean>("window.__ac.playerState.inventory.getAll().some((i) => /wand/i.test(i.name))");
    if (!hasWand) { await adminCommand(page, '@spawnwcidinv 2472'); await page.waitForTimeout(2500); }
    await ev("window.acDebug.wieldByName(window.__ac.playerState.inventory.getAll().find((i) => /wand/i.test(i.name)).name)");
    await page.waitForTimeout(2500);
    await adminCommand(page, '@learnschool war');
    // War Magic trained (16 credits at 1999's SkillTable), so the cast reaches the range check.
    await adminCommand(page, '@givecredit 20');
    await page.waitForTimeout(1500);
    await ev('window.acDebug.trainSkill(34, 16)');
    await page.waitForTimeout(1500);
    await ev("window.acDebug.combatMode('magic')");
    await page.waitForTimeout(3000);

    // 1. research, malformed (2 components): the server's own line + 0x405.
    const me = await ev<number>('window.__acAgent.self().guid');
    // Research needs a selection other than yourself: the nearest creature.
    const near = await ev<number>(`(() => {
      const c = window.acDebug.collisionState(); let best = null;
      for (const o of window.acDebug.getObjects()) {
        if (!o.pos || !(o.type & 0x10) || o.guid === ${me}) continue;
        const d = Math.hypot(o.pos.x - c.x, o.pos.y - c.y, o.pos.z - c.z);
        if (!best || d < best.d) best = { guid: o.guid, d };
      }
      return best.guid;
    })()`);
    await ev(`window.acDebug.select(${near})`);
    await page.waitForTimeout(2500);
    await lines(); // drop the setup's lines
    await ev(`window.__ac.gameUI.spellCallbacks.onResearchSpell({ count: 2, components: () => [1, 2, 0, 0, 0, 0, 0, 0] })`);
    await page.waitForTimeout(2500);
    const research = await lines();
    await page.screenshot({ path: `${OUT}/1-research-0x405.png` });

    // 2. cast a war spell at a creature about 110 m off: 0x550.
    const far = await ev<{ guid: number; name: string; d: number } | null>(`(() => {
      const objs = window.acDebug.getObjects();
      const c = window.acDebug.collisionState();
      let best = null;
      for (const o of objs) {
        if (!o.pos || o.guid === ${me} || !(o.type & 0x10)) continue; // TYPE_CREATURE
        const d = Math.hypot(o.pos.x - c.x, o.pos.y - c.y, o.pos.z - c.z);
        // Past a bolt's reach but inside the server's view (FindWithinPVS), so the range check is what refuses.
        if (!best || Math.abs(d - 110) < Math.abs(best.d - 110)) best = { guid: o.guid, name: o.name, d };
      }
      return best;
    })()`);
    const spell = await ev<{ id: number; name: string } | null>("(() => { const s = window.__ac.magicController.knownSpells.find((k) => /bolt|arc|streak/i.test(k.name)); return s ? { id: s.id, name: s.name } : null; })()");
    let cast = null as null | { spew: string[]; chat: string[] };
    if (far && spell) {
      await ev(`window.acDebug.select(${far.guid})`);
      await page.waitForTimeout(500);
      await ev(`window.__castSpell(${spell.id}, ${far.guid})`);
      await page.waitForTimeout(3000);
      cast = await lines();
      await page.screenshot({ path: `${OUT}/2-cast-out-of-range-0x550.png` });
    }
    // 3. a healing kit on a creature: 0x501.
    const codes: number[] = [];
    page.on('console', (m) => { const r = /\[WeenieError\] type=0x([0-9a-f]+)/.exec(m.text()); if (r) codes.push(parseInt(r[1], 16)); });
    await adminCommand(page, '@spawnwcidinv 629');
    await page.waitForTimeout(2500);
    await lines();
    const kit = await ev<number | null>("window.__ac.playerState.inventory.getAll().find((i) => /heal/i.test(i.name))?.id ?? null");
    const reply = kit ? await ev(`window.__acAgent.useOn(${kit}, ${near})`) : 'no kit in the pack';
    await page.waitForTimeout(1500); // the status line fades after a few seconds
    await page.screenshot({ path: `${OUT}/3-heal-creature-0x501.png` });
    await page.waitForTimeout(3000);
    const heal = { codes: [...codes], ...(await lines()), reply };
    const result = { url: URL, research, far, spell, cast, heal, refusals };
    writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await profile.dispose();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
