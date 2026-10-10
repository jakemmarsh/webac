/**
 * probe-chargen-eyes — live check for BUG.chargen-eyes-strip-sent-as-eye-colour:
 * create a character with eyes STRIP s and eye COLOUR c (s ≠ c), then read
 * the ACE biota: EyesPalette (PropertyDataId 16) must be the Sex_CG
 * eyeColorList[c] (ACE PlayerFactory.cs:100) and EyesTexture (9) must come
 * from eyeStripList[s] (PlayerFactory.cs:77), not from index c.
 * Usage: npx tsx tools/probe-chargen-eyes.ts  (vite :3000 + bridge :9090 + ACE; docker ace-db)
 */
import { execFileSync } from 'node:child_process';
import { openSession, gameUrl, sessionArgs, waitForCharSelect } from './lib/game-session.js';
const NAME = `Eye Probe ${[0, 1, 2].map((i) => String.fromCharCode(97 + Math.floor(Date.now() / (1000 * 26 ** i)) % 26)).join('')}`;
const sql = (q: string) => execFileSync('docker', ['exec', 'ace-db', 'mysql', '-uacedockeruser', '-p2020acEmulator2017', '-N', 'ace_shard', '-e', q], { encoding: 'utf8' }).trim();
async function main(): Promise<void> {
  const { browser, page } = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  await page.goto(gameUrl({ autoenter: false, cb: 'eyes' }), { waitUntil: 'domcontentloaded' });
  await waitForCharSelect(page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
  await page.waitForTimeout(2000);
  const plan = await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.showCharacterCreate();
    const w = ui.wizard; const cg = ui.charGen || ui.characterGenerator || null;
    return { heritage: w.heritage, sex: w.gender ?? w.sex, keys: Object.keys(w.appearance) }; })()`);
  console.log('wizard:', JSON.stringify(plan));
  const sent = await page.evaluate(`(() => { const ui = window.__ac.gameUI; const w = ui.wizard;
    w.name = ${JSON.stringify(NAME)}; w.appearance.eyesStrip = 9; w.appearance.eyeColor = 2;
    ui.callbacks.onCharacterCreated(w); return { eyesStrip: w.appearance.eyesStrip, eyeColor: w.appearance.eyeColor }; })()`);
  console.log('sent:', JSON.stringify(sent), 'name:', NAME);
  await page.waitForTimeout(8000);
  await browser.close();
  const id = sql(`select object_Id from biota_properties_string where type=1 and value='${NAME}' limit 1`);
  console.log('biota id:', id || '(not created)');
  if (id) console.log(sql(`select type, lpad(hex(value),8,'0') from biota_properties_d_i_d where object_Id=${id} and type in (9,12,16) order by type`));
  // Clean up: soft-delete the probe character so auto-enter (most recent
  // login first) keeps landing on the account's real character.
  const s2 = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  await s2.page.goto(gameUrl({ autoenter: false, cb: 'eyes-cleanup' }), { waitUntil: 'domcontentloaded' });
  await waitForCharSelect(s2.page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
  await s2.page.waitForTimeout(2000);
  const del = await s2.page.evaluate(`(() => { const ui = window.__ac.gameUI; const c = ui.selectScreen.characters.find((s) => s.name === ${JSON.stringify('+' + NAME)} || s.name === ${JSON.stringify(NAME)});
    return c ? ui.callbacks.onDeleteCharacter(c) : false; })()`);
  await s2.page.waitForTimeout(3000);
  console.log('probe character deleted:', del);
  await s2.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
