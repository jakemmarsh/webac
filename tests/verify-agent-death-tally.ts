/**
 * Stream night 2026-10-15 (00:40–01:50 UTC), Olthoi Arcade: Claude Arcanist (L24 mage) died three times in about an hour
 * to packs of ~10 Olthoi and the pair kept going back (Jake: "they keep dying, are they not re-evaluating?").
 *
 * - Each death reached the agent as a bare "you died": no tally, no cost, no killer level. The death event and
 *   observe's deaths line now say, as facts, which death this is this session and in this landblock, what killed you
 *   at what level against yours, and what each cost (the "You've lost …" line: ACE Player_Death.DropMessage).
 * - The partner's death reaches the other player as a fellow-low event with their tally (ACE Fellowship.OnDeath's
 *   "Your fellow … has died!", after the bystander's death line; AC1999 has only the bystander line).
 * - deathLines.ts reads every victim / bystander template of ACE Strings.cs and the AC1999 server.
 *
 * Driven through the real AgentApi on the fake host, with the real lines from mage.chat.log / soldier.chat.log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import {
  BROADCAST_DEATH_TEMPLATES, VICTIM_DEATH_TEMPLATES, lossText, parseDeathBroadcast, parseDeathLoss, parseFellowDied, parseVictimDeathLine,
} from '../packages/renderer/src/agent/deathLines.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const ARCADE = 0x5b430475; // the Arcade entrance cell Bulwark named
const HARVESTER = 0x8000c001;
const GARDENER = 0x8000c002;
const ARCANIST = 0x50000002;

describe('deathLines: the servers\' death and loss lines', () => {
  it('every victim template gives back its killer (ACE Strings.cs and AC1999 WeenieObject.cpp); "You died!" names no one', () => {
    for (const t of VICTIM_DEATH_TEMPLATES) {
      const line = t.replace('{1}', 'Olthoi Harvester').replace('{0}', 'Claude Arcanist');
      expect(parseVictimDeathLine(line), line).toEqual({ killer: t.includes('{1}') ? 'Olthoi Harvester' : null });
    }
    expect(parseVictimDeathLine("You are utterly destroyed by Olthoi Harvester's attack!")).toEqual({ killer: 'Olthoi Harvester' });
    expect(parseVictimDeathLine('Olthoi Gardener reduces you to a sizzling, oozing mass!')).toEqual({ killer: 'Olthoi Gardener' });
    expect(parseVictimDeathLine("The force of Mud Golem's assault flattens you!")).toEqual({ killer: 'Mud Golem' });
    // Not deaths: hits, your own kills, speech.
    expect(parseVictimDeathLine('Olthoi Harvester blisters your lower leg for 6 points of acid damage!')).toBeNull();
    expect(parseVictimDeathLine('You slay Olthoi Gardener viciously enough to impart death several times over!')).toBeNull();
    expect(parseVictimDeathLine('Claude Bulwark says, "Olthoi obliterates you!"')).toBeNull();
  });

  it('every bystander template names the fellow and the killer; other people\'s deaths and kills are not a fellow\'s', () => {
    for (const t of BROADCAST_DEATH_TEMPLATES) {
      const line = t.replace('{1}', 'Olthoi Harvester').replace('{0}', 'Claude Arcanist');
      expect(parseDeathBroadcast(line, ['Claude Arcanist']), line).toEqual({ victim: 'Claude Arcanist', killer: 'Olthoi Harvester' });
    }
    expect(parseDeathBroadcast("Claude Arcanist is utterly destroyed by Olthoi Harvester's attack!", ['Claude Arcanist'])).toEqual({ victim: 'Claude Arcanist', killer: 'Olthoi Harvester' });
    expect(parseDeathBroadcast("Someone Else is utterly destroyed by Olthoi Harvester's attack!", ['Claude Arcanist'])).toBeNull();
    expect(parseDeathBroadcast('The thunder of crushing Olthoi Harvester is followed by the deafening silence of death!', ['Claude Arcanist'])).toBeNull();
    expect(parseFellowDied('Your fellow Claude Arcanist has died!')).toBe('Claude Arcanist');
    expect(parseFellowDied('Your fellow Claude Arcanist says hi')).toBeNull();
  });

  it('"You\'ve lost …" as pyreals and items (the three Arcade deaths\' lines)', () => {
    expect(parseDeathLoss("You've lost 4,948 Pyreals, your Necklace, your Bracelet, and your Malachite!")).toEqual({ pyreals: 4948, items: ['Necklace', 'Bracelet', 'Malachite'] });
    expect(parseDeathLoss("You've lost 1,556 Pyreals, and your Necklace!")).toEqual({ pyreals: 1556, items: ['Necklace'] });
    expect(parseDeathLoss("You've lost 778 Pyreals, your Bracelet, and your Necklace!")).toEqual({ pyreals: 778, items: ['Bracelet', 'Necklace'] });
    expect(parseDeathLoss("You've lost your Necklace!")).toEqual({ pyreals: 0, items: ['Necklace'] });
    expect(parseDeathLoss("You've lost 22 Pyreals, your 5 Mana Stones, and your Wand!")).toEqual({ pyreals: 22, items: ['5 Mana Stones', 'Wand'] });
    expect(parseDeathLoss('You lost the fight.')).toBeNull();
    expect(lossText({ pyreals: 778, items: ['Bracelet', 'Necklace'] })).toBe('778 pyreals, Bracelet and Necklace');
    expect(lossText(null)).toBe('nothing dropped');
  });
});

describe('the death tally: each death read against the ones before it', () => {
  let host: FakeHost;
  let api: AgentApi;
  let wall = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.level = 24;
    host.me.name = 'Claude Arcanist';
    host.me.cell = ARCADE;
    host.me.health = { current: 105, max: 105 };
    wall = Date.UTC(2026, 9, 15, 0, 44);
    host.wallClock = () => wall + host.t;
    api = new AgentApi(host);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  /** One death as the client saw it: hits, the victim line, the death state, then the loss line two seconds later. */
  const die = (victimLine: string, lossLine: string | null): string => {
    const since = api.eventsSince().length ? api.eventsSince()[api.eventsSince().length - 1].seq : 0;
    api.pushChat(victimLine, 0x15);
    host.me.dead = true;
    host.me.health = { current: 0, max: 105 };
    run(api, host, 200, { physics: false });
    if (lossLine) api.pushChat(lossLine, 0);
    run(api, host, 2000, { physics: false });
    const ev = api.eventsSince(since).filter((e) => e.type === 'death');
    expect(ev).toHaveLength(1);
    host.me.dead = false;
    host.me.health = { current: 105, max: 105 };
    run(api, host, 200, { physics: false });
    return ev[0].text;
  };

  it('three Olthoi Arcade deaths: Nth this session and here, killer level against yours, what each cost', () => {
    host.add({ guid: HARVESTER, name: 'Olthoi Harvester', itemType: 0x10, objectDescFlags: 0x10, cell: ARCADE, x: 81, y: 21, level: 20 });
    host.add({ guid: GARDENER, name: 'Olthoi Gardener', itemType: 0x10, objectDescFlags: 0x10, cell: ARCADE, x: 82, y: 21, level: 22 });
    // Before any death: no deaths line.
    expect(formatObservation(api.observe())).not.toMatch(/deaths this session/);

    const first = die("You are utterly destroyed by Olthoi Harvester's attack!", "You've lost 4,948 Pyreals, your Necklace, your Bracelet, and your Malachite!");
    expect(first).toMatch(/^you died: your 1st death this session, the 1st inside landblock 0x5B43; killed by Olthoi Harvester \(level 20; you are level 24\)/);
    expect(formatObservation(api.observe())).toMatch(/deaths this session: you 1 \(1 in this landblock; 4,948 pyreals lost in all\): 0 min ago, Olthoi Harvester \(level 20; you level 24\) inside landblock 0x5B43: lost 4,948 pyreals, Necklace, Bracelet and Malachite/);

    wall += 41 * 60_000;
    const second = die('Olthoi Gardener reduces you to a sizzling, oozing mass!', "You've lost 1,556 Pyreals, and your Necklace!");
    expect(second).toMatch(/your 2nd death this session, the 2nd inside landblock 0x5B43; killed by Olthoi Gardener \(level 22; you are level 24\)/);
    expect(second).toMatch(/before this: 41 min ago, Olthoi Harvester \(level 20; you level 24\) inside landblock 0x5B43: lost 4,948 pyreals, Necklace, Bracelet and Malachite/);

    wall += 19 * 60_000;
    const third = die('Olthoi Harvester slays you viciously enough to impart death several times over!', "You've lost 778 Pyreals, your Bracelet, and your Necklace!");
    expect(third).toMatch(/your 3rd death this session, the 3rd inside landblock 0x5B43; killed by Olthoi Harvester \(level 20; you are level 24\)/);
    expect(third).toMatch(/before this: 60 min ago, Olthoi Harvester .*: lost 4,948 pyreals, Necklace, Bracelet and Malachite; 19 min ago, Olthoi Gardener \(level 22; you level 24\) inside landblock 0x5B43: lost 1,556 pyreals and Necklace/);
    const obs = formatObservation(api.observe());
    expect(obs).toMatch(/deaths this session: you 3 \(3 in this landblock; 7,282 pyreals lost in all\)/);
    expect(obs).toMatch(/0 min ago, Olthoi Harvester \(level 20; you level 24\) inside landblock 0x5B43: lost 778 pyreals, Bracelet and Necklace/);
    // Somewhere else, "here" counts that place's deaths only.
    host.me.cell = 0x17b20023;
    expect(formatObservation(api.observe())).toMatch(/you 3 \(0 in this landblock;/);
  });

  it('the victim line after the death state still names the killer; with none, whoever hit you most; a death outdoors names the coordinates', () => {
    host.me.cell = 0xa9b40019;
    host.add({ guid: HARVESTER, name: 'Olthoi Harvester', itemType: 0x10, objectDescFlags: 0x10, cell: 0xa9b40019, x: 81, y: 21 });
    api.pushChat('Olthoi Harvester blisters your foot for 4 points of acid damage!', 0x15);
    host.me.dead = true;
    run(api, host, 200, { physics: false });
    const ev = api.eventsSince().filter((e) => e.type === 'death');
    expect(ev[0].text).toMatch(/your 1st death this session, the 1st outdoors near .* \(landblock 0xA9B4\); killed by Olthoi Harvester \(level not known; you are level 24\)/);
    api.pushChat('Olthoi Gardener reduces you to a sizzling, oozing mass!', 0x15);
    expect(formatObservation(api.observe())).toMatch(/Olthoi Gardener \(level not known; you level 24\) outdoors near .*: nothing dropped/);
  });

  it('your fellow\'s death: one fellow-low event per death, with the killer and their tally (ACE: bystander line, then "Your fellow … has died!")', async () => {
    host.me.name = 'Claude Bulwark';
    const v = { cur: 103, max: 105 };
    host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: v, stamina: v, mana: v }];
    host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: ARCADE, x: 80, y: 30 });
    host.add({ guid: HARVESTER, name: 'Olthoi Harvester', itemType: 0x10, objectDescFlags: 0x10, cell: ARCADE, x: 81, y: 31, level: 20 });
    run(api, host, 300, { physics: false });
    let w = api.wait({ types: ['fellow-low'] }, 5000);
    api.pushChat("Claude Arcanist is utterly destroyed by Olthoi Harvester's attack!", 0);
    api.pushChat('Your fellow Claude Arcanist has died!', 0);
    run(api, host, 300, { physics: false });
    expect((await w).map((e) => e.text)).toEqual(['your fellow Claude Arcanist died, killed by Olthoi Harvester (level 20): their 1st death this session that you saw, the 1st in this landblock (0x5B43); they are back at their lifestone']);
    expect(api.eventsSince().filter((e) => e.type === 'fellow-low')).toHaveLength(1);
    // Out of range of the bystander line: the fellow line alone.
    run(api, host, 20_000, { physics: false });
    w = api.wait({ types: ['fellow-low'] }, 5000);
    api.pushChat('Your fellow Claude Arcanist has died!', 0);
    run(api, host, 300, { physics: false });
    expect((await w)[0].text).toBe('your fellow Claude Arcanist died: their 2nd death this session that you saw, the 2nd in this landblock (0x5B43); they are back at their lifestone');
    // AC1999 sends only the bystander line.
    run(api, host, 20_000, { physics: false });
    api.pushChat('Olthoi Harvester slays Claude Arcanist viciously enough to impart death several times over!', 0);
    run(api, host, 300, { physics: false });
    expect(api.eventsSince().filter((e) => e.type === 'fellow-low').map((e) => e.text)[2]).toMatch(/^your fellow Claude Arcanist died, killed by Olthoi Harvester \(level 20\): their 3rd death/);
    expect(formatObservation(api.observe())).toMatch(/deaths this session: Claude Arcanist 3 \(last 0 min ago, Olthoi Harvester\)/);
    // Your own death is never a fellow's.
    expect(api.eventsSince().filter((e) => e.type === 'death')).toEqual([]);
  });

  it('the agent\'s looks ask for its fellows\' vitals (the shown fellowship pane\'s updates)', () => {
    const want = vi.fn();
    host.wantFellowVitals = want;
    api.observe();
    expect(want).toHaveBeenCalled();
  });
});
