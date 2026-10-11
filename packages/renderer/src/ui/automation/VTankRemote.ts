/**
 * The VirindiTank window's two small windows (docs/vtank-parity-gaps.md §9.5,
 * §9.6), drawn with the window's own VVS parts (VTankKit): no new art.
 *
 * - **The remote** is Virindi HUDs' "VTank Remote Control" (the wiki's
 *   BeginnerBundleGuide: "Select who you want to follow and Press the FC
 *   button on the MiniRemote"; "C" toggles following around corners; the
 *   changelog's "Corner follow toggle for miniremote"). Its controls and
 *   places follow MOSS's facts for it (mosstank-remote.xml, a 154 x 174
 *   panel): On and Meta, Buff and Combat, Navigate and Loot, Follow corners,
 *   Target lock, then F (Force Buff), CF (Cancel Force Buff) and FC (follow
 *   the selected player), and M back to the main window. Each switch is the
 *   same option the Options tab sets (Run Macro, EnableMeta, EnableBuffing,
 *   EnableCombat, EnableNav, EnableLooting, FollowAroundCorners, TargetLock).
 * - **The Action History** follows MOSS's (mosstank-action-history.xml): the
 *   current status, the session's history (newest at the bottom; scrolled up,
 *   it holds still; at the bottom it follows), and Clear.
 */
import type { VtActivity } from './vtActivity.js';
import type { VTankKit, VTankWindow } from './VTankWindow.js';

/** The remote's frame (MOSS's panel 154 x 174, the frame's 35 px of title and edges added). */
export const VT_REMOTE_SIZE = { w: 154, h: 178 } as const;
/** The Action History's frame (MOSS's 620 x 350, narrowed to fit an 800-wide HUD beside the main window). */
export const VT_HISTORY_SIZE = { w: 560, h: 330 } as const;

const at = (e: HTMLElement, x: number, y: number): HTMLElement => { Object.assign(e.style, { position: 'absolute', left: `${x}px`, top: `${y}px` }); return e; };
const tag = (e: HTMLElement, data: Record<string, string>): HTMLElement => { for (const [k, v] of Object.entries(data)) e.dataset[k] = v; return e; };

/** The remote's switches: label, the option it sets, where (MOSS's places, less its 22 px title). */
export const VT_REMOTE_SWITCHES: Array<{ label: string; option: string; x: number; y: number }> = [
  { label: 'On', option: '', x: 6, y: 2 }, { label: 'Meta', option: 'EnableMeta', x: 76, y: 2 },
  { label: 'Buff', option: 'EnableBuffing', x: 6, y: 22 }, { label: 'Combat', option: 'EnableCombat', x: 70, y: 22 },
  { label: 'Navigate', option: 'EnableNav', x: 6, y: 42 }, { label: 'Loot', option: 'EnableLooting', x: 92, y: 42 },
  { label: 'Follow corners', option: 'FollowAroundCorners', x: 6, y: 62 },
  { label: 'Target lock', option: 'TargetLock', x: 6, y: 82 },
];

export function renderVTankRemote(body: HTMLElement, kit: VTankKit, win: VTankWindow, redraw: () => void, showMain: () => void): void {
  body.innerHTML = '';
  const root = tag(document.createElement('div'), { vtank: 'remote' });
  Object.assign(root.style, { position: 'absolute', left: '0', top: '0', right: '0', bottom: '0' });
  body.appendChild(root);
  const after = () => redraw();
  for (const s of VT_REMOTE_SWITCHES) {
    const on = s.option ? win.isOn(s.option) : win.macroOn;
    const r = document.createElement('div');
    Object.assign(r.style, { display: 'flex', alignItems: 'center', gap: '5px' });
    r.appendChild(kit.check(on, (v) => { if (s.option) win.setValue(s.option, v, after); else win.runMacro(v, after); }));
    r.appendChild(kit.text(s.label, { color: kit.colors.text }));
    root.appendChild(at(tag(r, { vtankRemoteSwitch: s.option || 'RunMacro', on: on ? '1' : '0' }), s.x, s.y));
  }
  const say = (r: { ok: boolean; message: string }) => { win.message = r.ok ? '' : r.message; redraw(); };
  root.appendChild(at(tag(kit.flatButton('F', () => say(win.source.status().running ? win.source.forceBuff() : { ok: false, message: 'Turn the macro on to buff.' }), 44, 24), { vtank: 'remote-force-buff' }), 6, 108));
  root.appendChild(at(tag(kit.flatButton('CF', () => say(win.source.cancelForceBuff()), 44, 24), { vtank: 'remote-cancel-force-buff' }), 55, 108));
  root.appendChild(at(tag(kit.flatButton('FC', () => win.followSelected(after), 44, 24), { vtank: 'remote-follow' }), 104, 108));
  root.appendChild(at(tag(kit.flatButton('M', showMain, 22, 18), { vtank: 'remote-main' }), 120, 82));
  if (win.message) root.appendChild(at(tag(kit.text(win.message, { color: kit.colors.warn, maxWidth: 136 }), { vtank: 'remote-message' }), 2, 134));
}

/** Where the history list was scrolled (null: at the bottom, following), per history. */
const held = new WeakMap<VtActivity, number | null>();

export function renderVTankHistory(body: HTMLElement, kit: VTankKit, activity: VtActivity, current: string, redraw: () => void): void {
  const W = VT_HISTORY_SIZE.w - 12, H = VT_HISTORY_SIZE.h - 35;
  const prev = body.querySelector<HTMLElement>('[data-vtank="history-list"]');
  if (prev) held.set(activity, prev.scrollTop + prev.clientHeight >= prev.scrollHeight - 2 ? null : prev.scrollTop);
  body.innerHTML = '';
  const c = kit.colors;
  body.appendChild(at(kit.text('Current:', { color: c.dim }), 6, 4));
  body.appendChild(at(tag(kit.text(current, { color: c.text, maxWidth: W - 80 }), { vtank: 'history-current' }), 66, 4));
  const box = tag(document.createElement('div'), { vtank: 'history-list' });
  Object.assign(box.style, { position: 'absolute', left: '6px', top: '24px', width: `${W - 12}px`, height: `${H - 54}px` });
  const list = document.createElement('div');
  Object.assign(list.style, { display: 'flex', flexDirection: 'column', paddingRight: '18px' });
  for (const line of activity.lines) {
    const r = document.createElement('div');
    Object.assign(r.style, { height: '16px', overflow: 'hidden', whiteSpace: 'nowrap' });
    r.appendChild(kit.text(line, { color: c.text }));
    list.appendChild(r);
  }
  box.appendChild(list);
  body.appendChild(box);
  kit.list(box);
  const keep = held.get(activity);
  box.scrollTop = keep === null || keep === undefined ? box.scrollHeight : keep;
  body.appendChild(at(kit.text('Scroll up to pause. Bottom resumes.', { color: c.dim }), 6, H - 22));
  body.appendChild(at(tag(kit.flatButton('Clear', () => { activity.clear(); held.set(activity, null); redraw(); }, 72, 22), { vtank: 'history-clear' }), W - 84, H - 26));
}
