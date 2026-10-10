/**
 * AGENT.hosted-mcp-connector step 2 — ac_status, ac_enter_world and ac_goal,
 * the hosted ac_wait cap, a character-scoped grant's rule, and the
 * per-account call rate (docs/hosted-agent-connector.md §3, §6). The agent
 * API runs on the shared fake host; the tools run through a caller as the
 * bridge's /mcp builds it.
 */
import { describe, expect, it } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi';
import { FakeHost } from './_harness/agentFake';
import { TOOLS, TOOL_CALLER, formatStatus, type ToolCaller } from '../tools/ac-agent/tools';
import { HOSTED_MAX_WAIT_MS, scopeRefusal } from '../services/ws-tcp-bridge/src/mcpHttp';
import { AgentRelay, RATE } from '../services/ws-tcp-bridge/src/relay';

const CHARS = [{ name: 'Jake', pendingDeletion: false }, { name: 'Jakemule', pendingDeletion: false }, { name: 'Oldie', pendingDeletion: true }];

function selectHost() {
  const host = new FakeHost();
  host.screenName = 'character-select';
  const entered: string[] = [];
  const goals: Array<string | null> = [];
  Object.assign(host, {
    characterList: () => CHARS,
    enterCharacter: (n: string) => {
      const c = CHARS.find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (!c) return `no character named ${n} on this account (Jake, Jakemule, Oldie)`;
      if (c.pendingDeletion) return `${c.name} is pending deletion`;
      entered.push(c.name);
      host.me = { ...host.me, name: c.name };
      host.screenName = 'world';
      return null;
    },
    showGoal: (t: string | null) => goals.push(t),
  });
  return { host, api: new AgentApi(host), entered, goals };
}

describe('the tab: status, entering the world, the goal line', () => {
  it('status at character select lists the account\'s characters and no one in the world; in the world, the character', async () => {
    const { api, host } = selectHost();
    expect(api.status()).toEqual({ screen: 'character-select', character: null, characters: CHARS, goal: null });
    expect((await api.enterWorld('jakemule')).message).toBe('in the world as Jakemule');
    expect(api.status()).toMatchObject({ screen: 'world', character: 'Jakemule' });
    expect(host.screenName).toBe('world');
  });

  it('enterWorld refuses an unknown or pending-deletion name, another character in the world, and a screen that isn\'t character select', async () => {
    const { api, host, entered } = selectHost();
    expect(await api.enterWorld('')).toMatchObject({ ok: false, message: 'name the character to enter as' });
    expect(await api.enterWorld('Nobody')).toMatchObject({ ok: false, message: /no character named Nobody/ });
    expect(await api.enterWorld('Oldie')).toMatchObject({ ok: false, message: 'Oldie is pending deletion' });
    host.screenName = 'loading';
    expect(await api.enterWorld('Jake')).toMatchObject({ ok: false, message: 'not at character select (the screen is loading)' });
    host.screenName = 'world';
    host.me = { ...host.me, name: 'Jake' };
    expect(await api.enterWorld('jake')).toEqual({ ok: true, message: 'already in the world as Jake' });
    expect(await api.enterWorld('Jakemule')).toMatchObject({ ok: false, message: 'Jake is in the world; log out to character select first' });
    expect(entered).toEqual([]);
  });

  it('a login that never reaches the world times out with the screen', async () => {
    const { api, host } = selectHost();
    (host as unknown as { enterCharacter: () => null }).enterCharacter = () => null;
    const tick = setInterval(() => { host.t += 1000; }, 5);
    try { expect(await api.enterWorld('Jake', 3000)).toEqual({ ok: false, message: 'still not in the world after 3 s (screen: character-select)' }); } finally { clearInterval(tick); }
  });

  it('the goal line: one trimmed line, shown to the player, cleared by an empty text', () => {
    const { api, goals } = selectHost();
    expect(api.setGoal('  farm drudges\n near Holtburg  ')).toEqual({ ok: true, message: 'goal: farm drudges near Holtburg' });
    expect(api.status().goal).toBe('farm drudges near Holtburg');
    expect(api.setGoal('x'.repeat(300)).message).toHaveLength(6 + 200);
    expect(api.setGoal('')).toEqual({ ok: true, message: 'goal cleared' });
    expect(goals).toEqual(['farm drudges near Holtburg', 'x'.repeat(200), null]);
    expect(api.surface()).toMatchObject({ status: expect.any(Function), enterWorld: expect.any(Function), goal: expect.any(Function) });
  });
});

describe('the tools through a hosted caller', () => {
  const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
  function caller(tab: 'none' | 'off' | 'on', api: AgentApi | null, scope: 'any' | string[] = 'any') {
    const calls: Array<{ method: string; args: unknown[]; timeoutMs?: number }> = [];
    const surface = api?.surface() as Record<string, (...a: unknown[]) => unknown> | undefined;
    const c: ToolCaller = {
      notice: null, maxWaitMs: HOSTED_MAX_WAIT_MS,
      connection: () => ({ account: 'jake', characters: scope, tab, character: null, screen: null }),
      call: async <T>(method: string, args: unknown[] = [], timeoutMs?: number) => { calls.push({ method, args, timeoutMs }); if (!surface) throw new Error('your game is not open'); return (await surface[method](...args)) as T; },
    };
    return { c, calls };
  }

  it('ac_status: the bridge\'s view alone when no tab is open; with the tab, its screen and characters', async () => {
    const none = caller('none', null);
    const t1 = await TOOL_CALLER.run(none.c, () => tool('ac_status').run({}));
    expect(t1.text).toBe('account jake; this connection plays any of its characters\ngame: not open. The player logs in at playwebac.com in a browser tab; Claude cannot log in.');
    expect(none.calls).toEqual([]);
    const { api } = selectHost();
    const on = caller('on', api, ['Jake']);
    const t2 = await TOOL_CALLER.run(on.c, () => tool('ac_status').run({}));
    expect(t2.text).toBe('account jake; this connection plays only Jake\nscreen: character-select\ncharacters: Jake, Jakemule. Enter with ac_enter_world.');
    const off = await TOOL_CALLER.run(caller('off', api).c, () => tool('ac_status').run({}));
    expect(off.text).toMatch(/Claude is switched off in that tab/);
  });

  it('ac_enter_world, ac_goal; ac_wait is capped at 25 s for the hosted connector', async () => {
    const { api } = selectHost();
    const on = caller('on', api);
    expect((await TOOL_CALLER.run(on.c, () => tool('ac_enter_world').run({ character: 'Jake' }))).text).toBe('in the world as Jake');
    expect(on.calls[0]).toEqual({ method: 'enterWorld', args: ['Jake'], timeoutMs: 70_000 });
    expect((await TOOL_CALLER.run(on.c, () => tool('ac_goal').run({ text: 'level to 10' }))).text).toBe('goal: level to 10');
    expect(await TOOL_CALLER.run(on.c, () => tool('ac_status').run({}))).toMatchObject({ text: expect.stringContaining('screen: world; in the world: Jake\ngoal: level to 10') });
    const waits = caller('on', null);
    waits.c.call = async <T>(method: string, args: unknown[] = [], timeoutMs?: number) => { waits.calls.push({ method, args, timeoutMs }); return [] as T; };
    expect((await TOOL_CALLER.run(waits.c, () => tool('ac_wait').run({ timeout_s: 120 }))).text).toBe('(nothing within 25 s)');
    // ac_wait asks the page's wait (counting from the last look), capped at the hosted 25 s.
    expect(waits.calls[0]).toMatchObject({ method: 'wait', args: [expect.anything(), 25_000] });
    // A tab on an older build through the relay ("unknown method wait") falls back to waitFor.
    const old = caller('on', null);
    old.c.call = async <T>(method: string, args: unknown[] = [], timeoutMs?: number) => {
      old.calls.push({ method, args, timeoutMs });
      if (method === 'wait') throw new Error('unknown method wait');
      return [] as T;
    };
    expect((await TOOL_CALLER.run(old.c, () => tool('ac_wait').run({ timeout_s: 120 }))).text).toBe('(nothing within 25 s)');
    expect(old.calls.map((c) => c.method)).toEqual(['wait', 'waitFor']);
  });

  it('formatStatus without the bridge\'s view (the local daemon)', () => {
    expect(formatStatus(null, { screen: 'world', character: 'Claude', characters: [], goal: null }, null)).toBe('screen: world; in the world: Claude');
    expect(formatStatus(null, null, 'the game disconnected')).toBe('game: the game disconnected');
    expect(formatStatus(null, { screen: 'character-select', character: null, characters: [], goal: null }, null)).toMatch(/no characters on this account/);
  });
});

describe('the bridge\'s rules', () => {
  it('a character-scoped grant: refused while another is in the world; enterWorld only for its characters; reading at character select is fine', () => {
    expect(scopeRefusal('any', 'Mule', 'observe', [])).toBeNull();
    expect(scopeRefusal(['Jake'], 'Mule', 'observe', [])).toBe('this connection plays only Jake; Mule is in the world');
    expect(scopeRefusal(['Jake'], 'jake', 'observe', [])).toBeNull();
    expect(scopeRefusal(['Jake'], null, 'status', [])).toBeNull();
    expect(scopeRefusal(['Jake'], null, 'enterWorld', ['Mule'])).toBe('this connection plays only Jake');
    expect(scopeRefusal(['Jake'], null, 'enterWorld', [' JAKE '])).toBeNull();
  });

  it('calls per account: a 20-call burst, then 10 a second; each account its own; a day\'s cap', async () => {
    let t = 1_000_000_000;
    const relay = new AgentRelay(() => t);
    const peer = { send: () => {} };
    relay.register(peer, 'local-eor:jake');
    relay.onText(peer, '{"agentState":{"relay":"on"}}');
    for (let i = 0; i < RATE.burst; i++) expect(relay.overLimit('local-eor:jake')).toBeNull();
    expect(relay.overLimit('local-eor:jake')).toBe('too many calls: wait 0.1 s');
    await expect(relay.call('local-eor:jake', 'observe')).rejects.toThrow(/too many calls/);
    expect(relay.overLimit('local-eor:other')).toBeNull();
    t += 1000;
    for (let i = 0; i < RATE.perSec; i++) expect(relay.overLimit('local-eor:jake')).toBeNull();
    expect(relay.overLimit('local-eor:jake')).toMatch(/too many calls/);
    let n = 0;
    for (;;) { t += 1000; let stop = false; for (let i = 0; i < RATE.perSec; i++) { const r = relay.overLimit('local-eor:day'); if (r) { expect(r).toMatch(/daily limit of 50000/); stop = true; break; } n++; } if (stop) break; }
    expect(n).toBe(RATE.perDay);
  });
});
