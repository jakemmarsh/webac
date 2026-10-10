/**
 * probe-panel-dom-leak — which panel leaves DOM nodes / event listeners
 * behind? For each of perf-soak's panel keys: force GC, read
 * Memory.getDOMCounters, open + close the panel N times, force GC, read
 * again. A panel whose retained delta grows with N is leaking.
 *
 * Usage: npx tsx tools/probe-panel-dom-leak.ts [rounds=5] [keys=F12,F8,…]
 */
import { enterWorld } from './lib/game-session.js';

const ROUNDS = Number(process.argv[2] ?? 5);
const KEYS = (process.argv[3] ?? 'F12,F8,F9,F5,F6,F3,F4,F10,F11').split(',');

async function main(): Promise<void> {
  const { browser, page } = await enterWorld({ cb: 'domleak', settleMs: 8000 });
  try {
    const cdp = await page.context().newCDPSession(page);
    const counters = async (): Promise<{ nodes: number; listeners: number }> => {
      await cdp.send('HeapProfiler.collectGarbage');
      await page.waitForTimeout(300);
      await cdp.send('HeapProfiler.collectGarbage');
      const d = await cdp.send('Memory.getDOMCounters') as { nodes: number; jsEventListeners: number };
      return { nodes: d.nodes, listeners: d.jsEventListeners };
    };
    // One warm-up lap so first-open caches don't count as leaks.
    for (const key of KEYS) { await page.keyboard.press(key); await page.waitForTimeout(600); await page.keyboard.press(key); await page.waitForTimeout(250); }
    for (const key of KEYS) {
      const a = await counters();
      for (let i = 0; i < ROUNDS; i++) {
        await page.keyboard.press(key); await page.waitForTimeout(600);
        await page.keyboard.press(key); await page.waitForTimeout(250);
      }
      const b = await counters();
      console.log(`${key.padEnd(4)} x${ROUNDS}: nodes ${a.nodes} → ${b.nodes} (${b.nodes - a.nodes >= 0 ? '+' : ''}${b.nodes - a.nodes}), listeners ${a.listeners} → ${b.listeners} (${b.listeners - a.listeners >= 0 ? '+' : ''}${b.listeners - a.listeners})`);
    }
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
