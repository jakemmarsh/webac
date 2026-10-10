/**
 * probe-toolbar-tooltips-chat-buttons — live check for three HUD fixes
 * (2026-09-28):
 *
 *  1. VISUAL.toolbar-tooltips-invented — the toolbar (0x21000070 content
 *     0x1000001b → 0x21000016, gmToolbarUI) carries no DAT p73 tooltip and
 *     gmToolbarUI never calls SetTooltip, so none of its buttons shows a
 *     tooltip: no native `title`, no data-ac-tooltip-text, and no
 *     0x21000041 box after a hover past the tooltip delay.
 *  2. VISUAL.toolbar-hover-shows-selected-state — hovering a panel button
 *     keeps its state-1 art (UIElement_Button::UpdateState_ @ 00471cf0 asks
 *     for state 2, which the DAT does not author).
 *  3. BUG.chat-container-covers-window-buttons — after focusing the chat
 *     entry (and after the maximize box 0x1000046f), the four chat-window
 *     buttons 0x10000522-525 are still the hit target at their centres and a
 *     click opens the floaty window.
 *
 *   AC_ACCOUNT=fxprobe3 AC_PASSWORD=fxprobe3 AC_BASE=http://localhost:3057/ \
 *     npx tsx tools/probe-toolbar-tooltips-chat-buttons.ts [--gpu]
 *
 * Output: verification/toolbar-tooltips-chat-buttons/ (report.json + jpg).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { openSession, gameUrl, waitForWorld, sessionArgs, REPO } from './lib/game-session.js';

const argv = process.argv.slice(2);
const OUT = `${REPO}/verification/toolbar-tooltips-chat-buttons`;
const TOOLBAR_IDS = ['combat-mode-btn', 'tb-social', 'tb-magic', 'tb-char', 'tb-journal', 'tb-map', 'tb-opt', 'tb-inv', 'tb-use', 'tb-examine'];
const CHAT_BUTTONS = ['10000522', '10000523', '10000524', '10000525'];

const box = (id: string) => `(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) return null;
  const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2,
  title: e.getAttribute('title'), tip: e.dataset.acTooltipText ?? null, bg: e.style.backgroundImage }; })()`;

const CHAT_HITS = `(() => {
  const chat = document.getElementById('hud-chat');
  return ${JSON.stringify(CHAT_BUTTONS)}.map((id) => {
    const e = chat.querySelector('[data-element-id="0x' + id + '"]');
    if (!e) return { id, found: false };
    const r = e.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { id, found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      hitIsButton: !!h && (h === e || e.contains(h)), hit: h ? (h.id || h.dataset.elementId || h.tagName) : null };
  });
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await openSession(sessionArgs(argv));
  const page = s.page;
  const report: Record<string, unknown> = {};
  const url = gameUrl({ cb: 'probe-toolbar-tooltips' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!(await waitForWorld(page, { url }))) throw new Error('never entered the world');
  await page.waitForTimeout(4000);
  await page.mouse.click(780, 120);

  // ── 1 + 2: tooltips + hover art ─────────────────────────────────
  const toolbar: unknown[] = [];
  for (const id of TOOLBAR_IDS) {
    const before = await page.evaluate(box(id)) as { x: number; y: number; title: string | null; tip: string | null; bg: string } | null;
    if (!before) { toolbar.push({ id, found: false }); continue; }
    await page.mouse.move(before.x, before.y);
    await page.waitForTimeout(1600); // past the default tooltip delay
    const hovered = await page.evaluate(box(id)) as typeof before;
    const tipBox = await page.evaluate(`(() => { const t = document.querySelector('[data-ac-tooltip-for]'); return t ? t.dataset.acText : null; })()`);
    if (id === 'tb-social') await page.screenshot({ path: `${OUT}/hover-social.jpg` });
    toolbar.push({ id, title: hovered!.title, tip: hovered!.tip, tooltipShown: tipBox,
      hoverChangedArt: before.bg !== hovered!.bg, before: before.bg.slice(-24), hovered: hovered!.bg.slice(-24) });
    await page.mouse.move(780, 120);
    await page.waitForTimeout(200);
  }
  report.toolbar = toolbar;
  for (const t of toolbar) console.log('toolbar', JSON.stringify(t));

  // ── 3: chat window buttons after focusing the entry / maximize ──
  report.chatInitial = await page.evaluate(CHAT_HITS);
  // The entry row 0x10000013 / input 0x10000016: a real mouse press at its
  // centre (what the player does), recording what the press hit.
  const inBox = await page.evaluate(`(() => { const r = document.getElementById('chat-input').getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: h ? (h.id || h.dataset.elementId || h.tagName) : null }; })()`) as { x: number; y: number; hit: string | null };
  report.entryHit = inBox.hit;
  report.chatLogHit = await page.evaluate(`(() => { const r = document.getElementById('chat-messages').getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h ? { hit: h.id || h.dataset.elementId || h.tagName, inLog: !!h.closest('#chat-messages') } : null; })()`);
  await page.mouse.click(inBox.x, inBox.y);
  report.entryFocusedByPress = await page.evaluate(`document.activeElement && document.activeElement.id`);
  if (report.entryFocusedByPress !== 'chat-input') {
    // Retail's other way in: the Enter/Exit Chat Mode key.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
  }
  report.entryFocused = await page.evaluate(`document.activeElement && document.activeElement.id`);
  // Playwright's own actionability check (hit target at the element's centre
  // must be the element) on each window button, with the entry focused.
  const pwClicks: Record<string, string> = {};
  for (const id of CHAT_BUTTONS) {
    try {
      await page.locator('#hud-chat [data-element-id="0x' + id + '"]').click({ timeout: 3000, trial: true });
      pwClicks[id] = 'ok';
    } catch (e) { pwClicks[id] = String((e as Error).message).split('\n').find((l) => /intercepts/.test(l))?.trim() ?? 'failed'; }
  }
  report.playwrightClickable = pwClicks;
  await page.waitForTimeout(500);
  report.chatAfterEntryFocus = await page.evaluate(CHAT_HITS);
  await page.screenshot({ path: `${OUT}/chat-entry-focused.jpg` });
  const firstBtn = (report.chatAfterEntryFocus as Array<{ x: number; y: number; found: boolean }>)[0];
  if (firstBtn?.found) {
    await page.mouse.click(firstBtn.x, firstBtn.y);
    await page.waitForTimeout(800);
    report.floaty1OpenAfterClick = await page.evaluate('window.__ac.gameUI.isFloatyChatWindowOpen(1)');
    await page.evaluate('window.__ac.gameUI.toggleFloatyChatWindow(1, false)');
  }
  const maxBox = await page.evaluate(`(() => { const e = document.getElementById('hud-chat').querySelector('[data-element-id="0x1000046f"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number } | null;
  if (maxBox) {
    await page.mouse.click(maxBox.x, maxBox.y);
    await page.waitForTimeout(800);
    report.chatAfterMaximize = await page.evaluate(CHAT_HITS);
    await page.screenshot({ path: `${OUT}/chat-maximized.jpg` });
    await page.mouse.click(maxBox.x, maxBox.y);
    await page.waitForTimeout(500);
  }
  for (const k of ['chatLogHit', 'entryHit', 'entryFocusedByPress', 'entryFocused', 'playwrightClickable', 'chatInitial', 'chatAfterEntryFocus', 'floaty1OpenAfterClick', 'chatAfterMaximize']) console.log(k, JSON.stringify(report[k]));
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await s.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
