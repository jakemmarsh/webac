/**
 * verify-spell-learn-message — live in-cloud verification for
 * BUG.spell-learn-message-duplicated.
 *
 * Pre-fix, learning a spell printed TWO chat lines: the client synthesized
 * "You have learned the <X> spell." from GameEventMagicUpdateSpell while ACE
 * separately sent its own "You learn the <X> spell." Broadcast line
 * (Player_Spells.cs:69-86). This drives the real client against the live ACE
 * stack, snapshots the chat panel around an @addspell, and asserts exactly
 * one learn line lands per spell.
 *
 * Output: verification/playtest/<utc>-spell-learn/
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=spelllearn';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-spell-learn`);

const steps: Array<Record<string, unknown>> = [];

/**
 * Pick spells the character does not already know — a re-run against the same
 * persistent shard character would otherwise get "You already know that
 * spell!" and never fire GameEventMagicUpdateSpell. Names come from the
 * client's own parsed DAT SpellTable so the assertion text matches ACE's.
 */
async function pickUnknownSpells(page: Page, count: number): Promise<Array<{ id: number; name: string }>> {
  return page.evaluate(`(() => {
    const st = window.__ac.spellTable;
    const known = new Set(window.__ac.magicController.knownSpells.map(s => s.id));
    const out = [];
    for (const [id, sb] of st.spells) {
      if (known.has(id) || !sb.name) continue;
      out.push({ id, name: sb.name });
      if (out.length >= ${count}) break;
    }
    return out;
  })()`) as any;
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

/**
 * Chat lines render through the DAT bitmap-font renderer (GameUI.renderACText
 * → canvas), so DOM textContent is empty. Capture the text at the API
 * boundary instead, and use the #chat-messages child count as a corroborating
 * count of rendered lines.
 */
async function installChatTap(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    window.__chatTap = [];
    for (const m of ['addSystemMessage', 'addChatMessage']) {
      if (typeof ui[m] !== 'function' || ui[m].__tapped) continue;
      const orig = ui[m].bind(ui);
      const wrapped = (...args) => {
        window.__chatTap.push({ via: m, text: args.filter(a => typeof a === 'string').join(' | ') });
        return orig(...args);
      };
      wrapped.__tapped = true;
      ui[m] = wrapped;
    }
  })()`);
}

async function chatTap(page: Page): Promise<Array<{ via: string; text: string }>> {
  return page.evaluate(`window.__chatTap.slice()`) as any;
}

async function renderedLineCount(page: Page): Promise<number> {
  return page.evaluate(`(() => {
    const el = document.getElementById('chat-messages');
    return el ? el.children.length : -1;
  })()`) as Promise<number>;
}

async function talk(page: Page, text: string): Promise<void> {
  await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(text)})`);
  console.log(`[talk] ${text}`);
}

async function knownSpells(page: Page): Promise<Array<{ id: number; name: string }>> {
  return page.evaluate(
    `window.__ac.magicController ? window.__ac.magicController.knownSpells.map(s => ({ id: s.id, name: s.name })) : []`,
  ) as any;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  console.log(`[verify] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[verify] create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[verify] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep looping */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '00-never-entered.png') });
    await browser.close();
    throw new Error('never entered world');
  }

  await page.waitForTimeout(10_000);
  await page.screenshot({ path: join(OUT, '01-spawn.png') });

  await installChatTap(page);

  const SPELLS = await pickUnknownSpells(page, 2);
  console.log('[verify] target spells:', JSON.stringify(SPELLS));
  if (SPELLS.length < 2) throw new Error('could not find two unknown spells in the DAT SpellTable');

  const failures: string[] = [];
  for (const spell of SPELLS) {
    const tapBefore = (await chatTap(page)).length;
    const renderedBefore = await renderedLineCount(page);
    await talk(page, `@addspell ${spell.id}`);
    await page.waitForTimeout(6000);
    const added = (await chatTap(page)).slice(tapBefore);
    const renderedAdded = (await renderedLineCount(page)) - renderedBefore;
    // Both the retail server line ("You learn the X spell.") and the
    // pre-fix client-synthesized line ("You have learned the X spell.")
    // mention the spell name plus a learn verb.
    const learnLines = added.filter(l => /learn/i.test(l.text) && l.text.includes(spell.name));
    steps.push({ step: `addspell-${spell.id}`, spell, added, learnLines, renderedAdded });
    console.log(`[verify] ${spell.name}: ${learnLines.length} learn line(s), ${renderedAdded} rendered → ${JSON.stringify(learnLines.map(l => l.text))}`);
    if (learnLines.length !== 1) {
      failures.push(`${spell.name}: expected exactly 1 learn line, got ${learnLines.length}: ${JSON.stringify(learnLines)}`);
    }
    if (renderedAdded !== 1) {
      failures.push(`${spell.name}: expected exactly 1 rendered chat line, got ${renderedAdded}`);
    }
    const clientSynth = learnLines.filter(l => /You have learned the/i.test(l.text));
    if (clientSynth.length > 0) {
      failures.push(`${spell.name}: client-synthesized line still present: ${JSON.stringify(clientSynth)}`);
    }
    // The surviving line must be ACE's own wording (Player_Spells.cs:78).
    if (learnLines.length === 1 && !/You learn the/i.test(learnLines[0].text)) {
      failures.push(`${spell.name}: surviving line is not ACE's own text: ${JSON.stringify(learnLines[0])}`);
    }
  }

  await page.screenshot({ path: join(OUT, '02-chat-after-addspell.png') });

  // Spellbook must still be refreshed by the handler.
  const spells = await knownSpells(page);
  steps.push({ step: 'spells-known', spells });
  console.log('[verify] known spells:', JSON.stringify(spells));
  for (const s of SPELLS) {
    if (!spells.some(k => k.id === s.id)) failures.push(`${s.name}: not in magicController.knownSpells after learn`);
  }

  await page.keyboard.press('KeyP');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, '03-spellbook-panel.png') });

  const finalChat = await chatTap(page);
  writeFileSync(
    join(OUT, 'observations.json'),
    JSON.stringify({ utc: UTC, steps, failures, chat: finalChat.slice(-60) }, null, 2),
  );

  await browser.close();

  if (failures.length) {
    console.error('[verify] FAIL:\n' + failures.map(f => ` - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log(`[verify] PASS — exactly one learn line per spell. Evidence: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
