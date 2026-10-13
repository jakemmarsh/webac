/**
 * What a player has seen a kind of creature do (2026-10-12): Jake's archer judged Tusker Worshippers (level-V bolts)
 * from a world-DB read, and Arcanist + Bulwark met Dungeon Fern's liches (Frost Bolt II for 40; Bulwark 36 → 13 → dead
 * in two spells) as if they were drudges. observe now carries, per creature name, the spells that kind cast at you
 * (from the server's own lines) and its biggest hit, on its monster lines and the target line. Nothing hidden: only
 * lines the player read. Driven through the real AgentApi on the fake host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { FakeHost } from './_harness/agentFake.ts';

describe('observe: what a kind of creature was seen doing to you', () => {
  let host: FakeHost;
  let api: AgentApi;
  const LICH = 0x80004542, LICH2 = 0x800045be, DRUDGE = 0x80004001, MAGE = 0x50000003;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.add({ guid: LICH, name: 'Lich', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30, level: 20 });
    host.add({ guid: LICH2, name: 'Lich', itemType: 0x10, objectDescFlags: 0x10, x: 84, y: 30 });
    host.add({ guid: DRUDGE, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 76, y: 22 });
    host.add({ guid: MAGE, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 79, y: 21 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the liches\' lines (Dungeon Fern, 23:49 UTC) become one hint on every Lich, and on the target line', () => {
    api.pushChat('Lich scratches your upper leg for 6 points of slashing damage!', 0x15);
    api.pushChat('Lich scratches your upper arm for 3 points of slashing damage!', 0x15);
    api.pushChat('Lich freezes you for 40 points with Frost Bolt II.', 0x15);
    api.pushChat('Lich cast Bafflement Other II on you', 0x07);
    api.pushChat('You lose 0 points of health due to Lich casting Drain Health Other II on you', 0x07);
    api.pushChat('You resist the spell cast by Lich', 0x07);
    const want = 'casts Frost Bolt II (40), Bafflement Other II, Drain Health Other II; hits up to 6';
    expect(api.seenText('Lich')).toBe(want);
    host.select(LICH);
    const obs = api.observe();
    expect(obs.target?.seen).toBe(want);
    // Per kind, not per instance: the other Lich carries it too; a drudge that did nothing carries nothing.
    expect(obs.nearby.find((o) => o.guid === LICH2)?.seen).toBe(want);
    expect(obs.nearby.find((o) => o.guid === DRUDGE)?.seen).toBeUndefined();
    const text = formatObservation(obs);
    expect(text).toMatch(/target: #80004542\s+Lich\s+\[monster L20\]\s.*seen: casts Frost Bolt II \(40\), Bafflement Other II, Drain Health Other II; hits up to 6/);
  });

  it('a monster heard speaking spell words casts, the spell unnamed; your own hits and a fellow\'s buff on you say nothing', () => {
    api.pushChat('Drudge Skulker says, "Zojak Quaguz"', 0x11);
    expect(api.seenText('Drudge Skulker')).toBe('casts spells (heard its spell words)');
    api.pushChat('You hit Lich for 12 points of piercing damage!', 0x15);
    api.pushChat('Claude Arcanist cast Strength Other III on you', 0x07);
    expect(api.seenText('Lich')).toBeNull();
    expect(api.seenText('Claude Arcanist')).toBeNull();
    // Kept for the session: the creature leaving view doesn't forget what its kind did.
    api.pushChat('Drudge Skulker hits your chest for 9 points of bludgeoning damage!', 0x15);
    host.objs.delete(DRUDGE);
    expect(api.seenText('Drudge Skulker')).toBe('casts spells (heard its spell words); hits up to 9');
  });
});
