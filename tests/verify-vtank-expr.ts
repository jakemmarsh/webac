/**
 * VirindiTank meta expressions (Expr / DoExpr / ChatExpr / SetOpt): the
 * parser and evaluator in packages/shared/src/routines/vtankExpr.ts, driven
 * against a fake game host. The syntax cases come from real community-meta
 * expressions (asherons-call-metas); every implemented function is exercised
 * (a coverage check at the end fails if one is added without a case).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXPR_FUNCTIONS, ExprError, UNSUPPORTED_FUNCTIONS, evalExpr, parseExpr, runExpr, truthy,
  type ExprCoords, type ExprHost, type ExprValue, type HostFellowship, type HostObject, type HostQuest, type PropKind, type VarScope,
} from '../packages/shared/src/routines/index.js';

const at = (ns: number, ew: number, z = 0): ExprCoords => ({ kind: 'coords', ns, ew, z });

/** Fake game: player "Me" at 10N 20W with a door, two drudges, a portal and a fellow nearby. */
function makeHost() {
  const vars: Record<VarScope, Map<string, ExprValue>> = { var: new Map(), gvar: new Map(), pvar: new Map() };
  const log: string[] = [];
  const scheduled: Array<{ ms: number; fn: () => void }> = [];
  const clock = { t: 1_000_000 };
  const player: HostObject = { id: 1, name: 'Me', objectClass: 24, templateType: 1, coords: at(10, -20), heading: 90 };
  const world: HostObject[] = [
    { id: 100, name: 'Door', objectClass: 26, templateType: 412, coords: at(10.01, -20), isDoorOpen: true },
    { id: 101, name: 'Drudge Skulker', objectClass: 5, templateType: 7, coords: at(10, -20.02) },
    { id: 102, name: 'Drudge Slinker', objectClass: 5, templateType: 8, coords: at(10.05, -20) },
    { id: 103, name: 'Gateway', objectClass: 14, templateType: 999, coords: at(10, -19.99) },
    { id: 104, name: 'Fellow Guy', objectClass: 24, templateType: 1, coords: at(10.002, -20) },
    { id: 105, name: 'Closed Door', objectClass: 26, templateType: 412, coords: at(10.2, -20), isDoorOpen: false },
  ];
  const inv: HostObject[] = [
    { id: 200, name: 'Mana Stone', objectClass: 8, templateType: 2434, containerId: 1 },
    { id: 201, name: 'Pyreal', objectClass: 7, templateType: 273, stack: 25, containerId: 1 },
    { id: 202, name: 'Pyreal', objectClass: 7, templateType: 273, stack: 10, containerId: 300 },
    { id: 300, name: 'Pack', objectClass: 10, templateType: 136, containerId: 1 },
    { id: 203, name: 'Aged Legendary Key', objectClass: 8, templateType: 48746, containerId: 1 },
  ];
  const fellowship: { f: HostFellowship | null } = {
    f: { name: 'Pals', members: [{ id: 1, name: 'Me' }, { id: 104, name: 'Fellow Guy' }], leaderId: 1, open: false, locked: true },
  };
  const quests: Record<string, HostQuest> = {
    legendaryquestsa: { solves: 0b101, maxSolves: 0, ready: false },
    killtask: { solves: 12, maxSolves: 50, ready: true },
  };
  const charProps: Record<PropKind, Record<number, number | string>> = {
    int: { 25: 275 }, double: { 1: 2.5 }, bool: { 2: 1 }, quad: { 6: 123456789012 }, string: { 1: 'Me' },
  };
  const objProps: Record<number, Partial<Record<PropKind, Record<number, number | string>>>> = {
    1: { int: { 287: 3 } }, 103: { string: { 38: 'Insatiable Vault' } }, 200: { double: { 5: 0.5 }, bool: { 9: 1 } },
  };
  const settings = new Map<string, ExprValue>([['EnableNav', 'True']]);
  const ubOpts = new Map<string, ExprValue>();
  const motions = new Map<string, boolean>();
  let metaState = 'Default';
  let combat = 'Peace';
  let rnd = 0.5;

  const host: ExprHost = {
    getVar: (s, n) => vars[s].get(n),
    setVar: (s, n, v) => { vars[s].set(n, v); },
    clearVar: (s, n) => vars[s].delete(n),
    clearAllVars: (s) => vars[s].clear(),
    now: () => clock.t,
    echo: (t, c) => { log.push(`echo:${t}${c === undefined ? '' : `@${c}`}`); },
    chatbox: (t) => { log.push(`chat:${t}`); },
    chatboxPaste: (t) => { log.push(`paste:${t}`); },
    random: () => rnd,
    vtGetSetting: (n) => settings.get(n) ?? '',
    vtSetSetting: (n, v) => { settings.set(n, v); return true; },
    ubGetOption: (n) => ubOpts.get(n) ?? 0,
    ubSetOption: (n, v) => { ubOpts.set(n, v); return true; },
    getMetaState: () => metaState,
    setMetaState: (s) => { metaState = s; },
    player: () => player,
    playerLandcell: () => 0xa9b40021,
    charProp: (k, id) => charProps[k][id],
    vital: (v) => (v === 1 ? { base: 100, current: 80, buffedMax: 150 } : null),
    skill: (id) => (id === 23 ? { base: 200, buffed: 250, training: 3 } : null),
    attribute: (a) => (a === 1 ? { base: 100, buffed: 110 } : null),
    burden: () => 42,
    vitae: () => 95,
    isPortaling: () => false,
    busyState: () => 0,
    combatState: () => combat,
    setCombatState: (s) => { combat = s; return true; },
    worldName: () => 'Coldeve',
    objects: () => world,
    inventory: () => inv,
    selectionId: () => 101,
    openContainerId: () => null,
    objectProp: (id, k, key) => objProps[id]?.[k]?.[key],
    objectHealth: (id) => (id === 101 ? 0.75 : 1),
    objectHasData: (id) => id === 200,
    requestObjectData: (id) => { log.push(`request:${id}`); },
    objectLastIdTime: () => 1234,
    objectSpellIds: (_id, active) => (active ? [2] : [1, 2]),
    select: (id) => { log.push(`select:${id}`); return true; },
    useItem: (id) => { log.push(`use:${id}`); return true; },
    applyItem: (u, t) => { log.push(`apply:${u}->${t}`); return true; },
    giveItem: (i, t) => { log.push(`give:${i}->${t}`); return true; },
    giveProfile: (p, t) => { log.push(`giveprofile:${p}->${t}`); return true; },
    setMotion: (m, on) => { motions.set(m, on); log.push(`motion:${m}=${on}`); },
    getMotion: (m) => motions.get(m) ?? false,
    clearMotion: () => { motions.clear(); log.push('clearmotion'); },
    equipAnyWand: () => true,
    castSpell: (id, t) => { log.push(`cast:${id}${t === undefined ? '' : `@${t}`}`); return true; },
    spellKnown: (id) => id === 1,
    canCastSpell: (id, kind) => id === 1 && kind === 'buff',
    spellName: (id) => (id === 1 ? 'Strength Other I' : ''),
    knownSpells: () => [1, 2, 3],
    spellExpiration: (id) => (id === 1 ? 600 : 0),
    spellExpirationByName: (n) => (n === 'Strength Other I' ? 600 : 0),
    componentName: (id) => (id === 1 ? 'Lead Scarab' : ''),
    fellowship: () => fellowship.f,
    quest: (n) => quests[n] ?? null,
    isRefreshingQuests: () => false,
    gameTicks: () => 5925, // Dawnsong, Morningthaw 2, 10 P.Y.
    statusHud: (k, v, c) => { log.push(`hud:${k}=${v}${c === undefined ? '' : `@${c}`}`); },
    schedule: (ms, fn) => { scheduled.push({ ms, fn }); },
  };
  return {
    host, vars, log, clock, scheduled, fellowship, world, inv,
    setRandom: (r: number) => { rnd = r; },
  };
}

let h: ReturnType<typeof makeHost>;
const run = (src: string) => runExpr(src, h.host);
beforeEach(() => { h = makeHost(); });

/** Every expression the cases below evaluate, for the coverage check. */
const covered: string[] = [];
function cases(table: Array<[string, unknown]>) {
  for (const [src, want] of table) {
    covered.push(src);
    it(`${src} → ${JSON.stringify(want)}`, () => {
      const got = run(src);
      if (typeof want === 'number' && !Number.isInteger(want)) expect(got).toBeCloseTo(want, 6);
      else expect(got).toEqual(want);
    });
  }
}

describe('literals', () => {
  cases([
    ['12', 12], ['1.5', 1.5], ['0x1F', 31], ['-3', -3], ['true', 1], ['FALSE', 0],
    ['hello', 'hello'], ['  Amber Barley  ', 'Amber Barley'], ['`a, b + c`', 'a, b + c'], ["'Adept'", 'Adept'],
    ['\\/f 4\\ Corners\\ ', '/f 4 Corners '], ['Recharge-Norm-Hitp', 'Recharge-Norm-Hitp'], ["Zongo's Stout", "Zongo's Stout"],
    ['5th', '5th'], ['4 Corners timer not up\\!', '4 Corners timer not up!'], ['Snarl Found!', 'Snarl Found!'],
    ['\\^Legendary Key\\$', '^Legendary Key$'], ['', ''],
  ]);
  it('an escaped digit string stays a string', () => { expect(run('\\12')).toBe('12'); });
});

describe('operators and precedence', () => {
  cases([
    ['1+2*3', 7], ['(1+2)*3', 9], ['10-4-3', 3], ['2^3^2', 512], ['-2^2', 4], ['7%3', 1], ['7/2', 3.5],
    ['1+2==3', 1], ['3>2&&2>1', 1], ['0||0', 0], ['1&&0||1', 1], ['!0', 1], ['!5', 0], ['!(1==2)', 1],
    ['5&0x4', 4], ['5&0x2', 0], ['1|2', 3], ['2<3', 1], ['2<=2', 1], ['3>=4', 0], ['1!=2', 1],
    ['abc==abc', 1], ['abc!=abd', 1], ['`10`==10', 1], ['`x`==0', 0], ['`b`>`a`', 1],
    ['1;2;3', 3], ['setvar[a,1];getvar[a]+1', 2],
  ]);
  it('+ concatenates when either side is a string, numbers print like .NET', () => {
    expect(run('\\/f Captured\\ +getvar[n]')).toBe('/f Captured 0');
    expect(run('\\/ub jumpsw 180 +cstr[250-50]')).toBe('/ub jumpsw 180 200');
    expect(run('\\/f Need +getvar[n]+ \\ of Stone Tablet')).toBe('/f Need 0 of Stone Tablet');
    expect(run('`a`+1.5')).toBe('a1.5');
    expect(run('1/3+``')).toBe('0.333333333333333');
    expect(run('2+`x`+3')).toBe('2x3');
  });
  it('&& and || short-circuit', () => {
    run('0&&setvar[x,1]');
    run('1||setvar[y,1]');
    expect(h.vars.var.has('x') || h.vars.var.has('y')).toBe(false);
  });
  it('# matches a regex (.NET flavour, (?i) prefix honoured)', () => {
    expect(run('coordinatetostring[getplayercoordinates[]]#`^10\\.00N, 20\\.00W`')).toBe(1);
    expect(run('Drudge#`^drudge`')).toBe(0);
    expect(run('Drudge#`(?i)^drudge`')).toBe(1);
  });
  it('the bit-field quest check from the Legendary Quests meta', () => {
    expect(run('hexstr[getquestktprogress[legendaryquestsa]&0x1]!=`0x1`')).toBe(0);
    expect(run('hexstr[getquestktprogress[legendaryquestsa]&0x2]!=`0x2`')).toBe(1);
  });
});

describe('variables in all three scopes', () => {
  it('var / gvar / pvar are separate stores; unset reads 0', () => {
    expect(run('getvar[x]')).toBe(0);
    expect(run('setvar[x,5]')).toBe(5);
    expect(run('setgvar[x,`g`]')).toBe('g');
    expect(run('setpvar[x,`p`]')).toBe('p');
    expect([run('getvar[x]'), run('getgvar[x]'), run('getpvar[x]')]).toEqual([5, 'g', 'p']);
    expect([run('testvar[x]'), run('testgvar[x]'), run('testpvar[x]'), run('testvar[nope]')]).toEqual([1, 1, 1, 0]);
    expect(run('$x+1')).toBe(6);
    expect(run('clearvar[x]')).toBe(1);
    expect(run('clearvar[x]')).toBe(0);
    expect(run('cleargvar[x]')).toBe(1);
    expect(run('clearpvar[x]')).toBe(1);
    expect([run('touchvar[t]'), run('touchvar[t]'), run('getvar[t]')]).toEqual([0, 1, 0]);
    expect([run('touchgvar[t]'), run('touchpvar[t]')]).toEqual([0, 0]);
    run('setvar[a,1]'); run('setgvar[a,1]'); run('setpvar[a,1]');
    expect([run('clearallvars[]'), run('clearallgvars[]'), run('clearallpvars[]')]).toEqual([1, 1, 1]);
    expect(h.vars.var.size + h.vars.gvar.size + h.vars.pvar.size).toBe(0);
  });
  it('the corpus $var comparisons', () => {
    run('setvar[promNotes,5]');
    expect(run('$promNotes>=4&&$promNotes<6')).toBe(1);
    expect(run('$promNotes>=6&&$promNotes<8')).toBe(0);
  });
});

describe('lists and dictionaries (reference semantics, $1/$2 callbacks)', () => {
  it('listadd mutates the list stored in a variable', () => {
    run('setvar[l,listcreate[]]');
    run('listadd[$l,a];listadd[$l,b];listadd[getvar[l],c]');
    expect(run('listcount[$l]')).toBe(3);
    expect(run('$l{1}')).toBe('b');
    expect(run('$l{-1}')).toBe('c');
    expect(run('$l{0:2}')).toEqual({ kind: 'list', items: ['a', 'b'] });
    expect(run('listpop[$l]')).toBe('c');
    expect(run('listpop[$l,0]')).toBe('a');
    expect(run('listcount[$l]')).toBe(1);
  });
  cases([
    ['listcreate[1,2,3]', { kind: 'list', items: [1, 2, 3] }],
    ['listgetitem[listcreate[a,b,c],2]', 'c'],
    ['listcontains[listcreate[a,b],b]', 1],
    ['listindexof[listcreate[a,b,a],a]', 0],
    ['listlastindexof[listcreate[a,b,a],a]', 2],
    ['listindexof[listcreate[a],z]', -1],
    ['listcount[listinsert[listcreate[a,c],b,1]]', 3],
    ['listgetitem[listinsert[listcreate[a,c],b,1],1]', 'b'],
    ['listremove[listcreate[a,b,a],a]', { kind: 'list', items: ['b', 'a'] }],
    ['listremoveat[listcreate[a,b,c],1]', { kind: 'list', items: ['a', 'c'] }],
    ['listclear[listcreate[a,b]]', { kind: 'list', items: [] }],
    ['listcopy[listcreate[a]]', { kind: 'list', items: ['a'] }],
    ['listreverse[listcreate[1,2,3]]', { kind: 'list', items: [3, 2, 1] }],
    ['listfromrange[2,5]', { kind: 'list', items: [2, 3, 4, 5] }],
    ['listfromrange[3,1]', { kind: 'list', items: [3, 2, 1] }],
    ['listfilter[listfromrange[1,6],`$1%2==0`]', { kind: 'list', items: [2, 4, 6] }],
    ['listmap[listcreate[1,2],`$1*10`]', { kind: 'list', items: [10, 20] }],
    ['listreduce[listcreate[1,2,3],`$1+$2`]', 6],
    ['listsort[listcreate[3,1,2],`$1-$2`]', { kind: 'list', items: [1, 2, 3] }],
    ['dictgetitem[dictcreate[`1`,100000,`2`,150000],tostring[1+1]]', 150000],
    ['dictgetitem[dictcreate[a,1],zz]', 0],
    ['dicthaskey[dictcreate[a,1],a]', 1],
    ['dictsize[dictadditem[dictcreate[],k,v]]', 1],
    ['dictremovekey[dictcreate[a,1],a]', 1],
    ['dictkeys[dictcreate[a,1,b,2]]', { kind: 'list', items: ['a', 'b'] }],
    ['dictvalues[dictcreate[a,1,b,2]]', { kind: 'list', items: [1, 2] }],
    ['dictsize[dictclear[dictcreate[a,1]]]', 0],
    ['dictgetitem[dictcopy[dictcreate[a,1]],a]', 1],
    ['dictcreate[a,1]{a}', 1],
  ]);
  it('callbacks leave $1/$2 as they found them', () => {
    run('setvar[1,keep]');
    run('listmap[listcreate[1,2],`$1`]');
    expect(run('getvar[1]')).toBe('keep');
    expect(run('testvar[2]')).toBe(0);
  });
  it('the corpus door count: listreduce over doors with wobjectgetisdooropen', () => {
    expect(run('listreduce[wobjectfindalllandscapebyobjectclass[26],`$2+wobjectgetisdooropen[$1]`]')).toBe(1);
  });
  it('the corpus fellow filter: listfilter + listcontains against names', () => {
    run('setvar[closeChars,listcreate[Me,`Fellow Guy`]]');
    expect(run('listcount[listfilter[getfellownames[],`listcontains[getvar[closeChars],$1]`]]==listcount[getfellownames[]]')).toBe(1);
  });
  it('listpop on an empty list is an error at the call', () => {
    expect(() => run('listpop[listcreate[]]')).toThrow(/listpop: list is empty \(at 0\)/);
  });
});

describe('strings, numbers, logic', () => {
  cases([
    ['cstr[5]', '5'], ['cstr[floor[125/60]]', '2'], ['tostring[listcreate[1,a]]', '[1,a]'],
    ['cstrf[3.14159,`F2`]', '3.14'], ['cstrf[1234567.891,`N1`]', '1,234,567.9'], ['cstrf[0.5,`P0`]', '50 %'],
    ['cstrf[42,`D5`]', '00042'], ['cstrf[255,`X`]', 'FF'], ['cstrf[3.5,`0.00`]', '3.50'], ['cstrf[3.5,`#.##`]', '3.5'],
    ['cnumber[`12.5`]', 12.5], ['cnumber[junk]', 0], ['strlen[`hello`]', 5],
    ['getregexmatch[`Pyreal x25`,`\\d+`]', '25'], ['getregexmatch[abc,`\\d`]', ''],
    ['hexstr[255]', '0xFF'], ['chr[65]', 'A'], ['ord[A]', 65],
    ['floor[2.7]', 2], ['ceiling[2.1]', 3], ['round[2.5]', 2], ['round[3.5]', 4], ['round[2.6]', 3], ['abs[-4]', 4], ['sqrt[16]', 4],
    ['sin[0]', 0], ['cos[0]', 1], ['tan[0]', 0], ['asin[1]', Math.PI / 2], ['acos[1]', 0], ['atan[0]', 0], ['atan2[1,1]', Math.PI / 4],
    ['sinh[0]', 0], ['cosh[0]', 1], ['tanh[0]', 0],
    ['iif[1,a,b]', 'a'], ['iif[0,a,b]', 'b'], ['istrue[`x`]', 1], ['isfalse[`False`]', 1], ['istrue[listcreate[]]', 0],
    ['ifthen[1,`5+5`]', 10], ['ifthen[0,`5+5`,`1`]', 1], ['ifthen[0,`5+5`]', 0], ['exec[`2*21`]', 42],
    ['getobjectinternaltype[getvar[unset]]', 1], ['getobjectinternaltype[abc]', 3],
    ['getobjectinternaltype[wobjectfindininventorybynamerx[\\^Aged Legendary Key\\$]]', 7],
    ['getobjectinternaltype[wobjectfindininventorybyname[Nothing]]', 0],
    ['`abcdef`{1:3}', 'bc'], ['`abcdef`{:2}', 'ab'], ['`abcdef`{-2:}', 'ef'], ['`abc`{0}', 'a'],
  ]);
  it('iif evaluates both branches, as documented', () => {
    run('iif[1,setvar[a,1],setvar[b,2]]');
    expect([run('testvar[a]'), run('testvar[b]')]).toEqual([1, 1]);
  });
  it('randint uses the C# exclusive upper bound', () => {
    h.setRandom(0.999);
    expect(run('randint[0,32]')).toBe(31);
    h.setRandom(0);
    expect(run('randint[5,10]')).toBe(5);
  });
  it('truthy follows VTank rules', () => {
    expect([truthy(0), truthy(2), truthy(''), truthy('0'), truthy('False'), truthy('x'), truthy(null)]).toEqual([false, true, false, false, false, true, false]);
    expect(truthy({ kind: 'coords', ns: 0, ew: 0, z: 0 })).toBe(true);
  });
});

describe('stopwatches with a fake clock', () => {
  it('create, start, accumulate, stop, restart', () => {
    run('setvar[sw,stopwatchcreate[]]');
    expect(run('stopwatchelapsedseconds[$sw]')).toBe(0);
    run('stopwatchstart[$sw]');
    h.clock.t += 2500;
    expect(run('stopwatchelapsedseconds[getvar[sw]]')).toBe(2.5);
    run('stopwatchstop[$sw]');
    h.clock.t += 10_000;
    expect(run('stopwatchelapsedseconds[$sw]')).toBe(2.5);
    run('stopwatchstart[$sw]');
    h.clock.t += 125_000;
    // The corpus ChatExpr timer line.
    expect(run('\\/f Vaeshok\\ +cstr[floor[stopwatchelapsedseconds[getvar[sw]]/60]]+\\ Minutes\\ +cstr[floor[stopwatchelapsedseconds[getvar[sw]]%60]]+\\ Seconds]'))
      .toBe('/f Vaeshok 2 Minutes 7 Seconds');
  });
  it('getunixtime is the host clock in seconds', () => { expect(run('getunixtime[]')).toBe(1000); });
});

describe('world objects, location and inventory (fake host)', () => {
  cases([
    ['wobjectgetname[wobjectgetplayer[]]', 'Me'],
    ['wobjectgetid[wobjectfindnearestdoor[]]', 100],
    ['wobjectgetisdooropen[wobjectfindnearestdoor[]]', 1],
    ['wobjectgetisdooropen[wobjectfindbyid[105]]', 0],
    ['wobjectgetname[wobjectfindnearestmonster[]]', 'Drudge Skulker'],
    ['wobjectgetname[wobjectfindnearestbyobjectclass[24]]', 'Fellow Guy'],
    ['wobjectgetname[wobjectfindnearestbytemplatetype[8]]', 'Drudge Slinker'],
    ['wobjectgetname[wobjectfindnearestbynameandobjectclass[5,Slinker]]', 'Drudge Slinker'],
    ['wobjectisvalid[wobjectfindnearestbynameandobjectclass[14,Gateway]]', 1],
    ['wobjectisvalid[wobjectfindnearestbynameandobjectclass[14,Nope]]', 0],
    ['wobjectisvalid[getvar[unset]]', 0],
    ['wobjectgetstringprop[wobjectfindnearestbynameandobjectclass[14,Gateway],38]==\'Insatiable Vault\'', 1],
    ['wobjectgetintprop[wobjectgetplayer[],287]', 3],
    ['wobjectgetintprop[wobjectgetplayer[],288]', 0],
    ['wobjectgetdoubleprop[wobjectfindbyid[200],5]', 0.5],
    ['wobjectgetboolprop[wobjectfindbyid[200],9]', 1],
    ['wobjectgetobjectclass[wobjectfindbyid[300]]', 10],
    ['wobjectgettemplatetype[wobjectfindbyid[200]]', 2434],
    ['wobjectgethealth[wobjectfindbyid[101]]', 0.75],
    ['wobjecthasdata[wobjectfindbyid[200]]', 1],
    ['wobjectlastidtime[wobjectfindbyid[200]]', 1234],
    ['wobjectgetspellids[wobjectfindbyid[200]]', { kind: 'list', items: [1, 2] }],
    ['wobjectgetactivespellids[wobjectfindbyid[200]]', { kind: 'list', items: [2] }],
    ['wobjectgetname[wobjectgetselection[]]', 'Drudge Skulker'],
    ['wobjectgetopencontainer[]', null],
    ['coordinatetostring[wobjectgetphysicscoordinates[wobjectfindbyid[103]]]', '10.00N, 19.99W, 0.00Z'],
    ['wobjectgetphysicscoordinates[wobjectfindbyid[200]]', null],
    ['coordinatedistancewithz[getplayercoordinates[],wobjectgetphysicscoordinates[wobjectfindnearestdoor[]]]', 2.4],
    ['coordinatedistanceflat[coordinateparse[`1N, 1E, 5Z`],coordinateparse[`1N, 1E`]]', 0],
    ['coordinatedistancewithz[coordinateparse[`1N, 1E, 1Z`],coordinateparse[`1N, 1E`]]', 240],
    ['coordinategetns[getplayercoordinates[]]', 10], ['coordinategetwe[getplayercoordinates[]]', -20], ['coordinategetz[coordinateparse[`1.5S, 2.5W, -0.35Z`]]', -0.35],
    ['coordinatetostring[coordinateparse[`1.5S, 2.5W, -0.35Z`]]', '1.50S, 2.50W, -0.35Z'],
    ['coordinateparse[garbage]', null],
    ['getheadingto[wobjectfindbyid[103]]', 90], ['getheadingto[wobjectfindbyid[100]]', 0], ['getheadingto[wobjectfindbyid[101]]', 270],
    ['getheading[wobjectgetplayer[]]', 90],
    ['getplayerlandcell[]', 0xa9b40021], ['getplayerlandblock[]', 0xa9b40000],
    ['wobjectgetname[wobjectfindininventorybyname[Mana Stone]]', 'Mana Stone'],
    ['wobjectgetid[wobjectfindininventorybytemplatetype[273]]', 201],
    ['wobjectgetname[wobjectfindininventorybynamerx[`Key$`]]', 'Aged Legendary Key'],
    ['getitemcountininventorybyname[Pyreal]', 35],
    ['getitemcountininventorybynamerx[`^Py`]', 35],
    ['getinventorycountbytemplatetype[273]', 35],
    ['getcontaineritemcount[]', 4],
    ['getcontaineritemcount[wobjectfindbyid[300]]', 1],
    ['listcount[wobjectfindall[]]', 11],
    ['listcount[wobjectfindallinventory[]]', 5],
    ['listcount[wobjectfindalllandscape[]]', 6],
    ['listcount[wobjectfindallbyobjectclass[26]]', 2],
    ['listcount[wobjectfindallinventorybyobjectclass[7]]', 2],
    ['listcount[wobjectfindalllandscapebyobjectclass[5]]', 2],
    ['listcount[wobjectfindallbytemplatetype[412]]', 2],
    ['listcount[wobjectfindallinventorybytemplatetype[273]]', 2],
    ['listcount[wobjectfindalllandscapebytemplatetype[7]]', 1],
    ['listcount[wobjectfindallbynamerx[`^Drudge`]]', 2],
    ['listcount[wobjectfindallinventorybynamerx[Pyreal]]', 2],
    ['listcount[wobjectfindalllandscapebynamerx[`^(?!Closed).*Door`]]', 1],
    ['listcount[wobjectfindallbycontainer[wobjectfindbyid[300]]]', 1],
  ]);
  it('wobjectisvalid turns false once the object leaves the client', () => {
    run('setvar[d,wobjectfindnearestmonster[]]');
    expect(run('wobjectisvalid[$d]')).toBe(1);
    h.world.splice(h.world.findIndex((o) => o.id === 101), 1);
    expect(run('wobjectisvalid[$d]')).toBe(0);
    expect(run('wobjectgetname[$d]')).toBe('Drudge Skulker'); // falls back to the snapshot
  });
  it('wobjectrequestdata asks the host', () => {
    expect(run('wobjectrequestdata[wobjectfindbyid[101]]')).toBe(1);
    expect(h.log).toEqual(['request:101']);
  });
});

describe('character, fellowship, quests, game time', () => {
  cases([
    ['getcharintprop[25]', 275], ['getchardoubleprop[1]', 2.5], ['getcharboolprop[2]', 1], ['getcharquadprop[6] > 100000', 1],
    ['getcharstringprop[1]', 'Me'], ['getcharintprop[999]', 0],
    ['getcharvital_base[1]', 100], ['getcharvital_current[1]', 80], ['getcharvital_buffedmax[1]', 150], ['getcharvital_base[2]', 0],
    ['getcharskill_base[23]', 200], ['getcharskill_buffed[23]', 250], ['getcharskill_traininglevel[23] >= 2', 1], ['getcharskill_traininglevel[50]', 0],
    ['getcharattribute_base[1]', 100], ['getcharattribute_buffed[1]', 110],
    ['getcharburden[]', 42], ['vitae[]', 95], ['isportaling[]', 0], ['getbusystate[]', 0], ['getworldname[]', 'Coldeve'],
    ['getcombatstate[]', 'Peace'], ['setcombatstate[Melee];getcombatstate[]', 'Melee'],
    ['getisspellknown[1]', 1], ['getcancastspell_buff[1]', 1], ['getcancastspell_hunt[1]', 0], ['spellname[1]', 'Strength Other I'],
    ['componentname[1]', 'Lead Scarab'], ['getknownspells[]', { kind: 'list', items: [1, 2, 3] }],
    ['getspellexpiration[1]', 600], ['getspellexpirationbyname[`Strength Other I`]', 600],
    ['getfellowshipstatus[]', 1], ['getfellowshipname[]', 'Pals'], ['getfellowshipcount[]', 2],
    ['getfellownames[]', { kind: 'list', items: ['Me', 'Fellow Guy'] }], ['getfellowids[]', { kind: 'list', items: [1, 104] }],
    ['getfellowname[1]', 'Fellow Guy'], ['getfellowid[0]', 1], ['getfellowshipleaderid[]', 1], ['getfellowshipisleader[]', 1],
    ['getfellowshipisopen[]', 0], ['getfellowshiplocked[]', 1], ['getfellowshipisfull[]', 0], ['getfellowshipcanrecruit[]', 1],
    ['(5%getfellowshipcount[])==listindexof[getfellownames[],wobjectgetname[wobjectgetplayer[]]]', 0],
    ['getqueststatus[killtask]', 1], ['getqueststatus[legendaryquestsa]', 0], ['getqueststatus[neverdone]', 1],
    ['testquestflag[killtask]', 1], ['testquestflag[neverdone]', 0],
    ['getquestktprogress[killtask]', 12], ['getquestktrequired[killtask]', 50], ['isrefreshingquests[]', 0],
    ['getgameticks[]', 5925], ['getgameyear[]', 10], ['getgamemonth[]', 1], ['getgameday[]', 2], ['getgamehour[]', 5],
    ['getgamehourname[getgamehour[]]', 'Dawnsong'], ['getgamemonthname[getgamemonth[]]', 'Morningthaw'], ['getgamemonthname[10]', 'Snowreap'],
    ['getisday[]', 1], ['getisnight[]', 0], ['getminutesuntilday[]', 0], ['getminutesuntilnight[]', 63.5],
  ]);
  it('night: minutes until day count down to Dawnsong', () => {
    h.host.gameTicks = () => 4020; // Darktide
    expect([run('getisnight[]'), run('getminutesuntilday[]'), run('getminutesuntilnight[]')]).toEqual([1, 31.75, 0]);
  });
  it('outside a fellowship', () => {
    h.fellowship.f = null;
    expect([run('getfellowshipstatus[]'), run('getfellowshipcount[]'), run('listcount[getfellownames[]]'), run('getfellowshipisleader[]')]).toEqual([0, 0, 0, 0]);
  });
});

describe('actions, settings, chat, scheduling', () => {
  it('actions go through the host with object ids', () => {
    expect(run('actiontryselect[wobjectfindnearestmonster[]]')).toBe(1);
    expect(run('actiontryuseitem[wobjectfindininventorybyname[Mana Stone]]')).toBe(1);
    expect(run('actiontryapplyitem[wobjectfindininventorybyname[Mana Stone], wobjectfindnearestdoor[]]')).toBe(1);
    expect(run('actiontrygiveitem[wobjectfindininventorybyname[Pyreal],wobjectfindnearestbyobjectclass[24]]')).toBe(1);
    expect(run('actiontrygiveprofile[`loot.utl`,wobjectfindnearestbyobjectclass[24]]')).toBe(1);
    expect(run('actiontryequipanywand[]')).toBe(1);
    expect(run('actiontrycastbyid[1]')).toBe(1);
    expect(run('actiontrycastbyidontarget[1,wobjectgetplayer[]]')).toBe(1);
    expect(h.log).toEqual(['select:101', 'use:200', 'apply:200->100', 'give:201->104', 'giveprofile:loot.utl->104', 'cast:1', 'cast:1@1']);
    // No object (an empty search, an unset variable) is a failed try, not an error.
    expect([run('actiontryuseitem[wobjectfindininventorybyname[Nothing]]'), run('actiontryapplyitem[getvar[unset],wobjectgetplayer[]]'),
      run('actiontrygiveitem[wobjectgetplayer[],getvar[unset]]'), run('actiontryselect[getvar[unset]]'),
      run('actiontrycastbyidontarget[1,getvar[unset]]'), run('actiontrygiveprofile[x,getvar[unset]]')]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(h.log).toHaveLength(7);
  });
  it('motion: the corpus setmotion + delayexec pair', () => {
    expect(run('setmotion[Forward,1];delayexec[200,`setmotion[Forward,0]`]')).toBe(1);
    expect(run('getmotion[Forward]')).toBe(1);
    expect(h.scheduled.map((s) => s.ms)).toEqual([200]);
    h.scheduled[0]!.fn();
    expect(run('getmotion[Forward]')).toBe(0);
    expect(run('clearmotion[]')).toBe(1);
    expect(h.log).toEqual(['motion:Forward=true', 'motion:Forward=false', 'clearmotion']);
  });
  it('settings, UB options and meta state', () => {
    expect(run('vtsetsetting[EnableNav,`0`]')).toBe(1);
    expect(run('vtgetsetting[EnableNav]')).toBe('0');
    expect(run('uboptset[`Looter.Enabled`,True]')).toBe(1);
    expect(run('uboptget[`Looter.Enabled`]')).toBe(1);
    expect(run('vtsetmetastate[Hunt]')).toBe(1);
    expect(run('vtgetmetastate[]')).toBe('Hunt');
  });
  it('echo, chatbox, chatboxpaste, status hud', () => {
    run('echo[`Hello `+getcharstringprop[1],15]');
    run('echo[plain]');
    run('chatbox[\\/vt echo B1\\!]');
    run('chatboxpaste[draft]');
    run('statushud[k,v]');
    run('statushudcolored[k,v,255]');
    expect(h.log).toEqual(['echo:Hello Me@15', 'echo:plain', 'chat:/vt echo B1!', 'paste:draft', 'hud:k=v', 'hud:k=v@255']);
  });
  it('the corpus ChatExpr with getheadingto', () => {
    run('setvar[corpse,wobjectfindbyid[103]]');
    expect(run('\\/ub face +getheadingto[getvar[corpse]]')).toBe('/ub face 90');
  });
});

describe('parse errors carry positions; leniency matches what metas ship', () => {
  it('error positions', () => {
    const at = (src: string) => { try { parseExpr(src, { strict: true }); } catch (e) { return (e as ExprError).pos; } return null; };
    expect(at('1+')).toBe(2);
    expect(at('getvar[a')).toBe(8);
    expect(at('(1+2')).toBe(4);
    expect(at('`open')).toBe(0);
    expect(at('1 2]')).toBe(2);
    expect(at('$')).toBe(0);
    expect(() => parseExpr('getvar[a,b c[')).toThrow(ExprError);
  });
  it('unclosed calls at the end and stray trailing ] are accepted unless strict', () => {
    expect(() => parseExpr('cstr[1]]', { strict: true })).toThrow(/unexpected '\]'/);
    expect(run('cstr[1]]')).toBe('1');
    expect(run('cstr[cstr[7]')).toBe('7');
  });
  it('runtime errors name the function and position', () => {
    expect(() => run('1+floor[abc]')).toThrow(/floor: expected a number, got string 'abc' \(at 2\)/);
    expect(() => run('getvar[]')).toThrow(/getvar takes 1 argument, got 0/);
    expect(() => run('nosuchfn[1]')).toThrow(/unknown function nosuchfn/);
    expect(() => run('uiviewexists[v]')).toThrow(/unsupported function uiviewexists/);
  });
  it('a host without a capability reports the function as unsupported', () => {
    const bare: ExprHost = {
      getVar: () => undefined, setVar: () => {}, clearVar: () => false, clearAllVars: () => {}, now: () => 0, echo: () => {},
    };
    expect(() => runExpr('getfellowshipcount[]', bare)).toThrow(new ExprError('unsupported function getfellowshipcount', 0));
    expect(() => runExpr('1+wobjectfindnearestdoor[]', bare)).toThrow(/unsupported function wobjectfindnearestdoor \(at 2\)/);
    expect(runExpr('getvar[x]+1', bare)).toBe(1);
  });
  it('evalExpr runs a parsed tree', () => {
    const tree = parseExpr('getvar[n]*2');
    run('setvar[n,21]');
    expect(evalExpr(tree, h.host)).toBe(42);
  });
  it('function names are case-insensitive', () => { expect(run('CSTR[1]')).toBe('1'); });
  it('empty argument is the empty string', () => { expect(() => run('strlen[]')).toThrow(/takes 1/); expect(run('vtsetsetting[X,]')).toBe(1); });
});

describe('coverage', () => {
  it('every implemented function appears in a test case', () => {
    // Expressions evaluated outside `cases(...)` above.
    const extra = [
      'setvar getvar testvar clearvar touchvar clearallvars setgvar getgvar testgvar cleargvar touchgvar clearallgvars',
      'setpvar getpvar testpvar clearpvar touchpvar clearallpvars listpop listadd stopwatchcreate stopwatchstart stopwatchstop',
      'stopwatchelapsedseconds getunixtime randint actiontryselect actiontryuseitem actiontryapplyitem actiontrygiveitem',
      'actiontrygiveprofile actiontryequipanywand actiontrycastbyid actiontrycastbyidontarget setmotion getmotion clearmotion',
      'delayexec vtsetsetting vtgetsetting uboptset uboptget vtsetmetastate vtgetmetastate echo chatbox chatboxpaste statushud',
      'statushudcolored wobjectrequestdata getheadingto wobjectfindnearestmonster wobjectisvalid hexstr getquestktprogress',
    ].join(' ').split(/\s+/);
    const text = covered.join('\n').toLowerCase();
    const missing = EXPR_FUNCTIONS.filter((f) => !extra.includes(f) && !new RegExp(`\\b${f}\\[`).test(text));
    expect(missing).toEqual([]);
    expect(UNSUPPORTED_FUNCTIONS.some((f) => EXPR_FUNCTIONS.includes(f))).toBe(false);
  });
});
