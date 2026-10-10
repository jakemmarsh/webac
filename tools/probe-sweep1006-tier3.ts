/**
 * probe-sweep1006-tier3 — live checks for the decomp-sweep tier-3 reply
 * texts (one client, fxprobe1, in Holtburg):
 *  age       /age → "You have played for …."
 *  houses    ListAvailableHouses: mansions → "There are N mansions available."
 *            + coordinate lines (no "(N shown)"); cottages (over 400) end
 *            with the overflow note.
 *  qm        /qm and /querymana send no QueryItemMana and print no mana line
 *            (retail's DoCommand sends them to the server as Talk; ACE answers
 *            "Unknown command: …").
 *  allegiance-info  /allegiance info on a character with no record prints
 *            no invented header lines.
 *  environs  @setlbenviron Thunder1Sound: the thunder plays on the 'ui'
 *            category (Interface Sounds), not 'effects'.
 * Writes verification/sweep1006-tier3/results.json; exits 1 on a failure.
 *
 * Usage: AC_ACCOUNT=fxprobe1 AC_PASSWORD=fxprobe1 AC_BASE=… AC_BRIDGE=… npx tsx tools/probe-sweep1006-tier3.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { adminCommand, enterWorld } from './lib/game-session.ts';
import { say, waitChat, chatLines } from './lib/two-client.ts';

const OUT = 'verification/sweep1006-tier3';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 400)}`); };
  const { browser, page } = await enterWorld({ cb: 'sweep1006-t3', createCharacter: 'Fxprobe' } as never);
  const sends: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/QueryItemMana|playGameSound|AvailableHouses|[Hh]ouse/.test(t)) sends.push(t.slice(0, 160)); });
  try {
    await page.waitForTimeout(4000);

    await say(page, '/age');
    const age = await waitChat(page, /played for/, 10_000);
    record('age', !!age && /^You have played for .+\.$/.test(age), { age });

    // Mansions (80 on a fresh ACE world) fit in the chat buffer; cottages
    // (2600) overflow it, so they are checked by their last line.
    await page.evaluate('window.acDebug.listAvailableHouses(3)');
    const houses = await waitChat(page, /mansions available\.$/, 10_000);
    await page.waitForTimeout(1500);
    const lines = await chatLines(page);
    const idx = houses ? lines.lastIndexOf(houses) : -1;
    const coords = idx >= 0 ? lines.slice(idx + 1, idx + 4) : [];
    await page.evaluate('window.acDebug.listAvailableHouses(1)');
    await page.waitForTimeout(6000);
    const lastCottage = (await chatLines(page)).at(-1) ?? null;
    results.houseLog = sends.slice();
    record('houses', !!houses && /^There are \d+ mansions available\.$/.test(houses)
      && coords.length > 0 && coords.every((c) => /^\d+\.\d[NS], \d+\.\d[EW]$/.test(c)) /* chatLines trims the 5-space indent */
      && lastCottage === 'There were too many houses to display all the locations. Only the first 400 locations are displayed here.'
      && !lines.some((l) => /shown\)/.test(l)),
      { houses, coords, lastCottage });

    sends.length = 0;
    const before = (await chatLines(page)).length;
    await say(page, '/qm');
    await say(page, '/querymana');
    await page.waitForTimeout(3000);
    const after = await chatLines(page);
    const manaLines = after.slice(before).filter((l) => /mana/i.test(l) && !/^Unknown command:/.test(l));
    record('qm', !sends.some((t) => /Sent QueryItemMana/.test(t)) && manaLines.length === 0, { sends: sends.slice(), newLines: after.slice(before) });

    // allegiance info for a character with no allegiance record: retail
    // (GetData fails) prints nothing — no invented "Allegiance:" header.
    const beforeA = (await chatLines(page)).length;
    await say(page, '/allegiance info +Fxprobe');
    await page.waitForTimeout(4000);
    const newA = (await chatLines(page)).slice(beforeA);
    record('allegiance-info', !newA.some((l) => /^Allegiance: |^Members: |^MOTD: /.test(l)), { newLines: newA });

    // environs — watch which category the thunder plays on (a click first:
    // the page's audio starts on a user gesture).
    await page.mouse.click(784, 120);
    await page.waitForTimeout(500);
    await page.evaluate(`(() => { const sp = window.__ac.soundPlayer; const orig = sp.playGameSound.bind(sp); window.__gameSounds = [];
      sp.playGameSound = (t, e, c, v) => { window.__gameSounds.push({ t, e, c }); return orig(t, e, c, v); }; })()`);
    await adminCommand(page, '@setlbenviron Thunder1Sound');
    await page.waitForTimeout(4000);
    const played = await page.evaluate('window.__gameSounds') as Array<{ t: number; e: number; c: string }>;
    await adminCommand(page, '@setlbenviron');
    record('environs', played.length > 0 && played.every((p) => p.c === 'ui'), { played });
  } finally {
    results.fails = fails;
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2) + '\n');
    await browser.close();
  }
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
