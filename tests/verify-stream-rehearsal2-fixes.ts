/**
 * The second live stream rehearsal (2026-10-13 21:20–21:33 UTC), three findings:
 *
 * 1. "Shield [+1: 21 xp], then ~800 a raise". Not a cost bug: the costs are retail's and ACE's. Shield (specialized,
 *    ranks 54) held XP toward rank 55 that fighting had earned (ACE Proficiency.OnSuccessUse spends proficiency XP
 *    into the skill), so the raise cost the rest of that rank (gmSkillUI::GetCostToRaise @ 0049b680:
 *    ExperienceToSkillLevel(level + 1) - _pp; ACE GetXpToNextRank: table[Ranks + 1] - ExperienceSpent), and the next
 *    the full step. The client sent 21 then 1,660 and the server ranked Shield to 198 and 199. The agent's sheet and
 *    raise summary now say so. Pinned on the real XpTable with Bulwark's numbers.
 * 2. The overlay's narration ticker showed the players' end-of-segment reports (markdown, 3,000+ characters).
 * 3. Waits with types=…,tell and chat_match="] <partner> says" (the stream brief's suggestion) slept through the
 *    partner's /f lines: "tell" narrowed chat_match to tell lines (AND), and no tell reads "] … says".
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { XpTable } from '../packages/dat-parser/src/file-types/XpTable.js';
import { transcodeXpTable1999 } from '../packages/dat-parser/src/era1999/Tables1999.js';
import { waitFilter } from '../tools/ac-agent/tools.ts';
import { NARRATION_MAX_CHARS, cliCalls, narrationLine, parseStreamJsonLine } from '../tools/stream/feed.ts';
import { FakeHost } from './_harness/agentFake.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { installDomGlobals, loadDomWindow, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const REPO = resolve(__dirname, '..');
const ERA_PORTALS: Array<[string, string, boolean]> = [
  ['end of retail', DAT_PATHS.portal, false],
  ['Dark Majesty (classicace-customdm)', resolve(REPO, 'dat-sets/classicace-customdm-1.60/client_portal.dat'), false],
  ['AC1999', resolve(REPO, 'dat-sets/ac1999-retail/portal.dat'), true],
];

function xpTableOf(path: string, is1999: boolean): XpTable {
  const raw = openDat(path).getFileData(0x0e000018)!;
  if (!is1999) return new XpTable(new DatReader(raw));
  const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
  return new XpTable(new DatReader(transcodeXpTable1999(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer)));
}

describe('1. raise costs: the XpTable as retail and ACE price it', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUI: any;
  beforeAll(async () => { GameUI = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI; });

  // Retail / ACE on a cumulative table: next = table[level + 1] - spent; +10 = table[level + 10] - spent.
  const spec = [0, 23, 56, 97, 150, 211, 281, 360, 449, 552, 671, 795];
  it('a skill part-filled by use costs the rest of its rank, the next raise the full step', () => {
    expect(GameUI.skillRaiseCosts(spec, 3, 140)).toEqual({ cost1: 10, cost10: 795 - 140 });
    expect(GameUI.skillPartFilled(spec, 3, 140)).toBe(43);
    expect(GameUI.skillRaiseCosts(spec, 4, 150).cost1).toBe(61);
    expect(GameUI.skillPartFilled(spec, 4, 150)).toBe(0);
    expect(GameUI.skillPartFilled(spec, 4, undefined)).toBe(0);
  });

  describe.skipIf(!existsSync(DAT_PATHS.portal))('Claude Bulwark on the real end-of-retail XpTable (0x0E000018)', () => {
    let t: XpTable;
    beforeAll(() => { t = xpTableOf(DAT_PATHS.portal, false); });

    it('Shield (specialized, ranks 54, 21 XP short of rank 55): 21, then 1,660, then 1,764, as the client sent and ACE ranked it', () => {
      const s = t.specializedSkillXpList;
      expect([s[55], s[56], s[57]]).toEqual([27304, 28964, 30728]);
      const pp = s[55] - 21;
      expect(GameUI.skillRaiseCosts(s, 54, pp).cost1).toBe(21);
      expect(GameUI.skillPartFilled(s, 54, pp)).toBe(s[55] - s[54] - 21);
      // ACE SpendSkillXp: ExperienceSpent += amount; Ranks = CalcSkillRank(ExperienceSpent).
      const rank = (xp: number) => { let r = 0; while (r + 1 < s.length && xp >= s[r + 1]) r++; return r; };
      expect(rank(pp + 21)).toBe(55);
      expect(GameUI.skillRaiseCosts(s, 55, pp + 21).cost1).toBe(1660);
      expect(rank(pp + 21 + 1660)).toBe(56);
      expect(GameUI.skillRaiseCosts(s, 56, pp + 21 + 1660).cost1).toBe(1764);
      // The ACE DB after the segment (ranks 56, p_p 29178: fighting added 214 more) prices the next at 1,550.
      expect(GameUI.skillRaiseCosts(s, 56, 29178).cost1).toBe(1550);
    });

    it('Endurance 98 → 101 (raises 38 → 41) costs 3,691 + 3,887 + 4,097 = 11,675', () => {
      const a = t.attributeXpList;
      const c = [38, 39, 40].map((r) => GameUI.statRaiseCosts(a, r).cost1);
      expect(c).toEqual([3691, 3887, 4097]);
      expect(c.reduce((x: number, y: number) => x + y, 0)).toBe(11675);
    });
  });

  for (const [era, path, is1999] of ERA_PORTALS) {
    describe.skipIf(!existsSync(path))(`each era prices raises from its own portal's XpTable: ${era}`, () => {
      let t: XpTable;
      beforeAll(() => { t = xpTableOf(path, is1999); });
      it('the four cost tables are cumulative from 0, and the +1 / +10 prices are their differences', () => {
        for (const list of [t.attributeXpList, t.vitalXpList, t.trainedSkillXpList, t.specializedSkillXpList]) {
          expect(list[0]).toBe(0);
          for (let i = 1; i < list.length; i++) expect(list[i]).toBeGreaterThan(list[i - 1]);
          expect(GameUI.statRaiseCosts(list, 5)).toEqual({ cost1: list[6] - list[5], cost10: list[15] - list[5] });
          expect(GameUI.skillRaiseCosts(list, 5, list[5])).toEqual({ cost1: list[6] - list[5], cost10: list[15] - list[5] });
        }
      });
    });
  }
});

describe('1. the agent sheet and raise summary explain a part-filled rank (real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const s = [0, 23, 56, 97, 150, 211, 281, 360, 449, 552, 671, 795];
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('lists "+1: 10 xp, then 61" and says why; the raise sends 10 and says it finished a part-filled rank', () => {
    const sent: Array<[number, number]> = [];
    ui.setRaiseCallbacks({ onRaiseSkill: (id: number, cost: number) => sent.push([id, cost]) }, { specializedSkill: s, trainedSkill: s });
    ui.charInfo.unassignedXp = 100;
    ui.charInfo.skills = [
      { id: 48, name: 'Shield', status: 'Specialized', base: 197, effective: 212, raises: 3, pp: 140 },
      { id: 6, name: 'Melee Defense', status: 'Specialized', base: 150, effective: 150, raises: 4, pp: 150 },
    ];
    const sheet: string = ui.agentCharacterSheet();
    expect(sheet).toContain('Shield 212 (base 197) [+1: 10 xp, then 61]');
    expect(sheet).toContain('Melee Defense 150 [+1: 61 xp]');
    expect(sheet).toContain('part-filled by being used');
    const r = ui.agentRaise('shield');
    expect(r).toMatchObject({ ok: true, cost: 10, from: 197, to: 198 });
    expect(r.message).toBe('raised Shield 197 → 198 (10 XP), the rest of a rank using it had part-filled; the next +1 costs 61 XP');
    expect(sent).toEqual([[48, 10]]);
    // At a rank boundary now: no "then", no footnote.
    const after: string = ui.agentCharacterSheet();
    expect(after).toContain('Shield 213 (base 198) [+1: 61 xp]');
    expect(after).not.toContain('part-filled by being used');
  });
});

// Jake 2026-10-14, "lets just get the credits ASAP": the sheet names the next levels that grant skill credits, from the
// era's own XpTable characterLevelSkillCreditList (ACE Player_Xp: reaching level L adds list[L]); the stream's
// readiness block reads that line.
describe('the agent sheet names the next skill-credit levels from the loaded XpTable (real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any, GameUI: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    GameUI = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('a fake table: the two nearest levels above the character\'s, with what each grants; none past the last or without a table', () => {
    const credits = [0, 0, 1, 0, 0, 2, 0, 0, 1];
    ui.setRaiseCallbacks({}, { levelSkillCredits: credits });
    ui.charInfo.level = 2;
    ui.charInfo.skillCredits = 6;
    const sheet: string = ui.agentCharacterSheet();
    expect(sheet.split('\n')[1]).toMatch(/; 6 skill credits$/);
    expect(sheet.split('\n')[2]).toBe('Next skill credits: level 5 (+2), level 8 (+1)');
    ui.charInfo.level = 5;
    expect(ui.agentCharacterSheet()).toContain('\nNext skill credits: level 8 (+1)\n');
    ui.charInfo.level = 8;
    expect(ui.agentCharacterSheet()).not.toContain('Next skill credits');
    ui.setRaiseCallbacks({}, {});
    ui.charInfo.level = 2;
    expect(ui.agentCharacterSheet()).not.toContain('Next skill credits');
  });

  describe.skipIf(!existsSync(DAT_PATHS.portal))('end of retail: a level-21 Arcanist\'s next credits are at 23 and 26', () => {
    let t: XpTable;
    beforeAll(() => { t = xpTableOf(DAT_PATHS.portal, false); });
    it('one credit at 16, 18, 20, 23, 26, 29, 32, 35, 40 … 60', () => {
      const at = t.characterLevelSkillCreditList.map((c, l) => (c > 0 ? l : -1)).filter((l) => l >= 16 && l <= 60);
      expect(at).toEqual([16, 18, 20, 23, 26, 29, 32, 35, 40, 45, 50, 55, 60]);
      expect(GameUI.nextSkillCreditLevels(t.characterLevelSkillCreditList, 21)).toEqual([{ level: 23, credits: 1 }, { level: 26, credits: 1 }]);
    });
  });

  for (const [era, path, is1999] of ERA_PORTALS) {
    describe.skipIf(!existsSync(path))(`each era's credit levels come from its own portal: ${era}`, () => {
      let t: XpTable;
      beforeAll(() => { t = xpTableOf(path, is1999); });
      it('the sheet line lists exactly the table\'s next granting levels', () => {
        const list = t.characterLevelSkillCreditList;
        const want = list.map((c, l) => ({ level: l, credits: c })).filter((x) => x.level > 10 && x.credits > 0).slice(0, 2);
        expect(want.length).toBeGreaterThan(0);
        ui.setRaiseCallbacks({}, { levelSkillCredits: list });
        ui.charInfo.level = 10;
        expect(ui.agentCharacterSheet()).toContain(`\nNext skill credits: ${want.map((x) => `level ${x.level} (+${x.credits})`).join(', ')}\n`);
      });
    });
  }
});

describe('2. narration: short lines only, never the end-of-segment report', () => {
  const report = '## Report: Segment 1 (17:20–17:32)\n\n**Story:** We started at the Holtburg lifestone with my mana at 25% and no fellowship. I sent Bulwark a tell, re-formed **Scholar and Shield**.\n\n## Bugs\n- the wait slept\n- costs';
  const assistant = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

  it('drops the reports (headings, lists) and long multi-paragraph blocks, keeps the rehearsal\'s own lines', () => {
    expect(parseStreamJsonLine(assistant(report), 'mage').drafts).toEqual([]);
    expect(narrationLine('# Report: Claude Bulwark, segment 1 (17:20)\n\n## The story\nI logged in at the Holtburg lifestone.')).toBeNull();
    const para = 'We fought the statues. '.repeat(8).trim();
    expect(narrationLine(`${para}\n\n${para}`)).toBeNull();
    const line = 'Three statues, zero damage taken, wards back on. Spending 3.7k XP on Endurance (more HP for the Fern rematch), then the Gromnie to the south.';
    expect(parseStreamJsonLine(assistant(`  ${line}\n`), 'soldier').drafts).toEqual([{ type: 'narration', char: 'soldier', text: line }]);
  });

  it('a long single paragraph is cut at a sentence within the cap; line breaks and bold become plain text', () => {
    const long = `${'Arcanist is meditating by the lifestone, so I am selling the junk to Alcott first. '.repeat(5).trim()}`;
    const got = narrationLine(long)!;
    expect(got.length).toBeLessThanOrEqual(NARRATION_MAX_CHARS);
    expect(got.endsWith('.')).toBe(true);
    expect(narrationLine('Pulling the **Gromnie**\nnow.')).toBe('Pulling the Gromnie now.');
    expect(narrationLine(`${'x'.repeat(300)}`)!.length).toBeLessThanOrEqual(NARRATION_MAX_CHARS);
  });

  it('the result line ends the turn without a narration event', () => {
    const o = parseStreamJsonLine(JSON.stringify({ type: 'result', result: report, usage: {} }), 'mage');
    expect(o.drafts).toEqual([]);
    expect(o.result?.text).toBe(report);
  });
});

describe('3. a fight wait wakes on the partner\'s /f lines and tells (the brief\'s pattern)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => { vi.useRealTimers(); });
  // The brief's own fight wait (tools/stream/brief.md), its partner filled in, parsed as the player's ./ac call is.
  const briefWait = (): Record<string, string> => {
    const md = readFileSync(resolve(REPO, 'tools/stream/brief.md'), 'utf8').replaceAll('{{PARTNER}}', 'Claude Arcanist');
    const cmd = /`(\.\/ac wait [^`]*chat_match[^`]*)`/.exec(md)![1];
    return cliCalls(cmd)[0].args;
  };
  const brief = () => waitFilter(briefWait()) as Parameters<AgentApi['wait']>[0];

  it('the brief still suggests tell plus the partner\'s "] … says" lines (what Bulwark ran through the Foundry)', () => {
    const a = briefWait();
    expect(a.types.split(',')).toContain('tell');
    expect(a.chat_match).toBe('] Claude Arcanist says');
  });

  async function wakeOn(text: string, chatType: number): Promise<string[]> {
    api.observe();
    const w = api.wait(brief(), 45_000);
    await vi.advanceTimersByTimeAsync(3000);
    api.pushChat(text, chatType);
    await vi.advanceTimersByTimeAsync(46_000);
    return (await w).map((e) => e.text);
  }

  it('her fellowship line (chat type 0x12, as the rehearsal printed it) wakes it', async () => {
    expect(await wakeOn('[Fellowship] Claude Arcanist says, "Gromnie: cinders! That\'s four."', 0x12))
      .toEqual(['(channel) [Fellowship] Claude Arcanist says, "Gromnie: cinders! That\'s four."']);
  });

  it('her tell wakes it, and so does anyone\'s tell', async () => {
    expect(await wakeOn('Claude Arcanist tells you, "Meditating, one minute."', 0x03)).toHaveLength(1);
    expect(await wakeOn('Alcott tells you, "Fine wares!"', 0x03)).toHaveLength(1);
  });

  it('his own tell, his own /f line, her spell words and combat spam do not', async () => {
    expect(await wakeOn('You tell Claude Arcanist, "I\'m inside the Foundry at the entry."', 0x04)).toEqual([]);
    expect(await wakeOn('[Fellowship] You say, "Upper hall clear, six for six."', 0x12)).toEqual([]);
    expect(await wakeOn('Claude Arcanist says, "Zojak Quaguz"', 0x02)).toEqual([]);
    expect(await wakeOn('You hit Bronze Statue of a Gromnie for 30 points of bludgeoning damage!', 0x16)).toEqual([]);
  });

  it('chat_match alone with a partner\'s name skips your own lines that name them', () => {
    const re = new RegExp(waitFilter({ chat_match: 'Claude Arcanist' }).chatMatch!, 'i');
    expect(re.test('(tell) You tell Claude Arcanist, "hi"')).toBe(false);
    expect(re.test('(tell) Claude Arcanist tells you, "hi"')).toBe(true);
    expect(re.test('(say) Claude Arcanist says, "hi"')).toBe(true);
    // An invalid regex still matches as text.
    expect(new RegExp(waitFilter({ chat_match: 'Arcanist (' }).chatMatch!, 'i').test('(say) Claude Arcanist (away) says, "x"')).toBe(true);
  });
});
