/**
 * Stream overlay page: subscribes to the overlay server's SSE feed (/events), folds events through
 * model.ts and draws the cards, chat, narration and callouts. Served transpiled by overlay-server.ts.
 */
import {
  applyEvent, cardLayoutCssVars, chatOpacity, createState, DEFAULT_ROSTER, formatClock, formatXp, pruneCallouts, vitalFraction, xpFraction,
  type CharView, type ChatView, type OverlayState, type RosterEntry,
} from './model.ts';
import type { FeedEvent, FeedVital } from '../feed-types.ts';

// Card geometry is defined once in model.ts (CARD_LAYOUT); the stylesheet reads it from these variables.
for (const [k, v] of Object.entries(cardLayoutCssVars())) document.documentElement.style.setProperty(k, v);

const params = new URLSearchParams(location.search);
if (params.has('layout')) document.body.classList.add('layout');

/** Roster in slot order: ?left=<profile>&right=<profile>, else the default pair. */
function rosterFromQuery(): RosterEntry[] {
  const base = [...DEFAULT_ROSTER];
  const pick = (id: string | null, fallback: RosterEntry): RosterEntry =>
    (id && (base.find((r) => r.id === id) ?? { id, name: id, title: '' })) || fallback;
  const left = pick(params.get('left'), base[0]);
  const right = pick(params.get('right'), base.find((r) => r.id !== left.id) ?? base[1]);
  return [left, right];
}

const roster = rosterFromQuery();
let state: OverlayState = createState(roster);

function slotOf(id: string | null): string {
  if (!id) return 'other';
  const i = roster.findIndex((r) => r.id === id);
  return i === 0 ? 's0' : i === 1 ? 's1' : 'other';
}

function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`overlay: missing ${sel}`);
  return el as HTMLElement;
}

// ---------- cards ----------
interface CardEls {
  root: HTMLElement; name: HTMLElement; title: HTMLElement; level: HTMLElement; deaths: HTMLElement; deathsN: HTMLElement;
  vitals: Record<'health' | 'stamina' | 'mana', { box: HTMLElement; fill: HTMLElement; n: HTMLElement }>;
  xp: HTMLElement; xpFill: HTMLElement; xpNext: HTMLElement; xpSession: HTMLElement;
  location: HTMLElement; goal: HTMLElement; goalLine: HTMLElement; tool: HTMLElement; toolLine: HTMLElement;
}

const template = $('#card-template') as HTMLTemplateElement;
const cards: CardEls[] = roster.map((r, slot) => {
  const root = $(`.card[data-slot="${slot}"]`);
  root.appendChild(template.content.cloneNode(true));
  const vital = (k: string) => {
    const box = $(`.vital.${k}`, root);
    return { box, fill: $('.vital-fill', box), n: $('.vital-n', box) };
  };
  const label = $(`.game-region[data-slot="${slot}"] .region-label`);
  const css = getComputedStyle(document.documentElement);
  label.textContent = `${r.name} game capture: x=${css.getPropertyValue(`--region${slot}-x`).trim()} y=${css.getPropertyValue('--region-y').trim()} `
    + `${css.getPropertyValue('--region-w').trim()} x ${css.getPropertyValue('--region-h').trim()}`;
  return {
    root, name: $('.name', root), title: $('.title', root), level: $('.level-n', root), deaths: $('.deaths', root), deathsN: $('.deaths-n', root),
    vitals: { health: vital('health'), stamina: vital('stamina'), mana: vital('mana') },
    xp: $('.xp', root), xpFill: $('.xp-fill', root), xpNext: $('.xp-next', root), xpSession: $('.xp-session', root),
    location: $('.location .text', root), goal: $('.goal .text', root), goalLine: $('.goal', root),
    tool: $('.tool .text', root), toolLine: $('.tool', root),
  };
});

function setText(el: HTMLElement, text: string): void { if (el.textContent !== text) el.textContent = text; }

function drawVital(v: { box: HTMLElement; fill: HTMLElement; n: HTMLElement }, val: FeedVital | null): void {
  const f = vitalFraction(val);
  v.fill.style.width = `${(f * 100).toFixed(1)}%`;
  setText(v.n, val ? `${Math.round(val.cur)} / ${Math.round(val.max)}` : '');
  v.box.classList.toggle('low', !!val && val.max > 0 && f < 0.3);
}

function drawCard(els: CardEls, c: CharView): void {
  setText(els.name, c.name);
  setText(els.title, c.title);
  setText(els.level, c.level === null ? '–' : String(c.level));
  setText(els.deathsN, String(c.deaths));
  els.deaths.classList.toggle('some', c.deaths > 0);
  els.root.classList.toggle('dead', c.dead);
  drawVital(els.vitals.health, c.health);
  drawVital(els.vitals.stamina, c.stamina);
  drawVital(els.vitals.mana, c.mana);
  const xf = xpFraction(c);
  els.xp.classList.toggle('unknown', xf === null);
  els.xpFill.style.width = `${((xf ?? 0) * 100).toFixed(1)}%`;
  setText(els.xpNext, c.xpToNext === null ? '' : c.xpToNext <= 0 ? 'Max level' : `${formatXp(c.xpToNext)} XP to level ${(c.level ?? 0) + 1}`);
  setText(els.xpSession, `+${formatXp(c.xpSession)} XP this session`);
  setText(els.location, c.location || 'Location unknown');
  setText(els.goal, c.goal ?? '');
  els.goalLine.style.visibility = c.goal ? 'visible' : 'hidden';
  setText(els.tool, c.lastTool ? `${c.lastTool.tool} · ${c.lastTool.summary}` : '');
  els.toolLine.classList.toggle('failed', !!c.lastTool && !c.lastTool.ok);
}

// ---------- callouts ----------
const shownCallouts = new Map<number, HTMLElement>();
function drawCallouts(now: number): void {
  const live = new Set(state.callouts.map((c) => c.id));
  for (const [id, el] of shownCallouts) if (!live.has(id)) { el.remove(); shownCallouts.delete(id); }
  for (const c of state.callouts) {
    if (shownCallouts.has(c.id)) continue;
    const slot = roster.findIndex((r) => r.id === c.char);
    const host = $(`.game-region[data-slot="${slot < 0 ? 0 : slot}"] .callouts`);
    // Only the newest callout per region.
    for (const el of host.querySelectorAll('.callout')) el.remove();
    const el = document.createElement('div');
    el.className = `callout ${c.kind}`;
    el.style.animationDelay = `${-Math.max(0, now - c.t)}ms`;
    const big = document.createElement('div'); big.className = 'callout-text'; big.textContent = c.text;
    const sub = document.createElement('div'); sub.className = 'callout-sub'; sub.textContent = c.sub;
    el.append(big, sub);
    host.appendChild(el);
    shownCallouts.set(c.id, el);
  }
}

// ---------- chat ----------
const chatList = $('#chat-lines');
const CHAT_TAGS: Partial<Record<ChatView['channel'], string>> = {
  fellowship: 'Fel', 'tell-out': 'Tell', 'tell-in': 'Tell', say: 'Say', emote: '', general: 'Gen', trade: 'Trade', lfg: 'LFG',
  roleplay: 'RP', society: 'Soc', allegiance: 'Alg', system: '', other: '',
};
function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span'); s.className = cls; s.textContent = text; return s;
}
function drawChat(now: number): void {
  const lines = state.chat.slice(-7);
  chatList.replaceChildren(...lines.map((l, i) => {
    const li = document.createElement('li');
    const tell = l.channel === 'tell-out' || l.channel === 'tell-in';
    li.className = `${l.channel}${tell ? ' tell' : ''}${l.speaker ? '' : ' system'}`;
    const tag = CHAT_TAGS[l.channel] ?? '';
    li.append(span(`tag ${tell ? 'tell' : l.channel}`, tag));
    if (l.speaker) {
      li.append(span(`spk ${slotOf(l.speakerId)}`, l.speaker));
      if (tell && l.to) {
        li.append(span('arrow', '→'), span(`spk ${slotOf(idFor(l.to))}`, l.to));
      }
      li.append(span('arrow', ':'), span('body', l.body));
    } else {
      li.append(span('body', l.body));
    }
    li.style.opacity = String(chatOpacity(i, lines.length, now - l.t));
    return li;
  }));
}
function idFor(name: string): string | null {
  const n = name.toLowerCase();
  return Object.values(state.chars).find((c) => c.name.toLowerCase() === n)?.id ?? null;
}

// ---------- narration ----------
const narrationList = $('#narration-lines');
function drawNarration(): void {
  const lines = state.narration.slice(-4);
  narrationList.replaceChildren(...lines.map((n, i) => {
    const li = document.createElement('li');
    if (i === lines.length - 1) li.className = 'newest';
    const c = state.chars[n.char];
    li.append(span(`chip ${slotOf(n.char)}`, (c?.name ?? n.name).replace(/^Claude\s+/, '')), span('text', n.text));
    return li;
  }));
}

// ---------- top bar ----------
const clockEl = $('#session-clock');
const segTitle = $('#segment .segment-title');
const segTime = $('#segment .segment-time');
const feedDot = $('#feed-dot');

function render(): void {
  const now = Date.now();
  pruneCallouts(state, now);
  roster.forEach((r, slot) => { const c = state.chars[r.id]; if (c) drawCard(cards[slot], c); });
  setText(clockEl, state.sessionStart === null ? '0:00' : formatClock(now - state.sessionStart));
  setText(segTitle, state.segment?.title ?? state.sessionTitle ?? '');
  setText(segTime, state.segment ? formatClock(now - state.segment.t) : '');
  drawCallouts(now);
  drawChat(now);
  drawNarration();
}

let pending = false;
function scheduleRender(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

// ---------- feed ----------
function connect(): void {
  const es = new EventSource('events');
  es.addEventListener('open', () => feedDot.classList.remove('off'));
  es.addEventListener('error', () => feedDot.classList.add('off'));
  es.addEventListener('reset', () => { state = createState(roster); scheduleRender(); });
  es.addEventListener('feed', (e) => {
    try {
      const ev = JSON.parse((e as MessageEvent<string>).data) as FeedEvent;
      applyEvent(state, ev, Date.now());
    } catch { /* malformed frame: skip */ }
    scheduleRender();
  });
}

connect();
render();
setInterval(render, 500);
