/**
 * tools/ac-agent: the tool table, CLI argument parsing and the MCP stdio
 * protocol handler (docs/agent-play.md). No game session needed.
 */
import { describe, expect, it } from 'vitest';
import { TOOLS, TOOL_BY_NAME, defaultAttach, inputSchema, parseGuid } from '../tools/ac-agent/tools.ts';
import { parseCliArgs } from '../tools/ac-agent/cli.ts';
import { handle, serverInstructions, toolContent } from '../tools/ac-agent/mcp-server.ts';
import { accountForProfile } from '../tools/ac-agent/state.ts';
import { defaultCharacterName, parseArgs, parseAttributeChoices, parseSkillChoices, pickGameTab, portFree, sharedDirFor } from '../tools/ac-agent/daemon.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('agent tool table', () => {
  it('has unique ac_* names and well-formed schemas', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^ac_[a-z_]+$/);
      const s = inputSchema(t) as { type: string; properties: Record<string, unknown>; required: string[] };
      expect(s.type).toBe('object');
      for (const r of s.required) expect(s.properties).toHaveProperty(r);
    }
    for (const n of ['ac_start', 'ac_observe', 'ac_walk_to', 'ac_attack', 'ac_cast', 'ac_wait', 'ac_loot', 'ac_say', 'ac_screenshot']) expect(TOOL_BY_NAME.has(n)).toBe(true);
  });
  it('parses guids the way observe prints them', () => {
    expect(parseGuid('#8000123a')).toBe(0x8000123a);
    expect(parseGuid('0x8000123a')).toBe(0x8000123a);
    expect(parseGuid('8000123a')).toBe(0x8000123a);
    expect(parseGuid(42)).toBe(42);
    expect(() => parseGuid('')).toThrow();
  });
});

describe('agent CLI args', () => {
  it('maps key=value and a bare first value onto the tool props', () => {
    const say = TOOL_BY_NAME.get('ac_say')!;
    expect(parseCliArgs(say, ['Hello there'])).toEqual({ text: 'Hello there' });
    const walk = TOOL_BY_NAME.get('ac_walk_to')!;
    expect(parseCliArgs(walk, ['target=42.1N, 33.6E', 'within=3'])).toEqual({ target: '42.1N, 33.6E', within: 3 });
    const start = TOOL_BY_NAME.get('ac_start')!;
    expect(parseCliArgs(start, ['headless=true', 'profile=claude2'])).toEqual({ headless: true, profile: 'claude2' });
    expect(() => parseCliArgs(walk, ['bogus=1'])).toThrow(/unknown argument/);
  });
});

describe('agent MCP server', () => {
  it('answers initialize, tools/list and unknown methods; ignores notifications', async () => {
    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as any;
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities).toHaveProperty('tools');
    const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as any;
    expect(list.result.tools.length).toBe(TOOLS.length);
    expect(list.result.tools[0]).toHaveProperty('inputSchema');
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const bad = await handle({ jsonrpc: '2.0', id: 3, method: 'nope' }) as any;
    expect(bad.error.code).toBe(-32601);
  });
  it('reports a tool failure as an isError result, not a protocol error', async () => {
    process.env.ACJS_AGENT_STATE_DIR = '/nonexistent-acjs-agent-test';
    const r = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ac_observe', arguments: { profile: 'definitely-not-running' } } }) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/error/);
  });
  it('puts screenshots in an image block', () => {
    expect(toolContent({ text: 'shot', jpegBase64: 'AAA' }).content).toEqual([
      { type: 'image', data: 'AAA', mimeType: 'image/jpeg' }, { type: 'text', text: 'shot' },
    ]);
  });
});

describe('agent daemon setup', () => {
  it('gives each profile its own account, never a human or probe one', () => {
    expect(accountForProfile('claude')).toBe('agentclaude');
    expect(accountForProfile('Agent-7')).toBe('agent7');
    expect(accountForProfile('testacjs')).toBe('agenttestacjs');
    expect(defaultCharacterName('claude')).toBe('Claude');
    expect(parseArgs(['--template', 'War Mage', '--heritage', 'Sho', '--gender', 'female', '--town', 'Shoushi', '--seed', '42']).choices)
      .toEqual({ template: 'War Mage', heritage: 'Sho', gender: 'female', town: 'Shoushi', seed: 42 });
    const rolled = parseArgs([]).choices.seed;
    expect(Number.isInteger(rolled) && rolled >= 0).toBe(true);
    const loot = TOOL_BY_NAME.get('ac_loot')!;
    expect(parseCliArgs(loot, ['target=Corpse of Drudge'])).toEqual({ target: 'Corpse of Drudge' });
    expect(parseArgs(['--profile', 'ann', '--headless'])).toMatchObject({ profile: 'ann', account: 'agentann', headless: true, character: 'Claude Ann', eraKey: 'eor', base: null, attach: null });
  });
});

describe('attaching to the human\'s own tab', () => {
  const tab = (url: string) => ({ url: () => url });
  it('takes a CDP endpoint and is offered on ac_start', () => {
    expect(parseArgs(['--profile', 'me', '--attach', 'http://127.0.0.1:9222'])).toMatchObject({ profile: 'me', attach: 'http://127.0.0.1:9222' });
    expect(TOOL_BY_NAME.get('ac_start')!.props.attach?.type).toBe('string');
    expect(parseCliArgs(TOOL_BY_NAME.get('ac_start')!, ['attach=chrome'])).toEqual({ attach: 'chrome' });
  });
  it('drives the tab with the agent API on, else a game page, never an unrelated tab', () => {
    const mail = tab('https://mail.google.com/'), game = tab('https://playwebac.com/'), agent = tab('https://playwebac.com/?agent');
    expect(pickGameTab([mail, game, agent], [false, false, true])).toBe(agent);
    expect(pickGameTab([mail, game], [false, false])).toBe(game);
    expect(pickGameTab([tab('http://localhost:3000/?ace&agent&bridge=ws://x')], [false])).not.toBeNull();
    expect(pickGameTab([mail, tab('https://example.com/?agentx=1')], [false, false])).toBeNull();
  });
});

describe('agent eras', async () => {
  const { AGENT_ERAS, agentEra, eraAccount } = await import('../tools/ac-agent/eras.ts');
  it('covers every era profile the client has, and end of retail', async () => {
    const { ERA_PROFILES, EOR_ERA_ID } = await import('../packages/renderer/src/era/EraProfiles.ts');
    const ids = Object.values(AGENT_ERAS).map((e) => e.id ?? EOR_ERA_ID);
    // A new era in the client must get an agent entry (its server ports, bridge era, account handling).
    expect(new Set(ids)).toEqual(new Set(Object.values(ERA_PROFILES).map((p) => p.id)));
    expect(agentEra(undefined).id).toBeNull();
    expect(() => agentEra('nope')).toThrow(/unknown era/);
  });
  it('pins AC1999 bridges to its protocol and keeps accounts within each server\'s limits', () => {
    expect(AGENT_ERAS['ac1999-retail'].bridgeEra).toBe('ac1999-retail');
    expect(eraAccount('agentclaude', AGENT_ERAS['ac1999-retail'])).toBe('agentc99');
    expect(eraAccount('agentclaude', AGENT_ERAS['classic-dereth'])).toBe('agentclaudecd');
    expect(eraAccount('agentclaude', AGENT_ERAS.eor)).toBe('agentclaude');
    for (const e of Object.values(AGENT_ERAS)) expect(eraAccount('AgentClaude', e)).toMatch(/^[a-z0-9]+$/);
  });
  it('demotes only where the server creates admins (ACE-based), never GDL / 1999', () => {
    expect(AGENT_ERAS.eor.access?.player).toBe(0);
    expect(AGENT_ERAS['classicace-customdm'].access?.table).toBe('ace_auth_customdm.account');
    expect(AGENT_ERAS['classic-dereth'].access).toBeNull();
    expect(AGENT_ERAS['ac1999-retail'].access).toBeNull();
  });
  it('era sessions keep the base profile\'s character name and a short era account', () => {
    expect(eraAccount('agentclaude', AGENT_ERAS['classicace-infiltration'])).toBe('agentclaudein');
    expect(defaultCharacterName('claude')).toBe('Claude');
  });

  it('the daemon resolves era, account and the URL era', () => {
    const a = parseArgs(['--profile', 'claude', '--era', 'ac1999-retail']);
    expect(a).toMatchObject({ eraKey: 'ac1999-retail', account: 'agentc99' });
  });
  it('plays the end-of-retail client against the local GDLE as its own session', () => {
    // Same client era (no ?era=), GDLE's ports, its own account and session key.
    expect(AGENT_ERAS.gdle).toMatchObject({ id: null, ports: [9110, 9111], access: null });
    expect(eraAccount('agentclaude', AGENT_ERAS.gdle)).toBe('agentclaudegd');
    expect(parseArgs(['--profile', 'claude-gdle', '--era', 'gdle', '--account', 'agentclaudegd'])).toMatchObject({ eraKey: 'gdle', account: 'agentclaudegd' });
    expect(parseArgs(['--era', 'end-of-retail']).eraKey).toBe('eor');
  });
});

describe('agent journal', async () => {
  const { addNote, formatJournal, openGoals } = await import('../tools/ac-agent/journal.ts');
  it('keeps open goals until a done note names them, and shows the latest of each kind', () => {
    const j = { character: 'Claude', account: 'agentclaude', era: 'eor', notes: [] as never[] };
    const t = (m: number) => new Date(Date.UTC(2026, 9, 7, 6, m));
    addNote(j, 'goal', 'Get the Blacksmith his bellows', undefined, t(0));
    addNote(j, 'goal', 'Reach level 10', undefined, t(1));
    addNote(j, 'place', 'Holtburg grocer: Fispur Ansel, sells food', '42.1N, 33.6E', t(2));
    addNote(j, 'done', 'got the blacksmith his bellows', undefined, t(3));
    expect(openGoals(j).map((g) => g.text)).toEqual(['Reach level 10']);
    const text = formatJournal(j);
    expect(text).toContain('open goals:\n  - Reach level 10');
    expect(text).toContain('Holtburg grocer: Fispur Ansel, sells food  @ 42.1N, 33.6E');
    expect(formatJournal({ ...j, notes: [] })).toMatch(/journal is empty/);
  });
});

describe('a new character\'s attributes and skills (custom builds such as a tinkerer)', () => {
  it('parses attributes in order and skills by name, from ac_start or the CLI', () => {
    expect(Object.entries(parseAttributeChoices('coordination=100, Focus=100; self:100,strength=10'))).toEqual([['coordination', 100], ['focus', 100], ['self', 100], ['strength', 10]]);
    expect(parseSkillChoices('Weapon Tinkering=trained; Armor Tinkering=train, War Magic=specialised, Run:untrained'))
      .toEqual({ 'Weapon Tinkering': 'trained', 'Armor Tinkering': 'train', 'War Magic': 'specialised', Run: 'untrained' });
    expect(() => parseAttributeChoices('strength')).toThrow(/not name=value/);
    expect(() => parseSkillChoices('War Magic=mastered')).toThrow(/specialized\|trained\|untrained/);
    const a = parseArgs(['--attributes', 'focus=100', '--skills', 'Item Tinkering=trained']);
    expect(a.choices).toMatchObject({ attributes: { focus: 100 }, skills: { 'Item Tinkering': 'trained' } });
    expect(TOOL_BY_NAME.get('ac_start')!.props.skills?.type).toBe('string');
    expect(TOOL_BY_NAME.get('ac_allegiance')!.props.action?.enum).toEqual(['show', 'swear', 'break']);
  });
});

describe('waiting for the world stops on a real error', async () => {
  const { waitFor } = await import('../tools/lib/game-session.ts');
  // A page that is never in the world; waitForTimeout returns at once.
  const page = { evaluate: async () => false, waitForTimeout: async () => {}, reload: async () => {} } as never;
  it('rethrows a refused character, retries a poll cut off by a navigation', async () => {
    await expect(waitFor(page, 'false', { timeoutMs: 1000, pollMs: 1, onPoll: async () => { throw new Error('the server refused to create "Main Claude": That name is already in use.'); } }))
      .rejects.toThrow(/already in use/);
    let polls = 0;
    const ok = await waitFor(page, 'false', { timeoutMs: 50, pollMs: 1, reloadEveryMs: 0, onPoll: async () => { polls++; throw new Error('Execution context was destroyed, most likely because of a navigation'); } });
    expect(ok).toBe(false);
    expect(polls).toBeGreaterThan(1);
  });
});

describe('Claude Desktop plays the human\'s own character by default (AC_AGENT_ATTACH)', () => {
  it('a bare ac_start attaches; naming a local-server choice still plays locally; unset keeps local', () => {
    expect(defaultAttach({}, 'chrome')).toBe('chrome');
    expect(defaultAttach({}, undefined)).toBeUndefined();
    expect(defaultAttach({ era: 'ac1999-retail' }, 'chrome')).toBeUndefined();
    expect(defaultAttach({ profile: 'tink', character: 'Tinker Claude' }, 'chrome')).toBeUndefined();
  });
  it('tells Claude it is a real character on a live server, or the local test server', () => {
    expect(serverInstructions('chrome')).toMatch(/human's own character on a live server.*Call ac_start with no arguments/);
    expect(serverInstructions(undefined)).toMatch(/^Play Asheron's Call in this repo's browser client/);
  });
});

describe('a daemon\'s ports', () => {
  it('a port another session\'s Vite holds on ::1 only (localhost on macOS) is not free', async () => {
    const { createServer } = await import('node:net');
    const srv = createServer();
    const port = await new Promise<number>((res, rej) => { srv.once('error', rej); srv.listen(0, '::1', () => res((srv.address() as { port: number }).port)); }).catch(() => 0);
    if (!port) return; // no IPv6 loopback on this machine
    try {
      expect(await portFree(port)).toBe(false);
    } finally {
      await new Promise((r) => srv.close(r));
    }
    expect(await portFree(port)).toBe(true);
  });
});

describe('every action tool reaches an in-page method', async () => {
  const { AgentApi } = await import('../packages/renderer/src/agent/AgentApi.ts');
  const { FakeHost } = await import('./_harness/agentFake.ts');
  it('ac_<name> calls the surface method <camelName> (act() in tools.ts), or is one of the composite tools', () => {
    const surface = new AgentApi(new FakeHost()).surface() as Record<string, unknown>;
    // Tools that run their own sequence of calls, or no page call at all.
    const composite = new Set(['ac_start', 'ac_stop', 'ac_sessions', 'ac_observe', 'ac_screenshot', 'ac_look', 'ac_character', 'ac_journal', 'ac_note', 'ac_allegiance', 'ac_routines', 'ac_routine', 'ac_keys', 'ac_click', 'ac_wait', 'ac_trace', 'ac_inventory', 'ac_gear', 'ac_spells', 'ac_vendor', 'ac_appraise']);
    const missing = TOOLS.filter((t) => !composite.has(t.name))
      .map((t) => t.name.replace(/^ac_/, '').replace(/_([a-z])/g, (_, x: string) => x.toUpperCase()))
      .filter((m) => typeof surface[m] !== 'function');
    expect(missing).toEqual([]);
  });
});

describe('the game snapshot\'s shared dirs', () => {
  it('links node_modules from the main checkout when started from a fresh worktree', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'acjs-snapshot-')));
    try {
      const main = join(root, 'main');
      mkdirSync(main);
      const git = (...a: string[]): string => execFileSync('git', a, { cwd: main, encoding: 'utf8' });
      git('init', '-q');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
      mkdirSync(join(main, 'node_modules'));
      const wt = join(root, 'wt');
      git('worktree', 'add', '-q', '--detach', wt);
      expect(sharedDirFor(wt, 'node_modules')).toBe(join(main, 'node_modules'));
      expect(sharedDirFor(wt, 'dat')).toBeNull();
      mkdirSync(join(wt, 'node_modules'));
      expect(sharedDirFor(wt, 'node_modules')).toBe(join(wt, 'node_modules'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
