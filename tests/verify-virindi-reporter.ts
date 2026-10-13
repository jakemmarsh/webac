/**
 * Virindi Reporter (@ac/shared virindiReporter.ts) and Virindi HUDs' Status HUD (ui/automation/StatusHud.ts),
 * rebuilt from their behaviour (reference/plugin-specs/reporter-statushud.md), and GameUI's hosting of them:
 * the VVS bar's entries, the HUD, its Ctrl+click config, and the bar's preview gate (2026-10-12).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { ReporterXp, reporterDuration, reporterN0, reporterXpForLevel, type ReporterReads } from '../packages/shared/src/routines/virindiReporter.js';
import { StatusHudModel, renderStatusHud, renderReporterWindow, STATUS_HUD } from '../packages/renderer/src/ui/automation/StatusHud.js';
import { renderVvsBar } from '../packages/renderer/src/ui/automation/VvsBar.js';
import type { VTankKit } from '../packages/renderer/src/ui/automation/VTankWindow.js';

class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } }

function rig(start = { xp: 1_000_000, lum: 0, level: 50 }) {
  const s = { ...start, now: 1_000_000 };
  const reads: ReporterReads = { xp: () => s.xp, lum: () => s.lum, level: () => s.level, levelXp: (l) => (l <= 275 ? 2_000_000 + l : null), now: () => s.now };
  return { s, r: new ReporterXp(reads) };
}

describe('Virindi Reporter\'s numbers', () => {
  it('formats as Reporter: N0, HH:MM:SS, "{days} days," from a day up', () => {
    expect(reporterN0(1234567.5)).toBe('1,234,568');
    expect(reporterN0(-1234)).toBe('-1,234');
    expect(reporterDuration(3723000)).toBe('01:02:03');
    expect(reporterDuration(86_400_000 + 5000)).toBe('1 days, 00:00:05');
    expect(reporterXpForLevel(275)).toBe(Math.ceil((280 ** 5 - 6 ** 5) / 9));
  });

  it('is all zero before a reset; per-hour rates over the run; the five-minute rate once six samples exist', () => {
    const { s, r } = rig();
    expect(r.rate().xp).toBe(0);
    r.reset();
    s.now += 60_000; s.xp += 1000; r.tick();
    expect(r.rate().fiveValid).toBe(false);
    for (let m = 2; m <= 5; m++) { s.now += 60_000; s.xp += 1000; r.tick(); }
    const rate = r.rate();
    expect(rate.fiveValid).toBe(true);
    expect(rate.xp).toBe(5000);
    expect(Math.round(rate.xpPerHour)).toBe(60_000);
    expect(rate.xp5PerHour).toBe(12 * 5000);
    expect(rate.needed).toBe(2_000_051 - s.xp);
  });

  it('the report line, with the luminance part only when luminance was earned', () => {
    const { s, r } = rig();
    r.reset();
    s.now += 3_600_000; s.xp += 12_000; r.tick();
    expect(r.report()).toMatch(/^You've made 12,000 XP in 01:00:00 for 12,000 XP\/hour \(5min \d[\d,]* XP\/hour\)\. [\d,]+ XP to reach level 51, ETA 3 days, \d\d:\d\d:\d\d\.$/);
    s.lum += 500;
    expect(r.report()).toMatch(/ Lum 500 LP for 500 LP\/h, 5min [\d,-]+ LP\/h\.$/);
    s.lum -= 1000; // spent: negative, so no luminance part
    expect(r.report()).not.toMatch(/Lum/);
  });

  it('the Status HUD entries under VReporter, "---" and INFINITY until there is a rate', () => {
    const { r } = rig();
    r.reset();
    const hud = Object.fromEntries(r.hudEntries());
    expect(Object.keys(hud)).toEqual(['XP Earned', 'Luminance Earned', 'XP/Hour', 'Lum/Hour', 'XP/Hour (5min)', 'Lum/Hour (5min)', 'Runtime since XP reset', 'Level ETA']);
    expect(hud['XP/Hour (5min)']).toBe('---');
    expect(hud['Level ETA']).toBe('INFINITY');
    expect(hud['XP/Hour']).toBe('0 xp/h');
  });

  it('past the XpTable\'s end, Reporter\'s own formula; an era without luminance reads 0', () => {
    const { s, r } = rig({ xp: 5, lum: 0, level: 275 });
    r.reset();
    expect(r.rate().needed).toBe(reporterXpForLevel(276) - 5);
    s.now += 60_000;
    expect(Object.fromEntries(r.hudEntries())['Luminance Earned']).toBe('0');
  });
});

describe('the Status HUD model', () => {
  it('entries by plugin and name; the chosen ones, in the order chosen, kept per character', () => {
    const mem = new Mem();
    let who = 'Coldeve.Alice';
    const m = new StatusHudModel(() => mem, () => who);
    m.update('VReporter', 'XP/Hour', '10 xp/h');
    m.update('VTank', 'Kills', '3', 0xff0000);
    expect(m.known()).toEqual(['VReporter - XP/Hour', 'VTank - Kills']);
    m.toggle('VTank - Kills');
    m.toggle('VReporter - XP/Hour');
    m.toggle('VReporter - Missing');
    expect(m.rows().map((r) => r.entry)).toEqual(['Kills', 'XP/Hour']);
    expect(m.rows()[0]!.color).toBe(0xff0000);
    who = 'Coldeve.Bob';
    expect(m.rows()).toEqual([]);
    who = 'Coldeve.Alice';
    expect(m.chosen()).toEqual(['VTank - Kills', 'VReporter - XP/Hour', 'VReporter - Missing']);
  });

  it('draws rows 17 px apart with the colons in one column, and sizes the window to them', () => {
    const m = new StatusHudModel(() => new Mem(), () => 'x');
    m.update('VReporter', 'XP Earned', '1,000'); m.update('VReporter', 'Luminance Earned', '0');
    m.toggle('VReporter - XP Earned'); m.toggle('VReporter - Luminance Earned');
    const body = document.createElement('div');
    const size = renderStatusHud(body, m);
    const rows = Array.from(body.querySelectorAll<HTMLElement>('[data-status-row]'));
    expect(rows.map((r) => r.style.top)).toEqual(['0px', `${STATUS_HUD.row}px`]);
    const colon = (r: HTMLElement) => (r.children[1] as HTMLElement).style.left;
    expect(colon(rows[0]!)).toBe(colon(rows[1]!));
    expect(size.h).toBe(35 + 2 * STATUS_HUD.row);
  });

  it('Reporter\'s window: its four buttons at mainView.xml\'s places', () => {
    const body = document.createElement('div');
    const done: string[] = [];
    const kit = { flatButton: (t: string, fn: () => void) => { const d = document.createElement('div'); d.textContent = t; d.addEventListener('click', fn); return d; } } as unknown as VTankKit;
    renderReporterWindow(body, kit, { reset: () => done.push('reset'), report: () => done.push('report'), reportA: () => done.push('a'), reportF: () => done.push('f') });
    const b = (n: string) => body.querySelector(`[data-reporter="${n}"]`) as HTMLElement;
    expect([b('cmdReset').style.top, b('cmdReport').style.top, b('cmdReportA').style.top, b('cmdReportF').style.top]).toEqual(['20px', '58px', '88px', '118px']);
    b('cmdReportF').click();
    expect(done).toEqual(['f']);
  });
});

describe('the bar\'s icons on streamed DATs', () => {
  it('an icon whose image hasn\'t arrived stays empty (pending), not the no-icon box', () => {
    const host = document.createElement('div');
    renderVvsBar(host, [{ id: 'r', plugin: 'P', title: 'R', icon: { dat: 0x0600227d }, open: false, toggle: () => {} }], () => null);
    const slot = host.querySelector('[data-vvs-bar-entry="r"]') as HTMLElement;
    expect(slot.dataset.iconPending).toBe('1');
    expect(slot.children.length).toBe(0);
  });
});

type Ui = {
  setAutomationSource(s: unknown): void;
  setReporterReads(r: ReporterReads | null): void;
  setPreviewFeatures(on: boolean): void;
  toggleAutomationWindow(): void;
  toggleStatusHud(): void;
  refreshVvsBar(): void;
  hudContainer: HTMLElement;
  statusHud: StatusHudModel;
};

let H: GameUIFixture;
beforeAll(async () => { H = await mountGameUI(); });
afterAll(() => H.teardown());

describe('GameUI: Reporter and the Status HUD', () => {
  it('Ctrl+click on the HUD\'s eye opens its config; a plain click doesn\'t', () => {
    const ui = H.ui as unknown as Ui;
    ui.setReporterReads({ xp: () => 1000, lum: () => 0, level: () => 5, levelXp: () => 2000, now: () => Date.now() });
    ui.toggleStatusHud();
    const eye = ui.hudContainer.querySelector('[data-status-hud-eye]') as HTMLElement;
    expect(eye).not.toBeNull();
    eye.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ui.hudContainer.querySelector('[data-vtank-aux="status-hud-config"]')).toBeNull();
    // Taken on the press: on a Mac a Ctrl+click is a right-click, and no click event follows it.
    eye.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true, button: 0 }));
    expect(ui.hudContainer.querySelector('[data-vtank-aux="status-hud-config"]')).not.toBeNull();
    ui.toggleStatusHud();
    ui.setReporterReads(null);
  });

  it('the bar is preview UI: hidden without the bridge\'s preview flag, with Reporter and Virindi HUDs entries when shown', async () => {
    const ui = H.ui as unknown as Ui;
    const { emptyRoutineDoc } = await import('../packages/shared/src/routines/index.js');
    const base: Record<string, unknown> = {
      load: async () => ({ ok: true, doc: emptyRoutineDoc('local-eor', 'tester') }),
      status: () => ({ running: false, paused: false, profile: null, state: null, acting: null, last: [] }),
      stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
      current: () => null, character: () => 'T', coords: () => null, now: () => 0, items: () => [], spells: () => [], buffs: () => [], history: () => [], setting: () => undefined, report: () => {}, spellTable: () => null, selection: () => null,
    };
    ui.setAutomationSource(new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => ({ ok: true, message: '' })) }));
    ui.setReporterReads({ xp: () => 1000, lum: () => 0, level: () => 5, levelXp: () => 2000, now: () => Date.now() });
    ui.setPreviewFeatures(false);
    ui.toggleAutomationWindow();
    await new Promise((r) => setTimeout(r, 5));
    expect(ui.hudContainer.querySelector('[data-vvs-bar]')).toBeNull();
    ui.setPreviewFeatures(true);
    const ids = Array.from(ui.hudContainer.querySelectorAll<HTMLElement>('[data-vvs-bar-entry]')).map((e) => e.dataset.vvsBarEntry);
    expect(ids).toEqual(expect.arrayContaining(['vtank', 'vhs', 'reporter', 'vhuds']));
    // VTank, the Hotkey System and Virindi UIs show our own stand-in icons, each a different image, never the coral box.
    const bg = ['vtank', 'vhs', 'vhuds'].map((id) => ui.hudContainer.querySelector<HTMLElement>(`[data-vvs-bar-entry="${id}"]`)!.style.backgroundImage);
    expect(bg.every((b) => b.startsWith('url(') && b.includes('data:image/png'))).toBe(true);
    expect(new Set(bg).size).toBe(3);
    ui.toggleAutomationWindow();
    ui.setPreviewFeatures(false);
    ui.setAutomationSource(null);
    ui.setReporterReads(null);
  });
});
