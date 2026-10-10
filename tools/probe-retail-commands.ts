/**
 * probe-retail-commands — live checks of the ported retail chat-command
 * system (packages/renderer/src/chat/commands/, docs/retail-commands/),
 * two clients (A fxprobe1 / B fxprobe2) in Holtburg, every line typed into
 * the real chat box:
 *  help       /help prints the Note + "Available help:"; /help die the @die text
 *  die        @die opens the Yes/No dialog; No sends nothing
 *  fellow     /g hi → ChatChannel 0x800 (fellowship), never General
 *  general    /general hi → Turbine chat to the General room (type 2)
 *  pose       "hi *wave*" → SoulEmote + Talk "hi", "You wave." echoed locally
 *  afkpose    "*afk*" holds the AFK substate 0x4300011b (string2command on the 2017 table)
 *  loc        /loc → "Your location is: " + Position::ToString ("0xXXXXXXXX [x y z] w x y z")
 *  framerate  /framerate shows the FPS meter (0x10000047), again hides it
 *  fillcomps  with no vendor → "You need an open vendor."
 *  title      @title from the main chat → the popup-only error
 *  tell       A /tell B, hello → B hears it; B /r → A hears the reply
 *  unknown    /suicide → Talk "@suicide" to the server (no client command)
 *  emotes     /emotes prints the retail emote list
 * Writes verification/retail-commands/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-retail-commands.ts [--only a,b]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { shot } from './lib/game-session.ts';
import { openTwoClients, say, waitChat, chatLines, waitDialog, answerDialog } from './lib/two-client.ts';

const OUT = 'verification/retail-commands';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (k: string) => !ONLY || ONLY.has(k);

const spew = (p: Page) => p.evaluate('window.__ac.gameUI.spewBox.items.map((i) => i.text)') as Promise<string[]>;
const sends = (p: Page) => p.evaluate('(window.__ac.commandSends || []).map((s) => ({ type: s.type, bytes: s.bytes }))') as Promise<Array<{ type: number; bytes: number[] }>>;
const turbine = (p: Page) => p.evaluate('window.__ac.turbineSends || []') as Promise<Array<{ roomId: number; chatType: number; text: string }>>;
const clearSends = (p: Page) => p.evaluate('window.__ac.commandSends = []; window.__ac.turbineSends = [];');
const u32 = (b: number[], o = 0) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const str16 = (b: number[], o = 0) => { const n = b[o] | (b[o + 1] << 8); return String.fromCharCode(...b.slice(o + 2, o + 2 + n)); };

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 500)}`); };
  const { a, b, close } = await openTwoClients('retailcmds');
  try {
    const A = a.page;
    if (want('help')) {
      await say(A, '/help');
      const note = await waitChat(A, /^Note: You may substitute a forward slash \(\/\) for the at symbol \(@\)\.$/, 5000);
      const avail = await waitChat(A, /^Available help:/, 5000);
      await say(A, '/help die');
      const die = await waitChat(A, /^@die - If you wish to kill your character/, 5000);
      record('help', !!note && !!avail && !!die, { note, avail, die });
      await shot(A, `${OUT}/help.png`);
    }
    if (want('die')) {
      await clearSends(A);
      await say(A, '@die');
      const text = await waitDialog(A, 5000);
      await shot(A, `${OUT}/die-dialog.png`);
      await answerDialog(A, false);
      await A.waitForTimeout(800);
      const s = await sends(A);
      record('die', text === 'Do you really want to kill your character? You may drop items and accrue a vitae penalty.' && !s.some((x) => x.type === 0x279), { text, sends: s.map((x) => x.type.toString(16)) });
    }
    if (want('fellow')) {
      await clearSends(A);
      await say(A, '/g hi there');
      await A.waitForTimeout(600);
      const s = await sends(A);
      const ch = s.find((x) => x.type === 0x147);
      const t = await turbine(A);
      record('fellow', !!ch && u32(ch.bytes) === 0x800 && str16(ch.bytes, 4) === 'hi there' && t.length === 0, { ch: ch && { channel: u32(ch.bytes).toString(16), text: str16(ch.bytes, 4) }, turbine: t });
    }
    if (want('general')) {
      await clearSends(A);
      await say(A, '/general retail commands probe');
      await A.waitForTimeout(800);
      const t = await turbine(A);
      const heard = await waitChat(A, /retail commands probe/, 5000);
      record('general', t.some((x) => x.roomId === 2 && x.chatType === 2 && x.text === 'retail commands probe'), { turbine: t, heard });
    }
    if (want('pose')) {
      await clearSends(A);
      await say(A, 'hi *wave*');
      const you = await waitChat(A, /^You wave/, 5000);
      const s = await sends(A);
      const soul = s.find((x) => x.type === 0x1e1);
      const talk = s.find((x) => x.type === 0x15);
      const bSaw = await waitChat(b.page, new RegExp(`${a.name.replace(/[+]/g, "\\+")}.* wave`), 5000);
      record('pose', !!you && !!soul && !!talk && str16(talk.bytes) === 'hi', { you, soul: soul && str16(soul.bytes), talk: talk && str16(talk.bytes), bSaw });
      await shot(A, `${OUT}/pose.png`);
    }
    if (want('afkpose')) {
      await say(A, '*afk*');
      await A.waitForTimeout(1500);
      const sub = await A.evaluate('window.__ac.animController ? window.__ac.animController.heldSubstate >>> 0 : -1') as number;
      record('afkpose', sub === 0x4300011b, { substate: '0x' + (sub >>> 0).toString(16) });
      await shot(A, `${OUT}/afk-pose.png`);
      await say(A, 'back');
      await A.waitForTimeout(800);
    }
    if (want('loc')) {
      await say(A, '/loc');
      const loc = await waitChat(A, /^Your location is: 0x[0-9A-F]{8} \[-?\d+\.\d{6} -?\d+\.\d{6} -?\d+\.\d{6}\] -?\d+\.\d{6} -?\d+\.\d{6} -?\d+\.\d{6} -?\d+\.\d{6}$/, 5000);
      record('loc', !!loc, { loc, last: (await chatLines(A)).slice(-2) });
    }
    if (want('framerate')) {
      const meter = () => A.evaluate(`(() => { const el = document.querySelector('.ac-viewport-frame [data-element-id="0x10000047"]');
        if (!el) return { found: false };
        const cs = getComputedStyle(el); return { found: true, visible: cs.display !== 'none' && cs.visibility !== 'hidden', text: el.textContent || el.getAttribute('data-text') || '' }; })()`) as Promise<{ found: boolean; visible?: boolean; text?: string }>;
      const before = await meter();
      await say(A, '/framerate');
      await A.waitForTimeout(1500);
      const on = await meter();
      await shot(A, `${OUT}/framerate-on.png`);
      await say(A, '/framerate');
      await A.waitForTimeout(500);
      const off = await meter();
      record('framerate', before.found && !before.visible && !!on.visible && !off.visible, { before, on, off });
    }
    if (want('fillcomps')) {
      await say(A, '/fillcomps');
      await A.waitForTimeout(600);
      const s = await spew(A);
      record('fillcomps', s.includes('You need an open vendor.'), { spew: s.slice(-3) });
    }
    if (want('title')) {
      await say(A, '@title My Window');
      const line = await waitChat(A, /^This command must be issued from a popup chat window\.$/, 4000);
      record('title', !!line, { line });
    }
    if (want('tell')) {
      await say(A, `/tell ${b.name}, retail tell probe`);
      const bHeard = await waitChat(b.page, /retail tell probe/, 8000);
      await say(b.page, '/r retail reply probe');
      const aHeard = await waitChat(A, /retail reply probe/, 8000);
      record('tell', !!bHeard && !!aHeard, { bHeard, aHeard });
    }
    if (want('unknown')) {
      await clearSends(A);
      await say(A, '/suicide');
      await A.waitForTimeout(800);
      const s = await sends(A);
      const talk = s.find((x) => x.type === 0x15);
      const after = (await chatLines(A)).slice(-2);
      record('unknown', !!talk && str16(talk.bytes) === '@suicide' && !s.some((x) => x.type === 0x279), { talk: talk && str16(talk.bytes), after });
    }
    if (want('emotes')) {
      await say(A, '/emotes');
      const list = await waitChat(A, /^Standard Emotes:$/, 4000);
      const names = await waitChat(A, /^ShakeFist; Beckon; BeSeeingYou;/, 4000);
      record('emotes', !!list && !!names, { list, names });
      await shot(A, `${OUT}/emotes.png`);
    }
  } finally {
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    await close();
  }
  if (fails.length) { console.log(`FAILED: ${fails.join(', ')}`); process.exit(1); }
  console.log('ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
