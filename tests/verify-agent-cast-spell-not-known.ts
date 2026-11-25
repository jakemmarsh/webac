/**
 * BUG.spellbook-stale-char-switch (Seedsow, classic-dereth GDLE, trace 92313d167e79eab8, 2026-11-25 03:03–03:14Z).
 *
 * One page entered three characters (char_list 2, 2, then 3: a new one was made). The client's spellbook mirror
 * (MagicController) was only ever added to: teardownWorldState never cleared it and PlayerDescription only learned
 * spells not already "known". So the third character's book still held the first two characters' spells, and the
 * VTank-style macro started on it picked them: 8 casts in 2 min refused WeenieError 0x03FE "You don't know that
 * spell!" (GDLE SpellcastingManager TryBeginCast → WERROR_MAGIC_UNLEARNED_SPELL when !IsSpellKnown), a reply the
 * cast-result reading didn't take for a failure, so the routine kept going back to them.
 *
 * The spellbook itself is cleared on a character switch (tests/verify-spellbook-stale-char-switch.ts). This file
 * pins the other half: the macro's reading of that refusal.
 *  - castReply: "You don't know that spell!" is a cast that did not land (SPELL_NOT_KNOWN / CAST_NOT_LANDED).
 *  - AgentApi: a cast the server refuses so (by its WeenieError code or its line) drops that spell from the
 *    client's spellbook through AgentHost.spellNotKnown, so no planner or ac_cast picks it again, and says so once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { CAST_NOT_LANDED, SPELL_NOT_KNOWN, castConfirmed } from '../packages/renderer/src/agent/macro/castReply.ts';
import type { AgentResult, AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { WeenieError } from '../packages/shared/src/index.ts';
import { FakeHost } from './_harness/agentFake.ts';

describe('"You don\'t know that spell!" is a cast that did not land (castReply)', () => {
  it('SPELL_NOT_KNOWN and CAST_NOT_LANDED match the GDLE / AC1999 line; castConfirmed is false', () => {
    expect(SPELL_NOT_KNOWN.test("You don't know that spell!")).toBe(true);
    expect(CAST_NOT_LANDED.test("You don't know that spell!")).toBe(true);
    const res: AgentResult = { ok: true, message: "casting Strength Self I on yourself\n  You don't know that spell!" };
    expect(castConfirmed(res, 'Strength Self I')).toBe(false);
    // A landed cast is still a landed cast.
    expect(castConfirmed({ ok: true, message: 'casting Strength Self I on yourself\n  You cast Strength Self I on yourself' }, 'Strength Self I')).toBe(true);
  });
});

describe('AgentApi: a cast the server refuses as unknown drops that spell, once', () => {
  let host: FakeHost;
  let api: AgentApi;
  let book: AgentSpell[];
  let dropped: number[];
  let castsSent: number;
  /** The server's answer to cast n (from 1). */
  let reply: (n: number, id: number) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    api = new AgentApi(host);
    book = [
      { id: 1, name: 'Strength Self I', school: 'Creature Enchantment', level: 1, self: true },
      { id: 6, name: 'Heal Self I', school: 'Life Magic', level: 1, self: true },
    ];
    host.spells = () => book;
    dropped = [];
    // main.ts: magicController.forgetSpell + a spellbook refresh.
    (host as unknown as { spellNotKnown: (id: number) => void }).spellNotKnown = (id) => { dropped.push(id); book = book.filter((s) => s.id !== id); };
    host.me.combatMode = 'magic';
    castsSent = 0;
    reply = () => {};
    host.cast = (id: number, t: number | null) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      const n = ++castsSent;
      setTimeout(() => reply(n, id), 300);
      return true;
    };
  });
  afterEach(() => vi.useRealTimers());

  async function settle(p: Promise<AgentResult>, ms = 20_000): Promise<{ r: AgentResult; tookMs: number }> {
    let out: AgentResult | undefined;
    const t = Date.now();
    void p.then((r) => { out = r; });
    for (let i = 0; i < ms && out === undefined; i += 100) await vi.advanceTimersByTimeAsync(100);
    if (!out) throw new Error('cast never answered');
    return { r: out, tookMs: Date.now() - t };
  }

  it('GDLE\'s WeenieError 0x03FE with its line: not cast, dropped from the book, said once; the next try is not sent', async () => {
    reply = () => {
      api.pushWeenieError(WeenieError.YouDontKnowThatSpell);
      api.pushChat("You don't know that spell!", 0x1a);
    };
    const { r, tookMs } = await settle(api.cast('Strength Self I', 'self'));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Strength Self I not cast: the server says you don't know Strength Self I \(spell 1\)/);
    expect(dropped).toEqual([1]);
    // Read at once, not after the 8 s outcome wait.
    expect(tookMs).toBeLessThan(2000);
    // Said once, to the agent's chat.
    const notes = api.eventsSince().filter((e) => e.type === 'chat' && /\[Agent\] The server says you don't know Strength Self I/.test(e.text));
    expect(notes).toHaveLength(1);
    // The routine's list (AgentApi.spells, what vtMacro.spells() reads) no longer has it; the other spell stays.
    expect(api.spells('', 1000).map((s) => s.id)).toEqual([6]);
    // Asked again: refused before anything is sent.
    const again = await settle(api.cast('Strength Self I', 'self'));
    expect(again.r.ok).toBe(false);
    expect(castsSent).toBe(1);
    expect(dropped).toEqual([1]);
  });

  it('the code alone (the line went to the spew, not the chat) is enough', async () => {
    reply = () => { api.pushWeenieError(WeenieError.YouDontKnowThatSpell); };
    const { r, tookMs } = await settle(api.cast('Strength Self I', 'self'));
    expect(r.ok).toBe(false);
    expect(dropped).toEqual([1]);
    expect(tookMs).toBeLessThan(2000);
  });

  it('the AC1999 / UseDone path (a use-failed refusal with the text) is read the same way', async () => {
    reply = () => { api.pushUseDone(WeenieError.YouDontKnowThatSpell, 'YouDontKnowThatSpell', "You don't know that spell!"); };
    const { r } = await settle(api.cast('Strength Self I', 'self'));
    expect(r.ok).toBe(false);
    expect(dropped).toEqual([1]);
  });

  it('the opposite failure: a landed cast, a fizzle, or a 0x03FE from before the cast drops nothing', async () => {
    // An earlier, unrelated refusal is not this cast's answer.
    api.pushWeenieError(WeenieError.YouDontKnowThatSpell);
    reply = (n) => {
      if (n === 1) api.pushChat('You cast Strength Self I on yourself', 0x16);
      else api.pushChat('Your spell fizzled.', 0x16);
    };
    const a = await settle(api.cast('Strength Self I', 'self'));
    expect(a.r.ok).toBe(true);
    const b = await settle(api.cast('Heal Self I', 'self'));
    expect(b.r.ok).toBe(false);
    expect(dropped).toEqual([]);
    expect(api.spells('', 1000).map((s) => s.id)).toEqual([1, 6]);
  });
});
