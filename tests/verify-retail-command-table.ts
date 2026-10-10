/**
 * The assembled retail command table (chat/commands/index.ts) holds exactly
 * the names retail registers: InitializeCommands @ 00581970 (116 names)
 * and, once Turbine chat starts, StartupTurbineChatSystem @ 0057efb0.
 * Every invented command we used to answer (/suicide, /quit, /who, /time,
 * /reconnect, /cls, /ca, /mansion, /co, /cs, the /wave pose commands …) is
 * absent, so DoCommand sends it to the server as Talk like retail.
 */
import { describe, it, expect } from 'vitest';
import { RetailCommandSystem, type RetailCommandContext } from '../packages/renderer/src/chat/commands/index.js';

const INIT_NAMES = ["?", "help", "commands", "allegiances", "allegiance", "all", "ab", "alh", "ah", "motd", "speaker", "channels", "a", "co-vassals", "covassals", "covassal", "c", "fellowship", "fellows", "fellow", "f", "group", "g", "party", "monarch", "m", "patron", "p", "vassals", "vassal", "v", "join", "leave", "chatting", "chat", "notell", "reply", "r", "rp", "mr", "pr", "retell", "rt", "say", "s", "tell", "t", "send", "whisper", "w", "afk", "death", "consent", "corpse", "cor", "die", "lifestone", "lif", "ls", "marketplace", "mar", "mp", "permit", "pkarena", "pka", "pklarena", "pla", "e", "em", "emote", "me", "emotes", "fillcomps", "loadfile", "friends", "friends_add", "friends_remove", "house", "hou", "hslist", "hor", "hr", "hom", "hoa", "squelch", "unsquelch", "messagetypes", "message_types", "msgtypes", "msg_types", "status", "age", "birth", "day", "endurance", "framerate", "loc", "pklite", "pkl", "render", "version", "saveui", "loadui", "saveautoui", "loadautoui", "lockui", "text", "clear", "filter", "unfilter", "log", "title", "index", "clist", "on", "off"];
const TURBINE_NAMES = ["a", "guild", "gu", "general", "cg", "trade", "ct", "lfg", "clfg", "roleplay", "crp", "society", "soc", "olthoi", "o"];

function system() {
  const sent: number[] = [];
  const ctx = new Proxy({} as RetailCommandContext, {
    get: (_t, k) => (k === 'send' ? (type: number) => { sent.push(type); return true; } : () => undefined),
  });
  return { sys: new RetailCommandSystem(ctx), sent };
}

describe('retail command table', () => {
  it('InitializeCommands registers exactly the retail names', () => {
    const { sys } = system();
    expect(sys.entries().map((e) => e.name.toLowerCase()).sort()).toEqual([...new Set(INIT_NAMES.map((n) => n.toLowerCase()))].sort());
  });
  it('StartupTurbineChatSystem adds the Turbine chat names and replaces a', () => {
    const { sys } = system();
    const before = sys.lookup('a');
    sys.startTurbineChat();
    for (const n of TURBINE_NAMES) expect(sys.lookup(n), n).toBeDefined();
    expect(sys.lookup('a')).not.toBe(before);
    expect(sys.entries().length).toBe(new Set([...INIT_NAMES, ...TURBINE_NAMES].map((n) => n.toLowerCase())).size);
  });
  it('invented commands are not in the table: they go to the server as Talk', () => {
    const { sys, sent } = system();
    sys.startTurbineChat();
    for (const n of ['suicide', 'quit', 'logoff', 'logout', 'exit', 'reconnect', 'who', 'time', 'cls', 'ca', 'cancelattack',
      'mansion', 'pk', 'co', 'cs', 'csoc', 'location', 'logging', 'officers', 'setmotd', 'abandon', 'wave', 'bow']) {
      expect(sys.lookup(n), n).toBeUndefined();
    }
    sys.onChatCommand('/suicide', 8);
    expect(sent).toEqual([0x15]);
  });
});
