/**
 * probe-wheel-scroll — the examine window's text scrolls with a touchpad
 * (small pixel wheel deltas) and a mouse notch (±100 px = one step).
 * Opens the inventory, right-clicks the first pack item, then wheels over
 * the appraisal text and reports scrollTop after each input.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-wheel-scroll.ts
 */
import { enterWorld, shot } from './lib/game-session.js';

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'wheel' } as never);
  await s.page.waitForTimeout(4000);
  await s.page.click('#tb-inv').catch(() => {});
  await s.page.waitForTimeout(2000);
  // Right-click pack items until one's appraisal overflows the text element.
  for (let i = 0; i < 24; i++) {
    const ok = await s.page.evaluate(`(() => { const c = document.querySelector('[data-inv-slot="${i}"]'); if (!c) return false; c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); return true; })()`);
    if (!ok) break;
    await s.page.waitForTimeout(1500);
    const over = await s.page.evaluate(`(() => { const b = document.querySelector('[data-examine-body]'); return !!b && b.scrollHeight > b.clientHeight + 20; })()`);
    if (over) { console.log('overflowing item at slot', i); break; }
  }
  const box = await s.page.evaluate(`(() => { const b = document.querySelector('[data-examine-body]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, sh: b.scrollHeight, ch: b.clientHeight }; })()`) as { x: number; y: number; sh: number; ch: number } | null;
  console.log('body', JSON.stringify(box));
  if (!box) { await s.browser.close(); return; }
  const top = () => s.page.evaluate(`document.querySelector('[data-examine-body]').scrollTop`) as Promise<number>;
  await s.page.mouse.move(box.x, box.y);
  const seq: string[] = [];
  for (let i = 0; i < 8; i++) { await s.page.mouse.wheel(0, 6); await s.page.waitForTimeout(60); seq.push(String(await top())); }
  console.log('touchpad 8 x 6px →', seq.join(' '));
  const before = await top();
  await s.page.mouse.wheel(0, 100); await s.page.waitForTimeout(150);
  console.log('mouse notch down (at the bottom):', before, '→', await top());
  const b2 = await top();
  await s.page.mouse.wheel(0, -100); await s.page.waitForTimeout(150);
  console.log('mouse notch up (one step):', b2, '→', await top());
  await shot(s.page, 'verification/wheel-scroll/examine-scrolled.png');
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
