/**
 * CORE.6.c verification — full-SkillTable census in the char-panel Skills tab.
 *
 * Enters the ACE stack (scripting character creation on a virgin account —
 * which also exercises the retail default SAC array: Untrained for every
 * trainable skill, per CharGenState::ResetSkillLevels @ 005c43b0), opens the
 * character panel Skills tab, then asserts:
 *   - charInfo.skills covers the whole EoL SkillTable (38 skills), not just
 *     the server-record subset
 *   - group membership per gmSkillUI::RebuildSkillList @ 0049c3a0 (the six
 *     zero-cost auto-Trained skills; minLevel-2 skills under Unusable at 0;
 *     minLevel-1 untrained skills under Untrained with formula values)
 *   - the DOM list renders one row per census skill plus a banner per
 *     non-empty group
 * and screenshots the tab + composes the side-by-side vs the retail
 * reference (character-panel-skills.jpg).
 *
 * Usage: npx tsx tools/verify-core6c-skills-census.ts [--headed]
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const HEADED = process.argv.includes('--headed');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=core6cvirgin&password=core6cvirgin&cb=core6c';
// ^ a VIRGIN auto-created account (AllowAutoAccountCreation) so the scripted
// character creation exercises the new retail default SAC array end-to-end.
const VIEW = { width: 1568, height: 775 };
const OUT = join(REPO, 'verification', 'core6c-skills-census');

async function inWorld(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
      const cs = dbg?.collisionState?.();
      return !!(cs && cs.x > 0);
    });
  } catch { return false; }
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Census Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') && !HEADED ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  console.log(`[core6c] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[core6c] virgin account create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core6c] not in world yet — phantom-session reload');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep waiting */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '00-never-entered.png') });
    await browser.close();
    throw new Error('never entered world within 360s');
  }
  console.log('[core6c] in world — settling 8s');
  await page.waitForTimeout(8000);

  // Open the character panel on the Skills tab, then wait for the server
  // skill records to land in charInfo (PlayerDescription → setSkill →
  // syncFromPlayerState): a fresh char must show a Trained group (the six
  // zero-cost defaults). Re-render + poll up to 60s.
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    ui.charPanelTab = 'skills';
    ui.toggleCharPanel ? (ui.charPanelVisible || ui.toggleCharPanel()) : null;
    ui.renderCharPanel();
  })()`);
  const recDeadline = Date.now() + 60_000;
  while (Date.now() < recDeadline) {
    const ready = await page.evaluate(`(() => {
      const ui = window.__ac.gameUI;
      ui.renderCharPanel();
      return ui.charInfo.skills.some(s => s.status === 'Trained');
    })()`);
    if (ready) break;
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(1000);

  const m = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const skills = ui.charInfo.skills.map(s => ({ id: s.id, name: s.name, status: s.status, effective: s.effective }));
    const groups = {};
    for (const s of skills) (groups[s.status] = groups[s.status] || []).push(s.name + ' ' + s.effective);
    const tableSize = ui.skillTable ? ui.skillTable.skills.size : -1;
    // DOM census in the DAT list region 0x1000023d of the skills pane 0x1000022c
    const pane = ui.charPanelHandle && ui.charPanelHandle.elements.get(0x1000022c);
    const list = pane && pane.querySelector('[data-element-id="0x1000023d"]');
    let domRows = -1, domBanners = -1;
    if (list) {
      const kids = Array.from(list.children);
      // Banners use the 280px strip (marginRight 20px); rows use the 282px
      // row template (makeStatListRow marginRight 18px).
      domBanners = kids.filter(k => k.style.marginRight === '20px').length;
      domRows = kids.filter(k => k.style.marginRight === '18px').length;
    }
    return { count: skills.length, tableSize, groups, domRows, domBanners, skills };
  })()`) as Record<string, unknown>;

  console.log('[core6c] census:', JSON.stringify({ ...m, skills: undefined }, null, 1).slice(0, 2200));

  // ── assertions ──
  const skills = m.skills as Array<{ id: number; name: string; status: string; effective: number }>;
  const by = (id: number) => skills.find(s => s.id === id);
  const fail: string[] = [];
  const expectEq = (what: string, got: unknown, want: unknown) => {
    if (got !== want) fail.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  expectEq('census size == SkillTable size', m.count, m.tableSize);
  expectEq('SkillTable size (EoL)', m.tableSize, 38);
  expectEq('DOM rows == census', m.domRows, m.count);
  // Six zero-cost auto-Trained (retail ResetSkillLevels defaults through our
  // new chargen array): Arcane Lore 14, Magic Defense 15, Jump 22, Run 24,
  // Loyalty 36, Salvaging 40.
  for (const id of [14, 15, 22, 24, 36, 40]) expectEq(`skill ${id} status`, by(id)?.status, 'Trained');
  // minLevel-1 untrained: Armor Tinkering 29, Heavy Weapons 44 → Untrained group.
  for (const id of [29, 44]) expectEq(`skill ${id} status`, by(id)?.status, 'Untrained');
  // minLevel-2 skills → Unusable at 0: War Magic 34, Healing 21, Dirty Fighting 52.
  for (const id of [34, 21, 52]) {
    expectEq(`skill ${id} status`, by(id)?.status, 'Unusable');
    expectEq(`skill ${id} value`, by(id)?.effective, 0);
  }
  // Untrained formula values (default 10s attributes): Armor Tinkering
  // (focus 10 + endurance 10)/2 = 10; Missile Weapons 47 coord 10/2 = 5.
  expectEq('Armor Tinkering value', by(29)?.effective, 10);
  expectEq('Missile Weapons value', by(47)?.effective, 5);

  // ── screenshots ──
  const r = await page.evaluate(`(() => {
    const wr = window.__ac.gameUI.charPanel.getBoundingClientRect();
    return { x: wr.x, y: wr.y, w: wr.width, h: wr.height };
  })()`) as { x: number; y: number; w: number; h: number };
  await page.screenshot({
    path: join(OUT, 'skills-tab.png'),
    clip: { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.w + 40, height: Math.min(VIEW.height - r.y + 10, r.h + 50) },
  });

  const b64 = (p: string, mime: string): string => `data:${mime};base64,${readFileSync(p).toString('base64')}`;
  const sheet = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await sheet.setContent(`<!doctype html><body style="margin:0;background:#222;display:flex;gap:8px;align-items:flex-start;font-family:monospace;color:#fff">
    <figure style="margin:4px"><figcaption>RETAIL character-panel-skills.jpg</figcaption><img src="${b64(join(REPO, 'reference/images/hud/character-panel-skills.jpg'), 'image/jpeg')}" style="max-height:840px"></figure>
    <figure style="margin:4px"><figcaption>OURS skills tab (fresh char, full census)</figcaption><img src="${b64(join(OUT, 'skills-tab.png'), 'image/png')}" style="max-height:840px"></figure>
  </body>`);
  await sheet.waitForTimeout(400);
  await sheet.screenshot({ path: join(OUT, 'sidebyside-skills-census.png'), fullPage: true });
  await sheet.close();

  writeFileSync(join(OUT, 'metrics.json'), JSON.stringify({ ...m, skills, failures: fail, errors: errors.slice(0, 20) }, null, 2));
  await browser.close();
  if (fail.length) {
    console.error('[core6c] FAILURES:\n  ' + fail.join('\n  '));
    process.exit(1);
  }
  console.log(`[core6c] all assertions passed — output in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
