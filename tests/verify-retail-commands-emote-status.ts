/**
 * Behavioral tests for the retail emote / status chat commands
 * (packages/renderer/src/chat/commands/EmoteStatusCommands.ts), driven
 * through the real CommandSystem dispatcher. Spec:
 * docs/retail-commands/emote-status.md.
 */
import { describe, it, expect } from 'vitest';
import { BinaryWriter, GameActionType } from '@ac/network';
import { CommandSystem, NOT_A_VALID_COMMAND } from '../packages/renderer/src/chat/commands/CommandSystem';
import {
  emoteStatusCommandEntries,
  EMOTE_LIST_TEXT,
  ENDURANCE_TEXT,
  RENDER_USAGE,
  RETAIL_VERBOSE_VERSION,
  isInt32,
  atoi,
  cFloat,
  positionToString,
  spellComponentCategoryFromString,
  type CommandPosition,
  type EmoteStatusCommandContext,
  type RenderPreference,
} from '../packages/renderer/src/chat/commands/EmoteStatusCommands';

interface Sent { type: number; bytes: number[] }
interface Printed { text: string; chatType: number; windowId: number }

function makeCtx(over: Partial<EmoteStatusCommandContext> = {}) {
  const sent: Sent[] = [];
  const printed: Printed[] = [];
  const calls: unknown[][] = [];
  const state = { day: false, fps: false };
  const ctx: EmoteStatusCommandContext = {
    print: (text, chatType, windowId) => { printed.push({ text, chatType, windowId }); },
    send: (type, write) => {
      const w = new BinaryWriter();
      write?.(w);
      sent.push({ type, bytes: [...w.toBuffer()] });
      return true;
    },
    talkFocus: () => 1,
    lastSpeakableTarget: () => 0,
    usingTurbineChat: () => false,
    turbineRoom: () => 0,
    sendTurbineChat: () => true,
    hearsAllegianceChat: () => true,
    isOlthoi: () => false,
    globalChannelName: () => '',
    chatPose: () => null,
    playPoseMotion: () => false,
    gender: () => 1,
    nowSeconds: () => 0,
    isPsr: () => false,
    selectedId: () => 0,
    weenieIsPlayer: () => null,
    fillComponentBuyList: (c, n) => { calls.push(['fill', c, n]); },
    clearDesiredComponents: () => { calls.push(['clearComps']); },
    alwaysDaylight: () => state.day,
    setDay: (on) => { state.day = on; calls.push(['setDay', on]); },
    setPersistentAtDay: (on) => { calls.push(['persistDay', on]); },
    framerateShown: () => state.fps,
    setFramerateDisplay: (on) => { state.fps = on; calls.push(['fps', on]); },
    playerPosition: () => null,
    verboseVersionString: () => RETAIL_VERBOSE_VERSION,
    sendAdminGetServerVersion: () => { calls.push(['serverVersion']); },
    hasSmartBox: () => true,
    modifyRenderPreference: (pref: RenderPreference, v: number) => { calls.push(['pref', pref, v]); return true; },
    ...over,
  };
  const sys = new CommandSystem(ctx, emoteStatusCommandEntries());
  return { sys, sent, printed, calls, state };
}

const SRC = 8;
function u32(v: number): number[] { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }
function str16(s: string): number[] {
  const out = [s.length & 0xff, s.length >> 8, ...[...s].map((c) => c.charCodeAt(0))];
  while (out.length % 4) out.push(0);
  return out;
}

describe('emote / status command table', () => {
  it('registers every retail name with its Help* function', () => {
    const byName = new Map(emoteStatusCommandEntries().map((e) => [e.name, e]));
    const expected: Record<string, string | null> = {
      e: 'HelpEmote', em: 'HelpEmote', emote: 'HelpEmote', me: 'HelpEmote', emotes: 'HelpEmoteList',
      fillcomps: 'HelpFillComponents', status: 'HelpStatusGroup', age: 'HelpAge', birth: 'HelpBirth',
      day: 'HelpDay', endurance: 'HelpEndurance', framerate: 'HelpFrameRate', loc: 'HelpLoc',
      version: 'HelpVersion', render: null,
    };
    expect([...byName.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [n, h] of Object.entries(expected)) expect(byName.get(n)!.help).toBe(h);
    expect(byName.get('status')!.handler).toBeNull();
  });

  it('@status (help-only group) falls through to Event_Talk of the whole line', () => {
    const { sys, sent, printed } = makeCtx();
    sys.onChatCommand('@status', SRC);
    expect(printed).toEqual([]);
    expect(sent).toEqual([{ type: GameActionType.Talk, bytes: str16('@status') }]);
  });
});

describe('DoEmote', () => {
  for (const name of ['e', 'em', 'emote', 'me', 'EMOTE']) {
    it(`@${name} sends Event_Emote 0x1DF with args joined by single spaces`, () => {
      const { sys, sent, printed } = makeCtx();
      sys.onChatCommand(`@${name}   waves\thello  there`, SRC);
      expect(sent).toEqual([{ type: 0x1df, bytes: str16('waves hello there') }]);
      expect(printed).toEqual([]);
    });
  }
  it('":" and ";" route to @emote', () => {
    const { sys, sent } = makeCtx();
    sys.onChatCommand(':dances', SRC);
    sys.onChatCommand(';bows low', SRC);
    expect(sent.map((s) => s.bytes)).toEqual([str16('dances'), str16('bows low')]);
  });
  it('empty emote is silent and successful', () => {
    const { sys, sent, printed } = makeCtx();
    sys.onChatCommand('/me', SRC);
    expect(sent).toEqual([]);
    expect(printed).toEqual([]);
  });
  it('a failed send prints "That is not a valid command."', () => {
    const { sys, printed } = makeCtx({ send: () => false });
    sys.onChatCommand('@e hi', SRC);
    expect(printed).toEqual([{ text: NOT_A_VALID_COMMAND, chatType: 0x1a, windowId: 0 }]);
  });
});

describe('DoEmoteList', () => {
  it('prints the static list, type 0, in the command window; args ignored', () => {
    const { sys, printed, sent } = makeCtx();
    sys.onChatCommand('@emotes whatever', 5);
    expect(printed).toEqual([{ text: EMOTE_LIST_TEXT, chatType: 0, windowId: 5 }]);
    expect(EMOTE_LIST_TEXT.startsWith('Standard Emotes:\nNote: These commands should be bound on either side by asterisks. (Example: *wave*)\nShakeFist; Beckon;')).toBe(true);
    expect(EMOTE_LIST_TEXT.endsWith('Scratch Head; Shake Head\n\n')).toBe(true);
    expect(EMOTE_LIST_TEXT.length).toBe(438);
    expect(sent).toEqual([]);
  });
});

describe('DoFillComponents', () => {
  const run = (line: string) => { const c = makeCtx(); c.sys.onChatCommand(line, SRC); return c; };

  it('no args fills every category uncapped', () => {
    expect(run('@fillcomps').calls).toEqual([['fill', 8, 0]]);
  });
  it('more than 2 args prints the usage hint', () => {
    const c = run('@fillcomps scarab 5 x');
    expect(c.calls).toEqual([]);
    expect(c.printed).toEqual([{ text: 'Please use @help fillcomps for proper usage.', chatType: 0x1a, windowId: SRC }]);
  });
  it('clear sends SetDesiredComponentLevel(0, -1), clears locally, prints', () => {
    const c = run('@fillcomps CLEAR');
    expect(c.sent).toEqual([{ type: 0x224, bytes: [...u32(0), ...u32(-1 >>> 0)] }]);
    expect(c.calls).toEqual([['clearComps']]);
    expect(c.printed).toEqual([{ text: 'Component list cleared.', chatType: 0x1a, windowId: SRC }]);
  });
  it('number alone caps all categories', () => {
    expect(run('@fillcomps 500').calls).toEqual([['fill', 8, 500]]);
    expect(run('@fillcomps 500 x').calls).toEqual([['fill', 8, 500]]); // retail quirk: 2nd arg ignored
    expect(run('@fillcomps 0x10').calls).toEqual([['fill', 8, 16]]); // strtol base 0
    expect(run('@fillcomps 010').calls).toEqual([['fill', 8, 8]]);
  });
  it('category forms', () => {
    expect(run('@fillcomps scarab').calls).toEqual([['fill', 0, 0]]);
    expect(run('@fillcomps Herbs 100').calls).toEqual([['fill', 1, 100]]);
    expect(run('@fillcomps powders').calls).toEqual([['fill', 2, 0]]);
    expect(run('@fillcomps potion 7').calls).toEqual([['fill', 3, 7]]);
    expect(run('@fillcomps talismans').calls).toEqual([['fill', 4, 0]]);
    expect(run('@fillcomps taper').calls).toEqual([['fill', 5, 0]]);
    expect(run('@fillcomps PEAS').calls).toEqual([['fill', 6, 0]]);
    expect(run('@fillcomps scarab abc').calls).toEqual([['fill', 0, 0]]);
  });
  it('non-positive values are refused', () => {
    for (const line of ['@fillcomps scarab 0', '@fillcomps -5', '@fillcomps 0']) {
      const c = run(line);
      expect(c.calls).toEqual([]);
      expect(c.printed).toEqual([{ text: 'Please specify a value greater than 0.', chatType: 0x1a, windowId: SRC }]);
    }
  });
  it('unknown category prints the error', () => {
    for (const line of ['@fillcomps foo', '@fillcomps 99999999999', '@fillcomps 08']) {
      const c = run(line);
      expect(c.calls).toEqual([]);
      expect(c.printed).toEqual([{ text: 'Invalid component type specified.', chatType: 0x1a, windowId: SRC }]);
    }
  });
  it('helpers', () => {
    expect(spellComponentCategoryFromString('AlchemicalSubstances')).toBe(3);
    expect(spellComponentCategoryFromString('PowderedGem')).toBe(2);
    expect(spellComponentCategoryFromString('gem')).toBeNull();
    expect(isInt32('-12')).toBe(true);
    expect(isInt32('2147483648')).toBe(false);
    expect(isInt32('0x')).toBe(false);
    expect(isInt32('12a')).toBe(false);
  });
});

describe('DoAge / DoBirth', () => {
  it('@age sends QueryAge(0) for a non-PSR', () => {
    const c = makeCtx({ selectedId: () => 0x50000001, weenieIsPlayer: () => true });
    c.sys.onChatCommand('@age', SRC);
    expect(c.sent).toEqual([{ type: 0x1c2, bytes: u32(0) }]);
    expect(c.printed).toEqual([]);
  });
  it('a PSR targets the selected player', () => {
    const c = makeCtx({ isPsr: () => true, selectedId: () => 0x50000001, weenieIsPlayer: () => true });
    c.sys.onChatCommand('@age', SRC);
    expect(c.sent).toEqual([{ type: 0x1c2, bytes: u32(0x50000001) }]);
  });
  it('a PSR with a non-player selection asks about self', () => {
    const c = makeCtx({ isPsr: () => true, selectedId: () => 0x80000001, weenieIsPlayer: () => false });
    c.sys.onChatCommand('@age', SRC);
    expect(c.sent).toEqual([{ type: 0x1c2, bytes: u32(0) }]);
  });
  it('a PSR with an unknown selected object fails', () => {
    const c = makeCtx({ isPsr: () => true, selectedId: () => 0x80000001, weenieIsPlayer: () => null });
    c.sys.onChatCommand('@age', SRC);
    expect(c.sent).toEqual([]);
    expect(c.printed).toEqual([{ text: NOT_A_VALID_COMMAND, chatType: 0x1a, windowId: 0 }]);
  });
  it('@birth sends QueryBirth(0); a failed send fails the command', () => {
    const c = makeCtx();
    c.sys.onChatCommand('@birth extra', SRC);
    expect(c.sent).toEqual([{ type: 0x1c4, bytes: u32(0) }]);
    const f = makeCtx({ send: () => false });
    f.sys.onChatCommand('@birth', SRC);
    expect(f.printed).toEqual([{ text: NOT_A_VALID_COMMAND, chatType: 0x1a, windowId: 0 }]);
  });
});

describe('DoDay', () => {
  it('toggles always-daylight and persists it', () => {
    const c = makeCtx();
    c.sys.onChatCommand('@day', SRC);
    c.sys.onChatCommand('@day', SRC);
    expect(c.calls).toEqual([['setDay', true], ['persistDay', true], ['setDay', false], ['persistDay', false]]);
    expect(c.printed).toEqual([
      { text: 'Let there be light!', chatType: 0x1a, windowId: SRC },
      { text: 'Normality has been restored.', chatType: 0x1a, windowId: SRC },
    ]);
  });
});

describe('DoEndurance', () => {
  it('prints the endurance text, type 0', () => {
    const c = makeCtx();
    c.sys.onChatCommand('@endurance', 3);
    expect(c.printed).toEqual([{ text: ENDURANCE_TEXT, chatType: 0, windowId: 3 }]);
    expect(ENDURANCE_TEXT.length).toBe(2459);
    expect(ENDURANCE_TEXT).toContain('remains one.\nThird,');
    expect(ENDURANCE_TEXT).toContain('level of "natural resistances" to the 7');
    expect(ENDURANCE_TEXT.endsWith('drain health attacks, etc.).\n')).toBe(true);
  });
});

describe('DoFrameRate', () => {
  it('toggles the meter silently; args are an error', () => {
    const c = makeCtx();
    c.sys.onChatCommand('@framerate', SRC);
    c.sys.onChatCommand('@framerate', SRC);
    expect(c.calls).toEqual([['fps', true], ['fps', false]]);
    expect(c.printed).toEqual([]);
    c.sys.onChatCommand('@framerate on', SRC);
    expect(c.calls.length).toBe(2);
    expect(c.printed).toEqual([{ text: 'Unexpected arguments to @framerate', chatType: 0x1a, windowId: SRC }]);
  });
});

describe('DoLoc', () => {
  const pos: CommandPosition = { objcellId: 0xa9b40019, origin: { x: 84, y: 7.1, z: 94.005 }, quat: { w: 1, x: 0, y: 0, z: -0 } };
  it('prints the Position::ToString line, type 0', () => {
    const c = makeCtx({ playerPosition: () => pos });
    c.sys.onChatCommand('@loc', SRC);
    // %f of the float-widened value: 7.1f = 7.099999904..., 94.005f = 94.004997253...
    expect(c.printed).toEqual([{
      text: 'Your location is: 0xA9B40019 [84.000000 7.100000 94.004997] 1.000000 0.000000 0.000000 -0.000000\n',
      chatType: 0, windowId: SRC,
    }]);
  });
  it('args, no player, cell 0', () => {
    const a = makeCtx({ playerPosition: () => pos });
    a.sys.onChatCommand('@loc x', SRC);
    expect(a.printed).toEqual([{ text: 'Unexpected arguments to @loc', chatType: 0x1a, windowId: SRC }]);
    const b = makeCtx();
    b.sys.onChatCommand('@loc', SRC);
    expect(b.printed).toEqual([]);
    const z = makeCtx({ playerPosition: () => ({ ...pos, objcellId: 0 }) });
    z.sys.onChatCommand('@loc', SRC);
    expect(z.printed).toEqual([{ text: 'Not in valid cell!', chatType: 0x1a, windowId: SRC }]);
  });
  it('ToString truncates at 100 chars and pads the cell id', () => {
    const big: CommandPosition = { objcellId: 0x10, origin: { x: 1e9, y: -1e9, z: 1e9 }, quat: { w: -1e9, x: 1e9, y: 1e9, z: 1e9 } };
    const s = positionToString(big);
    expect(s.length).toBe(100);
    expect(s.startsWith('0x00000010 [1000000000.000000 -1000000000.000000 ')).toBe(true);
    expect(cFloat(-0.0000001)).toBe('-0.000000');
    expect(cFloat(-0)).toBe('-0.000000');
  });
});

describe('DoVersion', () => {
  it('prints the client version (type 0)', () => {
    const c = makeCtx();
    c.sys.onChatCommand('@version', SRC);
    expect(c.printed).toEqual([{
      text: 'Client version 00.00.11.4186.r Portal:compiled Thu Sep  5 20:17:33 2013 : RETAIL\n', chatType: 0, windowId: SRC,
    }]);
    expect(c.calls).toEqual([]);
  });
  it('Turbine chat line first; a PSR also asks the server', () => {
    const c = makeCtx({ usingTurbineChat: () => true, isPsr: () => true });
    c.sys.onChatCommand('@version', SRC);
    expect(c.printed.map((p) => [p.text.slice(0, 15), p.chatType])).toEqual([['Using Turbine C', 0], ['Client version ', 0]]);
    expect(c.printed[0].text).toBe('Using Turbine Chat.\n');
    expect(c.calls).toEqual([['serverVersion']]);
  });
  it('args are an error', () => {
    const c = makeCtx({ isPsr: () => true });
    c.sys.onChatCommand('@version 2', SRC);
    expect(c.printed).toEqual([{ text: 'Unexpected arguments to @version', chatType: 0x1a, windowId: SRC }]);
    expect(c.calls).toEqual([]);
  });
});

describe('DoRenderOption', () => {
  const run = (line: string, over: Partial<EmoteStatusCommandContext> = {}) => { const c = makeCtx(over); c.sys.onChatCommand(line, SRC); return c; };
  const usageThenFail = [
    { text: RENDER_USAGE, chatType: 0, windowId: SRC },
    { text: NOT_A_VALID_COMMAND, chatType: 0x1a, windowId: 0 },
  ];

  it('usage: too few args or argv[1] == usage, then fails', () => {
    expect(run('@render').printed).toEqual(usageThenFail);
    expect(run('@render radius').printed).toEqual(usageThenFail);
    expect(run('@render x USAGE').printed).toEqual(usageThenFail);
    expect(RENDER_USAGE).toBe('Usage:\n@render <option> <value>\n  radius #        : set landscape radius (between 5 and 25)\n  fov #           : set field of view (between 10 and 160)\n');
  });
  it('retail quirk: the option is the second word', () => {
    const c = run('@render radius 10');
    expect(c.printed).toEqual([]);
    expect(c.calls).toEqual([]);
  });
  it('radius', () => {
    const ok = run('@render x radius 10');
    expect(ok.calls).toEqual([['pref', 'Render_LandscapeDrawDistance', 10]]);
    expect(ok.printed).toEqual([{ text: 'Landscape radius set', chatType: 0x1a, windowId: SRC }]);
    for (const v of ['4', '26', '-5', 'abc']) {
      const bad = run(`@render x radius ${v}`);
      expect(bad.calls).toEqual([]);
      expect(bad.printed).toEqual([{ text: 'Radius must be between 5 and 25', chatType: 0x1a, windowId: SRC }]);
    }
    expect(run('@render x radius 25').calls).toEqual([['pref', 'Render_LandscapeDrawDistance', 25]]);
    expect(run('@render x Radius').printed).toEqual([{ text: 'Must specify a radius', chatType: 0x1a, windowId: SRC }]);
  });
  it('fov', () => {
    const ok = run('@render x fov 90');
    expect(ok.calls).toEqual([['pref', 'Render_FieldOfView', 90]]);
    expect(ok.printed).toEqual([{ text: 'Field of view set', chatType: 0x1a, windowId: SRC }]);
    expect(run('@render x fov 161').printed).toEqual([{ text: 'Field of view must be between 10 and 160', chatType: 0x1a, windowId: SRC }]);
    expect(run('@render x fov 9').calls).toEqual([]);
    expect(run('@render x fov').printed).toEqual([{ text: 'Must specify a field of view', chatType: 0x1a, windowId: SRC }]);
  });
  it('unknown option is silent success; no SmartBox fails', () => {
    expect(run('@render x bloom 1').printed).toEqual([]);
    expect(run('@render x radius 10', { hasSmartBox: () => false }).printed).toEqual([{ text: NOT_A_VALID_COMMAND, chatType: 0x1a, windowId: 0 }]);
  });
  it('atoi', () => {
    expect(atoi(' 12abc')).toBe(12);
    expect(atoi('-3')).toBe(-3);
    expect(atoi('x')).toBe(0);
  });
});
