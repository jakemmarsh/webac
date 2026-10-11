/**
 * AGENT.vtank-window — VirindiTank's meta views (routines/metaView.ts): the
 * wiki's own sample XML parses; Create View / Destroy View import from a
 * .met and run; a button runs its actionexpr and sets its state; GameUI
 * draws the view in VVS's frame with its buttons where the XML puts them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMetaView, metToProfile, type MetaView } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { ALL_MODULES_OFF } from '../packages/shared/src/routines/index.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

// Verbatim from virindi.net/wiki/index.php/Meta_Views.
const WIKI = '<?xml version="1.0"?><view width="300" height="200" title="Test View"><control type="layout"><control type="button" name="btnTest1" left="20" top="10" width="50" height="20" text="Button1" actionexpr="chatbox[\\/vt echo Button1\\!]" setstate="teststate1" /><control type="button" name="btnTest2" left="20" top="40" width="50" height="20" text="Button2" actionexpr="chatbox[\\/vt echo Hi there\\!]" setstate="teststate2"/></control></view>';

describe('meta views', () => {
  it('the wiki\'s sample view: title, size, two buttons with their places, expressions and states', () => {
    expect(parseMetaView(WIKI)).toEqual({
      title: 'Test View', width: 300, height: 200, buttons: [
        { name: 'btnTest1', left: 20, top: 10, width: 50, height: 20, text: 'Button1', actionexpr: 'chatbox[\\/vt echo Button1\\!]', setstate: 'teststate1' },
        { name: 'btnTest2', left: 20, top: 40, width: 50, height: 20, text: 'Button2', actionexpr: 'chatbox[\\/vt echo Hi there\\!]', setstate: 'teststate2' },
      ],
    });
    expect(parseMetaView('<nothing/>')).toBeNull();
  });

  it('Create View / Destroy View / Destroy All Views import from a .met as ours', () => {
    const kv = (pairs: Array<[string, { t: 's' | 'ba'; v: string }]>) => ({ t: 'table' as const, cols: ['k', 'v'], rows: pairs.map(([k, v]) => [{ t: 's' as const, v: k }, v]) });
    const rule = (act: number, actData: unknown) => ({ cond: 1, condData: { t: 'i', v: 0 }, act, actData, state: 'Default' }) as never;
    const { value: p, problems } = metToProfile('X', [rule(13, kv([['n', { t: 's', v: 'panel' }], ['x', { t: 'ba', v: WIKI }]])), rule(14, kv([['n', { t: 's', v: 'panel' }]])), rule(15, kv([]))]);
    expect(p.states[0].rules.map((r) => r.do[0])).toEqual([{ kind: 'create-view', name: 'panel', xml: WIKI }, { kind: 'destroy-view', name: 'panel' }, { kind: 'destroy-all-views' }]);
    expect(problems).toEqual([]);
  });

  describe('in the engine', () => {
    let host: FakeHost;
    let api: AgentApi;
    beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
    afterEach(() => { api.routine.stop(); vi.useRealTimers(); });
    const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };

    it('a rule opens the view; a button runs its expression and goes to its state; stopping closes it', async () => {
      const opened: Array<{ name: string; view: MetaView; click: (b: MetaView['buttons'][number]) => void }> = [];
      let closed = 0;
      api.routine.views = { open: (name, view, click) => opened.push({ name, view, click }), close: () => { closed++; }, closeAll: () => { closed++; } };
      api.routine.start({
        name: 'V', modules: { ...ALL_MODULES_OFF }, initialState: 'Default', loot: [], buffSets: [], routes: [], ruleFiring: 'once',
        states: [{ name: 'Default', rules: [{ when: [{ kind: 'always' }], do: [{ kind: 'create-view', name: 'panel', xml: WIKI }] }] }, { name: 'teststate1', rules: [] }],
      });
      await step(1000);
      expect(opened.map((o) => [o.name, o.view.title])).toEqual([['panel', 'Test View']]);
      const vt: string[] = [];
      api.routine.onVtCommand = (l) => vt.push(l);
      opened[0].click(opened[0].view.buttons[0]);
      expect(api.routine.status().state).toBe('teststate1');
      // Its chatbox[/vt …] is VirindiTank's own command: the /vt handler, not the server.
      expect(vt).toEqual(['/vt echo Button1!']);
      expect(host.chats).not.toContain('/vt echo Button1!');
      api.routine.stop();
      expect(closed).toBe(1);
    });

    it('a button\'s actionexpr relabels a button: uigetcontrol / uisetlabel reach the open view through the engine', async () => {
      const labels: string[] = [];
      const open = new Set<string>();
      let click: ((b: MetaView['buttons'][number]) => void) | null = null;
      let view: MetaView | null = null;
      api.routine.views = {
        open: (name, v, c) => { open.add(name); view = v; click = c; }, close: (n) => { open.delete(n); }, closeAll: () => open.clear(),
        hasControl: (n, c) => open.has(n) && !!view?.buttons.some((b) => b.name === c),
        setLabel: (n, c, t) => { labels.push(`${n}.${c}=${t}`); return true; },
      };
      const xml = WIKI.replace('actionexpr="chatbox[\\/vt echo Button1\\!]"', 'actionexpr="uisetlabel[uigetcontrol[panel,btnTest1],Running]"');
      api.routine.start({
        name: 'V', modules: { ...ALL_MODULES_OFF }, initialState: 'Default', loot: [], buffSets: [], routes: [], ruleFiring: 'once',
        states: [{ name: 'Default', rules: [{ when: [{ kind: 'always' }], do: [{ kind: 'create-view', name: 'panel', xml }] }] }, { name: 'teststate1', rules: [] }],
      });
      await step(1000);
      expect(view!.buttons[0].actionexpr).toBe('uisetlabel[uigetcontrol[panel,btnTest1],Running]');
      click!(view!.buttons[0]);
      expect(labels).toEqual(['panel.btnTest1=Running']);
      expect(api.routine.expressions!.run('uigetcontrol[panel,nope]')).toBe('');
    });
  });
});

describe('GameUI draws a meta view', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());
  it('in VVS\'s frame, buttons at the XML\'s places; a click is the button; closing removes it', () => {
    const ui = H.ui as unknown as { openMetaView(n: string, v: MetaView, c: (b: MetaView['buttons'][number]) => void): void; closeMetaView(n: string): void };
    const clicks: string[] = [];
    ui.openMetaView('panel', parseMetaView(WIKI)!, (b) => clicks.push(b.name));
    const win = H.container.querySelector('[data-meta-view="panel"]') as HTMLElement;
    expect(win.textContent).toContain('Test View');
    const b2 = win.querySelector('[data-meta-view-button="btnTest2"]') as HTMLElement;
    expect([b2.style.left, b2.style.top, b2.style.width]).toEqual(['20px', '40px', '50px']);
    b2.click();
    expect(clicks).toEqual(['btnTest2']);
    // Opening the same view again keeps it (a rule firing every step must not flicker it); a changed one replaces it.
    ui.openMetaView('panel', parseMetaView(WIKI)!, () => {});
    expect(H.container.querySelector('[data-meta-view="panel"]')).toBe(win);
    ui.openMetaView('panel', { ...parseMetaView(WIKI)!, title: 'Other' }, () => {});
    expect(H.container.querySelector('[data-meta-view="panel"]')).not.toBe(win);
    expect(H.container.querySelectorAll('[data-meta-view="panel"]')).toHaveLength(1);
    // uigetcontrol / uisetlabel: a named button of an open view, relabelled in place.
    const ui2 = H.ui as unknown as { metaViewHasControl(v: string, c: string): boolean; setMetaViewLabel(v: string, c: string, t: string): boolean };
    expect(ui2.metaViewHasControl('panel', 'btnTest1')).toBe(true);
    expect(ui2.metaViewHasControl('panel', 'nope')).toBe(false);
    expect(ui2.metaViewHasControl('gone', 'btnTest1')).toBe(false);
    const b1 = H.container.querySelector('[data-meta-view="panel"] [data-meta-view-button="btnTest1"]') as HTMLElement;
    expect(ui2.setMetaViewLabel('panel', 'btnTest1', 'Stop')).toBe(true);
    expect(b1.textContent).toBe('Stop');
    expect(b1.isConnected).toBe(true);
    expect(ui2.setMetaViewLabel('panel', 'nope', 'x')).toBe(false);
    ui.closeMetaView('panel');
    expect(H.container.querySelector('[data-meta-view="panel"]')).toBeNull();
    expect(ui2.metaViewHasControl('panel', 'btnTest1')).toBe(false);
  });
});
