/**
 * probe-game-actions — live check for DEBT.acdebug-production-coupling /
 * DEBT.main-ts-extractions: production GameActions no longer route through
 * window.acDebug. A spell-bar favorite added through GameUI's spell callbacks
 * must survive a relog (ACE persists it at logout — Player_Character.cs
 * spell bar — and restores it in PlayerDescription); the options toggle and
 * ping heartbeat must go out; the dev build still installs acDebug and
 * exposes the landblock streamer.
 * Usage: npx tsx tools/probe-game-actions.ts   (vite :3000 + bridge :9090 + ACE)
 */
import { enterWorld } from './lib/game-session.js';
const BAR = 7; let SPELL = 1;
async function session(cb: string) {
  const s = await enterWorld({ cb } as never);
  const logs: string[] = [];
  s.page.on('console', (m) => logs.push(m.text()));
  await s.page.waitForTimeout(5000);
  return { ...s, logs };
}
const slot = (p: import('playwright').Page) => p.evaluate(`(() => { const s = window.__ac.gameUI.spellBarSlots[${BAR}]; const hit = s.findIndex((x) => x && x.id === ${SPELL}); return hit; })()`) as Promise<number>;
async function main(): Promise<void> {
  const a = await session('gameactions-a');
  // ACE HandleActionAddSpellFavorite drops unknown spells (Player_Character.cs:300 SpellIsKnown) — use one the character knows.
  SPELL = await a.page.evaluate(`(() => { const mc = window.__ac.magicController; for (let id = 2; id < 7000; id++) if (mc.isSpellKnown(id)) return id; return 1; })()`) as number;
  console.log('dev env:', JSON.stringify(await a.page.evaluate(`({ acDebug: typeof window.acDebug, radius: window.__ac.landblockObjects && window.__ac.landblockObjects.loadRadius })`)));
  console.log('before: spell', SPELL, 'on bar', BAR, 'at slot', await slot(a.page));
  await a.page.evaluate(`window.__ac.gameUI.spellCallbacks.onAddSpellFavorite(${SPELL}, 0, ${BAR})`);
  await a.page.evaluate(`window.__ac.gameUI.callbacks.onCharacterOptionToggle(1, true)`);
  const t0 = Date.now();
  while (Date.now() - t0 < 25_000 && !a.logs.some((l) => /Ping round-trip/.test(l))) await a.page.waitForTimeout(1000);
  console.log('sent:', a.logs.filter((l) => /Sent (AddSpellFavorite|SetSingleCharacterOption)/.test(l)).join(' | '));
  console.log('ping:', a.logs.find((l) => /Ping round-trip/.test(l)) ?? '(none)');
  await a.page.close(); await a.browser.close();
  await new Promise((r) => setTimeout(r, 8000)); // ACE saves on logout
  const b = await session('gameactions-b');
  const restored = await slot(b.page);
  console.log('after relog: spell', SPELL, 'on bar', BAR, 'at slot', restored, restored >= 0 ? 'PASS' : 'FAIL');
  await b.page.evaluate(`window.__ac.gameUI.spellCallbacks.onRemoveSpellFavorite(${SPELL}, ${BAR})`);
  await b.page.waitForTimeout(2000);
  await b.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
