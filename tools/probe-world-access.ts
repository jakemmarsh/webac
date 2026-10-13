/**
 * probe-world-access — which public worlds let a webAC player in through the
 * hosted bridge, and which refuse it (VPN / proxy checks, per-IP limits,
 * registration). 2026-10-12: Conquest's VPN check caught every webAC player
 * (they all arrive from the bridge's cloud address), so we survey the list.
 *
 * Per world, the way a new player does it on the deployed page: pick the
 * world row, type a fresh throwaway account + password, ENTER, Create
 * Character → Summary → a name → FINISH (the client enters the world on its
 * own after a create), then listen for 25 s. Outcome per world:
 *   login-failed (the client's connection-failure text), no-char-select,
 *   create-failed, in-world, and any server text matching a block pattern.
 * Server text is read from the bridge WebSocket's inbound frames (AC strings
 * are plain CP1252 inside the payload), so nothing debug-only is needed.
 *
 * One test account and at most one character per world (Jake OK'd throwaway
 * accounts on third-party worlds, 2026-10-11). Credentials go to
 * <out>/accounts.txt, never to the repo. One live browser at a time. The
 * browser profile is a per-run temp dir, deleted at exit (tools/lib/temp-profile.ts);
 * <out> keeps only the report, accounts and screenshots.
 *
 *   npx tsx tools/probe-world-access.ts [--url https://playwebac.com/] [--out dir]
 *       [--only Name,Name] [--skip Name,Name] [--emu ACE,GDL,GDLE] [--recheck-blocked]
 *
 * Worlds the bridge marks as refused (compat 'incompatible', e.g. the VPN
 * blocks in services/ws-tcp-bridge/src/serverCompat.ts) are reported as
 * `launcher-refused` and skipped, since the launcher refuses ENTER. To check
 * whether an operator has lifted a block, pass --recheck-blocked (with
 * --only Name): the page's /servers answer is rewritten so the world is
 * enterable, then the world is probed like any other.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import { GPU_ARGS, DEFAULT_VIEWPORT } from './lib/game-session.js';
import { createRunProfile } from './lib/temp-profile.js';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? dflt : dflt; };
const list = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
const url = opt('url', 'https://playwebac.com/');
const out = opt('out', `/tmp/world-access-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const only = new Set(list(opt('only', '')).map((s) => s.toLowerCase()));
const skip = new Set(list(opt('skip', '')).map((s) => s.toLowerCase()));
const emus = new Set(list(opt('emu', 'ACE,GDL,GDLE')));
const BRIDGE = opt('bridge-http', 'https://bridge.playwebac.com');
const recheckBlocked = args.includes('--recheck-blocked');

/** Server text that means the world refused us. */
export const BLOCK_PATTERN = /vpn|proxy|not permitted|banned|blocked|too many (connections|accounts|sessions)|same ip|multiple accounts|ip address/i;

interface World { id: string; name: string; emu: string; online: boolean; population: number | null; era: string | null; compat?: string; compatReason?: string | null }
interface Result {
  world: string; emu: string; population: number | null;
  outcome: 'skipped' | 'launcher-refused' | 'login-failed' | 'no-char-select' | 'create-failed' | 'in-world' | 'error';
  blocked: boolean; serverText: string[]; failure?: string; seconds: number; shot?: string;
}

/** Printable CP1252 runs of 16+ characters in a frame: the strings a server sent. */
export function serverStrings(buf: Buffer): string[] {
  const s = buf.toString('latin1');
  return (s.match(/[\x20-\x7e]{16,}/g) ?? []).map((x) => x.trim());
}

/** A pronounceable name that passes retail's NameFilterTable (vowel in the first 4, no triples). */
function playerName(): string {
  const c = 'bdfgklmnprstvz', v = 'aeiou';
  const syl = () => c[randomInt(c.length)] + v[randomInt(v.length)];
  const first = (syl() + syl() + syl()).replace(/^./, (x) => x.toUpperCase());
  return `${first} ${(syl() + syl()).replace(/^./, (x) => x.toUpperCase())}`;
}

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const servers = (await (await fetch(`${BRIDGE}/servers`)).json()) as { servers: World[] };
  const worlds = servers.servers.filter((w) =>
    emus.has(w.emu) && (only.size === 0 || only.has(w.name.toLowerCase())) && !skip.has(w.name.toLowerCase()));
  console.log(`${worlds.length} worlds → ${out}`);

  // Each world fills the profile's OPFS DAT cache: a temp profile, removed at exit / signal / crash.
  const profile = createRunProfile('acjs-world-access-profile-', { tool: 'probe-world-access' });
  const ctx = await chromium.launchPersistentContext(profile.dir, {
    headless: true, channel: 'chromium', args: GPU_ARGS, viewport: { ...DEFAULT_VIEWPORT },
  });
  profile.setCloser(() => ctx.close());
  const page: Page = ctx.pages()[0] ?? await ctx.newPage();
  page.on('dialog', (d) => void d.dismiss());
  if (recheckBlocked) {
    // The launcher refuses ENTER on a refused world; let it through to see whether the block is gone.
    await page.route('**/servers', async (route) => {
      const resp = await route.fetch();
      const body = (await resp.json()) as { servers?: World[] };
      for (const w of body.servers ?? []) if (w.compat === 'incompatible') { w.compat = 'ok'; w.compatReason = null; }
      await route.fulfill({ response: resp, json: body });
    });
  }
  const consoleLines: string[] = [];
  page.on('console', (m) => { if (m.text().startsWith('[AC] ACE')) consoleLines.push(m.text()); });
  const frames: string[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    if (typeof f.payload !== 'string') frames.push(...serverStrings(f.payload));
  }));

  const results: Result[] = [];
  for (const w of worlds) {
    const t0 = Date.now();
    const r: Result = { world: w.name, emu: w.emu, population: w.population, outcome: 'error', blocked: false, serverText: [], seconds: 0 };
    consoleLines.length = 0; frames.length = 0;
    try {
      if (!w.online) { r.outcome = 'skipped'; r.failure = 'offline'; results.push(r); continue; }
      if (w.compat === 'incompatible' && !recheckBlocked) {
        r.outcome = 'launcher-refused'; r.failure = w.compatReason ?? 'compat incompatible'; results.push(r);
        console.log(`${w.name.padEnd(20)} launcher-refused ${r.failure}`);
        continue;
      }
      await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
      await page.waitForSelector('.launcher-account', { timeout: 120_000 });
      await page.waitForTimeout(1500);
      const row = page.locator(`[data-world="${w.id}"]`).first();
      if (!(await row.count())) { r.failure = 'world row not found'; results.push(r); continue; }
      await row.scrollIntoViewIfNeeded();
      await row.click();
      const account = `acjsprobe${randomInt(10000, 99999)}`;
      const password = randomBytes(8).toString('hex');
      appendFileSync(join(out, 'accounts.txt'), `${w.name}\t${account}\t${password}\n`);
      await page.mouse.click(418, 92); await page.keyboard.type(account, { delay: 15 });
      await page.mouse.click(418, 160); await page.keyboard.type(password, { delay: 15 });
      await page.mouse.click(712, 508);
      // Character select, or the connection-failure text.
      const end = Date.now() + 60_000;
      while (Date.now() < end && !consoleLines.some((l) => /character\(s\) on|connection failure/.test(l))) await page.waitForTimeout(1000);
      const fail = consoleLines.find((l) => l.includes('connection failure'));
      if (fail) { r.outcome = 'login-failed'; r.failure = fail; }
      else if (!consoleLines.some((l) => l.includes('character(s) on'))) { r.outcome = 'no-char-select'; }
      else {
        await page.waitForTimeout(2500);
        await page.mouse.click(709, 311); // Create Character
        await page.waitForTimeout(8000);
        await page.mouse.click(1175, 40); // Summary
        await page.waitForTimeout(2500);
        const name = playerName();
        appendFileSync(join(out, 'accounts.txt'), `${w.name}\tcharacter\t${name}\n`);
        await page.keyboard.type(name, { delay: 20 }); // the "[ Name ]" prompt is selected whole
        await page.mouse.click(1195, 737); // FINISH
        const end2 = Date.now() + 90_000;
        while (Date.now() < end2 && !consoleLines.some((l) => /we are in the world|creation failed|connection failure/.test(l))) await page.waitForTimeout(1000);
        if (consoleLines.some((l) => l.includes('we are in the world'))) {
          r.outcome = 'in-world';
          await page.waitForTimeout(25_000); // MOTD, welcome lines and any VPN / IP check
        } else {
          r.outcome = 'create-failed';
          r.failure = consoleLines.find((l) => /creation failed|connection failure/.test(l)) ?? 'no world entry within 90 s';
        }
      }
      r.serverText = [...new Set(frames)].filter((s) => /[a-z]{3,} [a-z]{2,}/i.test(s)).slice(0, 40);
      r.blocked = r.serverText.some((s) => BLOCK_PATTERN.test(s)) || BLOCK_PATTERN.test(r.failure ?? '');
      r.shot = join(out, `${w.name.replace(/[^A-Za-z0-9]/g, '_')}.png`);
      await page.screenshot({ path: r.shot });
    } catch (e) {
      r.failure = (e as Error).message.slice(0, 300);
    }
    r.seconds = Math.round((Date.now() - t0) / 1000);
    results.push(r);
    console.log(`${w.name.padEnd(20)} ${r.outcome.padEnd(15)} ${r.blocked ? 'BLOCKED' : ''} ${r.failure ?? ''}`.trimEnd());
    writeFileSync(join(out, 'report.json'), JSON.stringify(results, null, 2));
  }
  await profile.dispose();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
