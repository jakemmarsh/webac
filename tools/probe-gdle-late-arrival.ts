/**
 * probe-gdle-late-arrival — on GDLE, a player who logs in after you never
 * appears (found 2026-10-10 under RELEASE.gdle-untested-surfaces.a). Logs A
 * in, taps A's incoming game messages, logs B in at the same spot, then
 * reports every message A received that mentions B's guid, and whether A's
 * client lists B.
 *
 * Usage: AC_BRIDGE=ws://localhost:9092 npx tsx tools/probe-gdle-late-arrival.ts <accountA> <accountB>
 *   (password = account name; both characters should stand in the same town)
 */
import { enterWorld, gameUrl } from './lib/game-session.js';

const [accA = 'agentgdagd', accB = 'agentgdbgd'] = process.argv.slice(2);
const urlFor = (acc: string) => `${gameUrl({ cb: `late-${acc}`, env: { ...process.env, AC_ACCOUNT: acc, AC_PASSWORD: acc } })}&agent`;

async function main(): Promise<void> {
  const a = await enterWorld({ url: urlFor(accA) } as never);
  await a.page.waitForTimeout(4000);
  const tapped = await a.page.evaluate(`(() => { const c = window.__aceConnection || (window.__ac && window.__ac.__aceConnection);
    if (!c) return 'no connection'; window.__lateLog = [];
    c.on((e) => { if (e.type !== 'message') return; const d = e.data || {};
      const bytes = d.payload ? Array.from(d.payload) : [];
      window.__lateLog.push({ type: d.type, opcode: d.opcode, eventType: d.eventType, len: bytes.length, bytes, t: performance.now() }); });
    return 'tapped'; })()`);
  console.log('A:', tapped);
  const consoleA: string[] = [];
  a.page.on('console', (m) => consoleA.push(`[${m.type()}] ${m.text()}`));
  a.page.on('pageerror', (e) => consoleA.push(`[pageerror] ${e.message}`));
  const b = await enterWorld({ url: urlFor(accB) } as never);
  await b.page.waitForTimeout(10000);
  const bGuid = await b.page.evaluate(`window.__playerState ? (window.__playerState.guid ?? window.__playerState.playerGuid ?? null) : null`);
  console.log('B guid from playerState:', bGuid);
  const report = await a.page.evaluate(`(() => { const log = window.__lateLog || [];
    const counts = {}; for (const m of log) { const k = (m.type || '?') + ':' + (m.opcode ?? '') + ':' + (m.eventType ?? ''); counts[k] = (counts[k] || 0) + 1; }
    const hit = log.filter((m) => { const b = m.bytes; for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0x02 && b[i+1] === 0 && b[i+2] === 0 && b[i+3] === 0x50) return true; return false; });
    return { total: log.length, counts, mentionsB: hit.map((m) => ({ type: m.type, opcode: m.opcode, eventType: m.eventType, len: m.len, hex: m.bytes.map((x) => x.toString(16).padStart(2, '0')).join(' ') })) }; })()`);
  console.log(JSON.stringify(report, null, 1));
  const seen = await a.page.evaluate(`(() => { const g = 0x50000002; const ag = window.__acAgent;
    const obs = ag ? ag.observe(100, 200) : null; const s = JSON.stringify(obs || {});
    return { listed: s.includes('Claude Gdb'), objects: obs && obs.nearby ? obs.nearby.length : null, players: obs && obs.nearby ? obs.nearby.filter((n) => /player/i.test(JSON.stringify(n))).map((n) => n.name) : null }; })()`).catch((e) => String(e));
  console.log('A sees B:', JSON.stringify(seen));
  console.log('A console while B arrived:');
  for (const l of consoleA.filter((l) => /50000002|error|warn|Gdb|drop|stale|instance/i.test(l)).slice(0, 40)) console.log('  ' + l.slice(0, 300));
  await b.browser.close();
  await a.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
