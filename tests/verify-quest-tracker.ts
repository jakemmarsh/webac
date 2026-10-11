/**
 * The quest list behind UtilityBelt's quest functions (agent/questTracker.ts;
 * docs/vtank-parity-gaps.md §0.10): /myquests lines as ACE, ClassicACE, GDLE
 * and the AC1999 server print them, UB's flag types and readiness, the quiet
 * request (lines hidden, retries, the 1 s heartbeat), the servers that say
 * no, and the meta functions answering from it (UB's answers with no data).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestTracker, parseMyQuestsLine, questFlagType, questReady } from '../packages/renderer/src/agent/questTracker.ts';
import { runExpr, type ExprHost, type ExprValue } from '../packages/shared/src/routines/index.ts';

const NOW = 1_760_000_000; // unix seconds
// ACE PlayerCommands.HandleQuests: `{name} - {solves} solves ({last})"{message}" {maxSolves} {minDelta}`.
const ACE_TIMED = `blankaug - 1 solves (${NOW - 100})"Asheron's Blank Augmentation" -1 72000`;
const ACE_READY = `stipendtimer - 4 solves (${NOW - 90000})"Stipend" -1 72000`;
const ACE_KILLTASK = `killtaskmosswarts - 12 solves (${NOW - 5})"Kill 50 Mosswarts" 50 0`;
const ACE_ONCE = `spokenbobo - 1 solves (${NOW - 1_000_000})"Spoke to Bobo" 1 0`;
const BITS = `legendaryquestsa - 5 solves (${NOW - 10})"Legendary Quests A" -1 0`;
// The AC1999 server prints the quoted part only when it has the quest's definition.
const NO_DEF_1999 = `pathwardenfound - 1 solves (${NOW - 50})`;

describe('/myquests lines (UB QuestFlag.FromMyQuestsLine)', () => {
  it('reads ACE / ClassicACE / GDLE lines', () => {
    expect(parseMyQuestsLine(ACE_TIMED)).toEqual({ key: 'blankaug', description: "Asheron's Blank Augmentation", solves: 1, maxSolves: -1, completedOn: NOW - 100, repeatSeconds: 72000 });
    // UB's own comment line, with a trailing newline as Decal hands it over.
    expect(parseMyQuestsLine('regaliamaskuber - 1 solves (1522807913)"Player has collected the mask from a Virinidi Profatrix." -1 72000\n'))
      .toEqual({ key: 'regaliamaskuber', description: 'Player has collected the mask from a Virinidi Profatrix.', solves: 1, maxSolves: -1, completedOn: 1522807913, repeatSeconds: 72000 });
  });
  it('reads an AC1999 line with no definition, and lowercases keys', () => {
    expect(parseMyQuestsLine(NO_DEF_1999)).toEqual({ key: 'pathwardenfound', description: '', solves: 1, maxSolves: 0, completedOn: NOW - 50, repeatSeconds: 0 });
    expect(parseMyQuestsLine('MixedCase - 2 solves (0)"x" 3 4')!.key).toBe('mixedcase');
  });
  it('ignores other chat', () => {
    expect(parseMyQuestsLine('Quest list is empty.')).toBeNull();
    expect(parseMyQuestsLine('You have killed 12 Mosswarts! You must kill 50 to complete your task.')).toBeNull();
  });
  it("flag types and readiness are UB's: a once-only quest done is never ready, a timer must run out", () => {
    const at = NOW * 1000;
    const f = (l: string) => parseMyQuestsLine(l)!;
    expect([questFlagType(f(ACE_KILLTASK)), questFlagType(f(ACE_ONCE)), questFlagType(f(ACE_TIMED))]).toEqual(['killtask', 'once', 'timed']);
    expect(questReady(f(ACE_TIMED), at)).toBe(false); // 100 s into a 20 h timer
    expect(questReady(f(ACE_READY), at)).toBe(true); // 25 h after, 20 h timer
    expect(questReady(f(ACE_ONCE), at)).toBe(false);
    expect(questReady(f(ACE_KILLTASK), at)).toBe(true);
  });
});

function setup() {
  const sent: string[] = [];
  let accept = true;
  const t = new QuestTracker({ send: (c) => { sent.push(c); return accept; }, now: () => Date.now() });
  const vars = new Map<string, ExprValue>();
  const host: ExprHost = {
    getVar: (_s, n) => vars.get(n), setVar: (_s, n, v) => { vars.set(n, v); },
    clearVar: (_s, n) => vars.delete(n), clearAllVars: () => { vars.clear(); },
    now: () => 0, echo: () => {},
    quest: (n) => t.quest(n), isRefreshingQuests: () => t.isRefreshing(),
  };
  return { t, sent, run: (src: string) => runExpr(src, host), refuse: () => { accept = false; } };
}

describe('the quest tracker', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); });
  afterEach(() => { vi.useRealTimers(); });

  it('asks once per character, on a meta\'s first quest function (never at login), hides the answer, and fills the meta functions', () => {
    const { t, sent, run } = setup();
    t.loginComplete('0x50000001');
    expect(sent).toEqual([]); // a player who runs no quest meta sends nothing retail's client wouldn't
    run('testquestflag[spokenbobo]');
    t.loginComplete('0x50000001'); // LoginComplete again after a portal: not asked again
    run('testquestflag[spokenbobo]');
    expect(sent).toEqual(['@myquests']);
    expect(run('isrefreshingquests[]')).toBe(1);
    for (const l of [ACE_TIMED, ACE_READY, ACE_KILLTASK, ACE_ONCE, BITS]) expect(t.onServerLine(l)).toBe(true);
    // Done 1 s after the last line.
    vi.advanceTimersByTime(999);
    expect(t.isRefreshing()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(t.state).toBe('listed');
    expect(run('isrefreshingquests[]')).toBe(0);
    expect([run('getqueststatus[blankaug]'), run('getqueststatus[stipendtimer]'), run('getqueststatus[spokenbobo]'), run('getqueststatus[neverdone]')]).toEqual([0, 1, 0, 1]);
    expect([run('testquestflag[spokenbobo]'), run('testquestflag[SpokenBobo]'), run('testquestflag[neverdone]')]).toEqual([1, 1, 0]);
    expect([run('getquestktprogress[killtaskmosswarts]'), run('getquestktrequired[killtaskmosswarts]')]).toEqual([12, 50]);
    expect([run('getquestktprogress[neverdone]'), run('getquestktrequired[neverdone]')]).toEqual([0, 0]);
    // The Legendary Quests meta's bit-field test.
    expect(run('hexstr[getquestktprogress[legendaryquestsa]&0x4]')).toBe('0x4');
    // The timer runs out in the client's own clock.
    vi.advanceTimersByTime(72000 * 1000);
    expect(run('getqueststatus[blankaug]')).toBe(1);
  });

  it('a server with quest_info_enabled off: the "not enabled" line is hidden, and the functions answer as UB with no data', () => {
    const { t, run } = setup();
    t.loginComplete('a'); t.quest('first use');
    expect(t.onServerLine('The command "myquests" is not currently enabled on this server.')).toBe(true);
    expect(t.state).toBe('disabled');
    expect(t.isRefreshing()).toBe(false);
    expect([run('getqueststatus[blankaug]'), run('testquestflag[blankaug]'), run('getquestktprogress[x]'), run('getquestktrequired[x]'), run('isrefreshingquests[]')]).toEqual([1, 0, 0, 0, 0]);
    // A kill task line doesn't ask again on a server that said no.
    t.onServerLine('You have killed 3 Drudges! You must kill 10 to complete your task.');
    vi.advanceTimersByTime(5000);
    expect(t.isRefreshing()).toBe(false);
  });

  it('an empty list ends the request at once; a server with no such command is given up on', () => {
    const { t } = setup();
    t.loginComplete('a'); t.quest('first use');
    expect(t.onServerLine('Quest list is empty.')).toBe(true);
    expect(t.state).toBe('empty');
    t.loginComplete('b'); t.quest('first use');
    expect(t.onServerLine('Unknown command: myquests')).toBe(true);
    expect(t.state).toBe('unavailable');
  });

  it('no answer: three tries 15 s apart, then unavailable', () => {
    const { t, sent } = setup();
    t.loginComplete('a'); t.quest('first use');
    vi.advanceTimersByTime(15000);
    vi.advanceTimersByTime(15000);
    expect(sent).toEqual(['@myquests', '@myquests', '@myquests']);
    vi.advanceTimersByTime(15000);
    expect(sent.length).toBe(3);
    expect(t.state).toBe('unavailable');
    expect(t.isRefreshing()).toBe(false);
  });

  it('lines the player asked for (typed /myquests) are shown and still read', () => {
    const { t, run } = setup();
    expect(t.onServerLine(ACE_KILLTASK)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(run('getquestktprogress[killtaskmosswarts]')).toBe(12);
    expect(t.onServerLine('Quest list is empty.')).toBe(false);
    expect(run('testquestflag[killtaskmosswarts]')).toBe(0);
  });

  it('a kill task line asks again quietly 2 s later; the old list stays readable until the new one is in', () => {
    const { t, sent, run } = setup();
    t.loginComplete('a'); t.quest('first use');
    t.onServerLine(ACE_KILLTASK);
    vi.advanceTimersByTime(1000);
    expect(t.onServerLine('You have killed 13 Mosswarts! You must kill 50 to complete your task.')).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual(['@myquests', '@myquests']);
    expect(run('getquestktprogress[killtaskmosswarts]')).toBe(12);
    expect(t.onServerLine(ACE_KILLTASK.replace('12 solves', '13 solves'))).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(run('getquestktprogress[killtaskmosswarts]')).toBe(13);
    // The AC1999 server's wording moves it on too.
    t.onServerLine('You have killed 10 Drudge Skulkers. Your task is complete!');
    vi.advanceTimersByTime(2000);
    expect(sent.length).toBe(3);
  });

  it('a meta asking before any login asks the server then; with no connection nothing is pending', () => {
    const { t, sent, run, refuse } = setup();
    expect(run('getqueststatus[x]')).toBe(1);
    expect(sent).toEqual(['@myquests']);
    expect(t.isRefreshing()).toBe(true);
    t.reset();
    refuse();
    expect(run('testquestflag[x]')).toBe(0);
    expect(t.isRefreshing()).toBe(false);
  });
});
