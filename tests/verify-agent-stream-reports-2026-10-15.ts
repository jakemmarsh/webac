/**
 * Four agent-tool bugs the stream players (Claude Arcanist / Claude Bulwark) hit on 2026-10-15
 * (docs/agent-play.md, "Stream reports, 2026-10-15"):
 *  1. ac_wait handed back aggro / attackers-up / cast-at-you events for monsters already dead.
 *  2. "/tell Claude Bulwark hi, …" went to "Claude Bulwark hi" with no hint (the hint only came without any comma).
 *  3. ac_equip said "equipped Large Round Shield" while the server refused it (an Orb held), and ac_gear called the
 *     shield slot EMPTY beside the Orb.
 *  4. cast repeat=true stopped for any new attacker, three 1-damage lurkers included.
 * Each test drives the real AgentApi / gear module against the fake host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatGear, gearNote, gearView, shieldHandTakenBy } from '../packages/renderer/src/agent/gear.ts';
import type { AgentEvent, AgentItem, AgentResult } from '../packages/renderer/src/agent/types.ts';
import { FakeHost } from './_harness/agentFake.ts';

const BRIGAND = 0x80000101;
const BANDIT = 0x80000102;
const HUNTER = 0x800082d2;
const BULWARK = 0x50000002;

const creature = (host: FakeHost, guid: number, name: string, x: number, y: number, level?: number): void => {
  host.add({ guid, name, itemType: 0x10, objectDescFlags: 0x10, x, y, ...(level ? { level } : {}) });
};

describe('1. waits leave out threat events about creatures that are dead or gone', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    creature(host, BRIGAND, 'Brigand', 83, 20);
    creature(host, BANDIT, 'Bandit', 80, 23);
  });
  afterEach(() => vi.useRealTimers());

  async function waitFor(types: AgentEvent['type'][], ms = 1000): Promise<AgentEvent[]> {
    const p = api.wait({ types }, ms);
    await vi.advanceTimersByTimeAsync(ms + 100);
    return p;
  }

  it('queued "coming at you" events for monsters killed since are dropped when the wait returns', async () => {
    api.push('aggro', 'Brigand is coming at you', BRIGAND);
    api.push('aggro', 'Bandit is coming at you', BANDIT);
    // Both die before the player waits: one dying on screen, the other already gone from the client's world.
    host.dying.add(BRIGAND);
    host.objs.delete(BANDIT);
    expect(await waitFor(['aggro'])).toEqual([]);
  });

  it('a live one is still reported beside the dead ones', async () => {
    api.push('aggro', 'Brigand is coming at you', BRIGAND);
    api.push('aggro', 'Bandit is coming at you', BANDIT);
    host.dying.add(BRIGAND);
    expect((await waitFor(['aggro'])).map((e) => e.guid)).toEqual([BANDIT]);
  });

  it('attackers-up from a CombatEnemy line is dropped once that attacker died', async () => {
    api.pushChat('The Brigand hits your chest for 3 points of slashing damage!', 0x15);
    host.objs.delete(BRIGAND);
    const evs = await waitFor(['attackers-up', 'attacked']);
    // The hit itself happened (attacked stays); "another creature joined in" about a dead one does not.
    expect(evs.map((e) => e.type)).toEqual(['attacked']);
  });

  it('a kill reported for a creature drops its earlier events even while the client still shows it (Hea Hunter)', async () => {
    creature(host, HUNTER, 'Hea Hunter', 85, 20);
    api.push('aggro', 'Hea Hunter is coming at you', HUNTER);
    api.push('attackers-up', '2 creatures attacking you now (+Hea Hunter #800082d2)', HUNTER);
    api.push('target-died', 'Hea Hunter #800082d2 died', HUNTER);
    expect(await waitFor(['aggro', 'attackers-up'])).toEqual([]);
    // A later event about the same guid, plainly alive (a kill line can name its twin), is not swallowed.
    api.push('aggro', 'Hea Hunter is coming at you', HUNTER);
    expect((await waitFor(['aggro'])).map((e) => e.guid)).toEqual([HUNTER]);
  });

  it('a waiting wait wakes only for a live creature, and its result holds no dead ones', async () => {
    api.push('aggro', 'Brigand is coming at you', BRIGAND);
    host.dying.add(BRIGAND);
    let got: AgentEvent[] | null = null;
    void api.wait({ types: ['aggro', 'cast-at-you'] }, 5000).then((e) => { got = e; });
    await vi.advanceTimersByTimeAsync(200);
    expect(got).toBeNull(); // the dead Brigand's event didn't wake it
    api.push('aggro', 'Brigand is coming at you', BRIGAND); // a late sample about the dying one
    await vi.advanceTimersByTimeAsync(200);
    expect(got).toBeNull();
    api.push('aggro', 'Bandit is coming at you', BANDIT);
    await vi.advanceTimersByTimeAsync(10);
    expect(got!.map((e) => e.guid)).toEqual([BANDIT]);
  });

  it('a spell line is credited to its caster, and dropped once the caster is dead', async () => {
    api.pushChat('Brigand casts Drain Health Other I and drains 4 points of your health.', 0x07); // Magic (ACE WorldObject_Magic); AdminTell (0x1f) is someone's words
    const before = api.events_(0).filter((e) => e.type === 'cast-at-you');
    expect(before.map((e) => e.guid)).toEqual([BRIGAND]);
    host.objs.delete(BRIGAND);
    expect(await waitFor(['cast-at-you'])).toEqual([]);
  });
});

describe('2. /tell with a multi-word name and no comma after it', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    host = new FakeHost();
    api = new AgentApi(host);
  });

  // Since 2026-10-17 14:11Z the agent tool puts the comma in after a known player's name (Bulwark's "/t Claude Arcanist
  // Here, …" went to a "Claude Arcanist Here"); the player's own chat box still sends what is typed, as retail's does.
  it('a comma later in the message: the comma goes in after the player in view, every time', () => {
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 90, y: 20 });
    for (let i = 0; i < 3; i++) {
      const r = api.say('/tell Claude Bulwark hi, ready to go?');
      expect(r.ok).toBe(true);
      expect(r.message).toContain('would have gone to "Claude Bulwark hi"');
      expect(r.message).toMatch(/^sent: \/tell Claude Bulwark, hi, ready to go\?\n/);
    }
    expect(host.chats).toEqual(Array(3).fill('/tell Claude Bulwark, hi, ready to go?'));
  });

  it('knows the name from a fellowship and from tells exchanged, out of view', () => {
    host.fellows = () => [{ guid: BULWARK, name: 'Claude Bulwark', health: { cur: 50, max: 50 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
    expect(api.say('/t Claude Bulwark come here, please').message).toMatch(/^sent: \/t Claude Bulwark, come here, please\n/);
    host.fellows = undefined;
    api.pushChat('Claude Arcanist tells you, "where are you?"', 0x3);
    const r = api.say('@tell Claude Arcanist by the portal, come');
    expect(r.ok).toBe(true);
    expect(host.chats).toContain('@tell Claude Arcanist, by the portal, come');
  });

  it('no comma at all: the comma goes in after a known name; an unknown one still says where the comma goes', () => {
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 90, y: 20 });
    expect(api.say('/whisper Claude Bulwark hi').message).toMatch(/^sent: \/whisper Claude Bulwark, hi\n  \(a comma went in after Claude Bulwark: .*, or with no comma at all nowhere\. Write \/tell Name, message\)$/);
    expect(api.say('/whisper Somebody hi')).toEqual({ ok: false, message: "sent: /whisper Somebody hi\n  not delivered: a tell needs a comma after the name (names with spaces too), as retail's /tell does (\"Use comma after the name for targeted chat.\"): /tell Their Name, your message" });
  });

  it('a right tell, an unknown name with a comma, and other "@" commands are as before', () => {
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 90, y: 20 });
    expect(api.say('/tell Claude Bulwark, hi, ready?')).toEqual({ ok: true, message: 'sent: /tell Claude Bulwark, hi, ready?' });
    expect(api.say('/tell Somebody Else, hi')).toEqual({ ok: true, message: 'sent: /tell Somebody Else, hi' });
    expect(api.say('@teleto Holtburg').ok).toBe(false);
    expect(host.chats).not.toContain('@teleto Holtburg');
  });
});

describe('3. equip waits for the server, and an Orb takes the shield hand', () => {
  let host: FakeHost;
  let api: AgentApi;
  const ORB: AgentItem = { guid: 0x80001001, name: 'Orb', where: 'equipped', mask: 0x1000000, validLocations: 0x1000000, itemType: 0x8000 };
  const SHIELD: AgentItem = { guid: 0x80001002, name: 'Large Round Shield', where: 'main pack', validLocations: 0x200000, itemType: 0x2, armorLevel: 60 };
  const SWORD: AgentItem = { guid: 0x80001003, name: 'Long Sword', where: 'main pack', validLocations: 0x100000, itemType: 0x1 };
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
  });
  afterEach(() => vi.useRealTimers());

  async function settle(p: Promise<AgentResult>, ms = 6000): Promise<AgentResult> {
    await vi.advanceTimersByTimeAsync(ms);
    return p;
  }

  it('gear: the shield slot beside a held Orb is taken, not EMPTY, and the shield is not offered for it', () => {
    const items = [ORB, SHIELD];
    expect(shieldHandTakenBy(items)?.name).toBe('Orb');
    const v = gearView(items);
    expect(v.lines.find((l) => l.trim().startsWith('shield:'))).toBe('  shield:     none: your Orb #80001001 (a caster) takes this hand too (no shield beside it)');
    expect(v.emptyOther).not.toContain('shield');
    expect(v.packFills.map((f) => f.slot)).not.toContain('shield');
    const note = gearNote(SHIELD, items);
    expect(note).not.toMatch(/EMPTY/);
    expect(note).toContain("can't go on now: your Orb #80001001 (a caster) takes the shield hand too");
    expect(formatGear(items)).not.toMatch(/fills your EMPTY shield/);
  });

  it('gear: a one-handed sword or a thrown weapon leaves the shield slot free; a two-hander or a bow takes it', () => {
    const sword = { ...SWORD, where: 'equipped', mask: 0x100000 };
    expect(gearNote(SHIELD, [sword, SHIELD])).toContain('fills your EMPTY shield slot');
    const darts: AgentItem = { guid: 0x80001004, name: 'Throwing Darts', where: 'equipped', mask: 0x400000, itemType: 0x100 };
    expect(shieldHandTakenBy([darts])).toBeNull();
    const bow: AgentItem = { guid: 0x80001005, name: 'Longbow', where: 'equipped', mask: 0x400000, itemType: 0x100, ammoType: 1 };
    expect(gearNote(SHIELD, [bow, SHIELD])).toContain('your Longbow #80001005 (a bow or launcher) takes the shield hand too');
    const greatsword: AgentItem = { guid: 0x80001006, name: 'Greatsword', where: 'equipped', mask: 0x2000000, itemType: 0x1 };
    expect(gearView([greatsword]).lines.some((l) => l.includes('Greatsword #80001006 (a two-handed weapon) takes this hand too'))).toBe(true);
  });

  it('equip: a shield beside the Orb is refused before it is sent, saying what to do', async () => {
    host.inv = [ORB, SHIELD];
    const r = await api.equip('Large Round Shield');
    expect(r.ok).toBe(false);
    expect(r.message).toBe('not equipped: Large Round Shield: your Orb #80001001 (a caster) takes the shield hand too, and the server refuses a shield beside it; equip a one-handed weapon first (it replaces the Orb), then the shield');
    expect(host.sent).toEqual([]);
  });

  it('equip: the client\'s optimistic wield is not success until the server confirms; its refusal is a failure', async () => {
    host.inv = [{ ...SHIELD }];
    let pending = false;
    host.inventoryPending = () => pending;
    // The client moves it onto the paperdoll at once, and the server refuses 800 ms later (rolled back).
    host.wield = (g: number) => {
      host.sent.push(`wield ${g.toString(16)}`);
      host.inv = [{ ...SHIELD, where: 'equipped', mask: 0x200000 }];
      pending = true;
      setTimeout(() => { host.inv = [{ ...SHIELD }]; pending = false; api.pushChat("The Large Round Shield can't be wielded", 0x1a); }, 800);
      return true;
    };
    const r = await settle(api.equip('Large Round Shield'));
    expect(r).toEqual({ ok: false, message: "not equipped: Large Round Shield: The Large Round Shield can't be wielded" });
    // Confirmed by the server (WieldObject clears the pending move): equipped.
    host.wield = (g: number) => {
      host.inv = [{ ...SHIELD, where: 'equipped', mask: 0x200000 }];
      pending = true;
      setTimeout(() => { pending = false; }, 500);
      return g > 0;
    };
    expect(await settle(api.equip('Large Round Shield'))).toEqual({ ok: true, message: 'equipped Large Round Shield (shield hand)' });
  });

  it('equip: a host that can\'t say whether the server answered waits a moment for a refusal', async () => {
    host.inv = [{ ...SHIELD }];
    host.wield = () => {
      host.inv = [{ ...SHIELD, where: 'equipped', mask: 0x200000 }];
      setTimeout(() => { host.inv = [{ ...SHIELD }]; api.pushChat("The Large Round Shield can't be wielded", 0x1a); }, 700);
      return true;
    };
    expect((await settle(api.equip('Large Round Shield'))).ok).toBe(false);
  });

  it('equip: no answer at all is not reported as equipped', async () => {
    host.inv = [{ ...SWORD }];
    host.wield = () => true;
    const r = await settle(api.equip('Long Sword'));
    expect(r).toEqual({ ok: false, message: 'not equipped: Long Sword: no answer from the server in 4 s (ac_inventory in a moment shows whether it went through)' });
    // Shown on the paperdoll but never confirmed: said so, not "equipped".
    host.inventoryPending = () => true;
    host.wield = () => { host.inv = [{ ...SWORD, where: 'equipped', mask: 0x100000 }]; return true; };
    host.inv = [{ ...SWORD }];
    const q = await settle(api.equip('Long Sword'));
    expect(q.ok).toBe(false);
    expect(q.message).toMatch(/^not equipped: Long Sword yet: the client shows it, but the server has not confirmed it in 4 s/);
  });
});

describe('4. cast repeat stops for a dangerous new attacker, not for every one', () => {
  const TARGET = 0x80000080;
  const LURKER = [0x80000201, 0x80000202, 0x80000203];
  let host: FakeHost;
  let api: AgentApi;
  let reply: (n: number) => void;
  let castsSent: number;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    api = new AgentApi(host);
    host.spells = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1, projectile: true, range: 20 }];
    (host as unknown as { lineOfFire: () => { dist: number; blockedAt: null } }).lineOfFire = () => ({ dist: 8, blockedAt: null });
    creature(host, TARGET, 'Drudge Skulker', 80, 28);
    host.me.mana = { current: 600, max: 600 };
    castsSent = 0;
    reply = () => api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
    host.cast = (id: number, t: number | null) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      const n = ++castsSent;
      setTimeout(() => { host.me.mana.current -= 10; reply(n); }, 600);
      return true;
    };
  });
  afterEach(() => vi.useRealTimers());

  async function settle(p: Promise<AgentResult>, ms = 60_000): Promise<AgentResult> {
    let out: AgentResult | undefined;
    void p.then((r) => { out = r; });
    for (let t = 0; t < ms && out === undefined; t += 200) await vi.advanceTimersByTimeAsync(200);
    if (!out) throw new Error('repeat never answered');
    return out;
  }

  it('three lurkers hitting for 1 join in: it casts on until the target dies, and names them', async () => {
    LURKER.forEach((g, i) => creature(host, g, 'Lurker', 82 + i, 21, 3));
    reply = (n) => {
      api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
      if (n === 1) api.pushChat('The Lurker hits your leg for 1 point of piercing damage!', 0x15);
      if (n === 2) { api.pushChat('The Lurker hits your arm for 1 point of piercing damage!', 0x15); api.pushChat('The Lurker hits your arm for 1 point of piercing damage!', 0x15); }
      if (n === 4) host.dying.add(TARGET);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(castsSent).toBe(4);
    expect(r.message.split('\n')[0]).toBe('cast Flame Bolt I at Drudge Skulker 4 times (repeat); stopped: Drudge Skulker died');
    expect(r.message).toMatch(/joined in meanwhile: Lurker #8000020\d \(hits up to 1\)/);
    expect(r.message).toContain("a new attacker (or one on you from the start, after the first cast) stops it only when it casts, hits for 10%+ of the health you have, or is above your level and hasn't hit you yet (or 15+ above)");
  });

  it('a new attacker whose hit takes a tenth of your health stops it, saying so', async () => {
    creature(host, 0x80000082, 'Mosswart', 83, 20);
    reply = (n) => {
      api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
      if (n === 2) api.pushChat('The Mosswart hits your chest for 6 points of bludgeoning damage!', 0x15);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(castsSent).toBe(2);
    expect(r.message.split('\n')[0]).toBe("cast Flame Bolt I at Drudge Skulker 2 times (repeat); stopped: Mosswart #80000082 (1× in 10 s; one hit of its took 6, 12% of the 50 health you have) started attacking you, and isn't your target");
  });

  it('a new attacker seen casting, or one above your level not yet seen hitting, stops it', async () => {
    creature(host, 0x80000083, 'Shadow', 83, 20);
    api.pushChat('Shadow casts Drain Health Other I and drains 2 points of your health.', 0x07); // seen before the repeat (Magic)
    reply = (n) => {
      api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
      if (n === 1) api.pushChat('The Shadow misses you!', 0x15);
    };
    let r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(r.message.split('\n')[0]).toMatch(/stopped: Shadow #80000083 \(1× in 10 s; it casts Drain Health Other I\) started attacking you/);
    host.objs.delete(0x80000083);
    creature(host, 0x80000084, 'Mosswart Elder', 83, 22, 12);
    castsSent = 0;
    vi.advanceTimersByTime(11_000); // the Shadow's lines age out
    reply = (n) => {
      api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
      // Only a miss: its danger is unknown (a higher-level one that has hit lightly is cast on through: 2026-10-18 tests).
      if (n === 1) api.pushChat('The Mosswart Elder misses you!', 0x15);
    };
    r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(r.message.split('\n')[0]).toMatch(/stopped: Mosswart Elder #80000084 \(1× in 10 s; level 12, above your 5, and it hasn't hit you yet\) started attacking you/);
  });
});
