/**
 * AGENT.hosted-mcp-connector — "Connect Claude", the page Claude's connect
 * button opens (the bridge's /oauth/authorize redirects to
 * playwebac.com/?connect=<request>). Drawn like the launcher, from the same
 * pre-world DAT art (layout 0x21000004 backdrop, the DialogFactory plate, the
 * ENTER ellipse and the 0x100002d1 plates, the AC bitmap fonts):
 *
 *   waiting  the pairing code to type in game chat (/automation pair ABC-123),
 *            polled until the game has sent it. The command is selectable text
 *            over the bitmap font, and COPY (the CREDITS slot) copies it;
 *   paired   who Claude would play; ALLOW (the ENTER ellipse) / DENY, and the
 *            character scope (ONLY ONE / ANY ONE) on the CUSTOM… slot when a character is in the world;
 *   then     back to Claude (its OAuth callback), or "expired".
 *
 * No login happens here: the game tab the player logged in sends the code,
 * so this page never sees a password. It only talks to the configured
 * bridge, and only ever navigates to Claude's own callbacks.
 */
import { CHARSEL_LAYOUT, LAUNCHER_TEXT, coverLauncherBakedLabels, launcherPlateButton, wrapLines, type LauncherKit } from './LauncherScreen.js';
import { descRef } from '../ui/DatTextStyle.js';

const EL_WORLD_BOX = 0x1000039b;
const EL_LIST = 0x1000039c;
const EL_DELETE = 0x1000039f;
const EL_ENTER = 0x100003a2;
const EL_CREDITS = 0x100003a3;
const EL_EXIT = 0x100003a4;
const BUTTON_IDS = [0x1000039e, EL_DELETE, 0x100003a0, EL_ENTER, 0x100003a3, EL_EXIT];
const UI_STATE_DISABLED = 0xd;
const PLATE_FACES: [number, number, number] = [0x06004c9e, 0x06004c9f, 0x06004ca0];
/** The pairing plate: the left column (clear of the logo, which starts at x ~288), above the ENTER ellipse's rim (y 312). */
const PLATE = { x: 21, y: 22, w: 256, h: 284 };
const PAD = 14;

export interface ConnectStatus {
  state: 'waiting' | 'paired' | 'expired';
  code?: string;
  client?: string;
  /** server:account, as the bridge keys it. */
  account?: string;
  character?: string | null;
  /** Multiboxing: every tab that typed the code (the first is `account` / `character`). */
  accounts?: Array<{ account: string; character: string | null }>;
}

export interface ConnectApi {
  status(req: string): Promise<ConnectStatus>;
  decide(req: string, approve: boolean, only: boolean): Promise<{ redirect?: string; error?: string }>;
  navigate(url: string): void;
  sleep(ms: number): Promise<void>;
  /** Put `text` on the clipboard; false when the browser refused. */
  copy(text: string): Promise<boolean>;
}

/** The clipboard API, else a selected text area and execCommand (older or locked-down browsers). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    Object.assign(ta.style, { position: 'fixed', left: '-9999px', top: '0' });
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Where a decision may send the browser: Claude's callbacks and loopback (Claude Code), as the bridge allows. */
export function isClaudeCallback(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && (u.host === 'claude.ai' || u.host === 'claude.com') && u.pathname === '/api/mcp/auth_callback') return true;
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && !u.username && !u.password;
  } catch { return false; }
}

/** The bridge's pairing calls (oauthHttp.ts) from this page. */
export function bridgeConnectApi(origin: string, fetchImpl: typeof fetch = fetch.bind(globalThis), navigate: (url: string) => void = (u) => { window.location.href = u; }): ConnectApi {
  return {
    status: async (req) => (await fetchImpl(`${origin}/oauth/authorize/status?req=${encodeURIComponent(req)}`)).json() as Promise<ConnectStatus>,
    decide: async (req, approve, only) => (await fetchImpl(`${origin}/oauth/authorize/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ req, approve, only }),
    })).json() as Promise<{ redirect?: string; error?: string }>,
    navigate,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    copy: copyToClipboard,
  };
}

export type ConnectOutcome = 'allowed' | 'denied' | 'expired' | 'error';

export class ConnectScreen {
  private status: ConnectStatus = { state: 'waiting' };
  private only = true;
  private phase: 'waiting' | 'paired' | 'leaving' | 'expired' | 'error' = 'waiting';
  private note: string | null = null;
  private plateEl: HTMLElement | null = null;
  private allowBtn: HTMLButtonElement | null = null;
  private scopeBtn: HTMLButtonElement | null = null;
  private denyBtn: HTMLButtonElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  /** The drawn lines' signature: polling redraws only on a change, so a selection survives. */
  private drawn = '';
  private copied = false;
  private finish: ((o: ConnectOutcome) => void) | null = null;

  constructor(private readonly kit: LauncherKit, private readonly api: ConnectApi, private readonly req: string) {}

  /** Draw the screen and resolve when the browser goes back to Claude (or the pairing ends). */
  run(): Promise<ConnectOutcome> {
    const done = new Promise<ConnectOutcome>((r) => { this.finish = r; });
    this.build();
    void this.poll();
    return done;
  }

  private get dim(): string | undefined { return this.kit.textColor(LAUNCHER_TEXT.button, UI_STATE_DISABLED) ?? undefined; }
  private get accountName(): string { const a = this.status.account ?? ''; return a.slice(a.lastIndexOf(':') + 1); }
  private get client(): string { return this.status.client || 'Claude'; }

  private async poll(): Promise<void> {
    for (;;) {
      let s: ConnectStatus;
      try { s = await this.api.status(this.req); } catch { this.note = 'Can\'t reach the game\'s server; retrying…'; this.render(); await this.api.sleep(3000); continue; }
      this.status = { ...this.status, ...s };
      this.note = null;
      if (s.state === 'expired') { this.phase = 'expired'; this.render(); this.finish?.('expired'); return; }
      if (s.state === 'paired' && this.phase === 'waiting') { this.phase = 'paired'; this.only = !!s.character; }
      // Paired: keep polling, so another tab typing the same code (multiboxing) shows up before ALLOW.
      if (this.phase !== 'waiting' && this.phase !== 'paired') return;
      this.render();
      await this.api.sleep(1500);
    }
  }

  private async decide(approve: boolean): Promise<void> {
    if (this.phase !== 'paired') return;
    this.phase = 'leaving';
    this.render();
    let r: { redirect?: string; error?: string };
    try { r = await this.api.decide(this.req, approve, approve && this.only); } catch (e) { r = { error: (e as Error).message || 'network error' }; }
    if (r.redirect && isClaudeCallback(r.redirect)) {
      this.api.navigate(r.redirect);
      this.finish?.(approve ? 'allowed' : 'denied');
      return;
    }
    this.phase = 'error';
    this.note = r.error ?? 'the answer from the server was not a Claude address';
    this.render();
    this.finish?.('error');
  }

  // ─── Building ─────────────────────────────────────────

  private build(): void {
    const mount = this.kit.prepareScreen();
    const inner = document.createElement('div');
    inner.id = 'launcher-inner';
    inner.dataset.mode = 'connect';
    Object.assign(inner.style, { position: 'absolute', left: '0', top: '0', width: '800px', height: '600px', overflow: 'hidden' });
    this.kit.attachScale(inner);
    mount.appendChild(inner);
    const lh = this.kit.renderLayout(inner, BUTTON_IDS);
    // No world box or character list here: the plate takes the left column.
    for (const id of [EL_WORLD_BOX, EL_LIST]) { const el = lh?.elements.get(id); if (el) el.style.display = 'none'; }
    const main = lh?.elements.get(0x1000039a);
    if (main && (!main.style.backgroundImage || main.style.backgroundImage === 'none')) {
      const bg = this.kit.texUrl(0x06007576);
      if (bg) Object.assign(main.style, { backgroundImage: `url(${bg})`, backgroundSize: '800px 600px' });
    }
    coverLauncherBakedLabels(this.kit, inner);

    const plate = this.kit.plate(PLATE.w, PLATE.h);
    plate.classList.add('connect-plate');
    plate.setAttribute('aria-live', 'polite');
    Object.assign(plate.style, { position: 'absolute', left: `${PLATE.x}px`, top: `${PLATE.y}px`, zIndex: '2', overflow: 'hidden' });
    this.plateEl = plate;
    inner.appendChild(plate);

    this.allowBtn = launcherPlateButton(this.kit, inner, EL_ENTER, 239, 289, 211, 211, 'ALLOW', LAUNCHER_TEXT.enter, [0x06004cb2, 0x06004cb3, 0x06004cb3], () => void this.decide(true));
    this.allowBtn.classList.add('connect-allow');
    this.allowBtn.setAttribute('aria-label', 'Allow Claude to play');
    this.scopeBtn = launcherPlateButton(this.kit, inner, EL_DELETE, 36, 522, 170, 99, 'ONLY ONE', LAUNCHER_TEXT.button, PLATE_FACES, () => { this.only = !this.only; this.render(); });
    this.scopeBtn.classList.add('connect-scope');
    this.denyBtn = launcherPlateButton(this.kit, inner, EL_EXIT, 615, 522, 170, 99, 'DENY', descRef(CHARSEL_LAYOUT, EL_EXIT), PLATE_FACES, () => void this.decide(false));
    this.denyBtn.classList.add('connect-deny');
    this.copyBtn = launcherPlateButton(this.kit, inner, EL_CREDITS, 465, 522, 170, 99, 'COPY', descRef(CHARSEL_LAYOUT, EL_CREDITS), PLATE_FACES, () => void this.copyCommand());
    this.copyBtn.classList.add('connect-copy');
    this.copyBtn.setAttribute('aria-label', 'Copy the pairing command');
    this.render();
  }

  private label(btn: HTMLButtonElement | null, text: string, ref: string, enabled: boolean): void {
    if (!btn) return;
    const span = this.kit.text(text, ref, enabled ? {} : { state: UI_STATE_DISABLED, color: this.dim });
    span.dataset.acDesc = ref;
    btn.replaceChildren(span);
    btn.disabled = !enabled;
    btn.style.cursor = enabled ? 'pointer' : 'default';
    this.kit.justifyLabel(btn);
  }

  /** The command to type in game chat, once the code is known. */
  get command(): string | null {
    const c = this.status.code;
    return c ? `/automation pair ${c.slice(0, 3)}-${c.slice(3)}` : null;
  }

  private async copyCommand(): Promise<void> {
    const cmd = this.command;
    if (!cmd || this.phase !== 'waiting') return;
    const ok = await this.api.copy(cmd);
    this.copied = ok;
    this.note = ok ? null : 'Copy didn\'t work here: select the command above and copy it.';
    this.render();
  }

  /** The plate's lines for the current phase: [text, style, colour?]; `select` marks the command (selectable text). */
  lines(): Array<{ text: string; ref: string; color?: string; gap?: number; select?: boolean }> {
    const body = LAUNCHER_TEXT.body;
    const out: Array<{ text: string; ref: string; color?: string; gap?: number; select?: boolean }> = [];
    const para = (text: string, ref = body, color?: string, gap = 0) => {
      const w = PLATE.w - 2 * PAD;
      wrapLines(text, w, 6, (t) => this.kit.measure(ref, t)).forEach((l, i) => out.push({ text: l, ref, color, gap: i === 0 ? gap : 0 }));
    };
    const code = this.status.code ? `${this.status.code.slice(0, 3)}-${this.status.code.slice(3)}` : '…';
    switch (this.phase) {
      case 'waiting':
        para(`Connect ${this.client}`, LAUNCHER_TEXT.title);
        para('Log in to the game with the character Claude should play (in another tab, or on another device), then type this in chat:', body, undefined, 8);
        out.push({ text: `/automation pair ${code}`, ref: LAUNCHER_TEXT.title, gap: 10, select: true });
        para('The code lasts 10 minutes. Several accounts? Type it in each one\'s tab. No password is asked for or kept: the game you are logged in to confirms it is you.', body, this.dim, 10);
        para(this.note ?? (this.copied ? 'Copied. Paste it into the game\'s chat. Waiting for the code from the game…' : 'Waiting for the code from the game… COPY copies the command.'), body, this.dim, 10);
        break;
      case 'paired':
      case 'leaving': {
        const accts = this.status.accounts ?? [{ account: this.status.account ?? '', character: this.status.character ?? null }];
        if (accts.length > 1) {
          const name = (a: string) => a.slice(a.lastIndexOf(':') + 1);
          const chars = accts.map((a) => a.character).filter((c): c is string => !!c);
          para(`Let ${this.client} play?`, LAUNCHER_TEXT.title);
          para(`Accounts: ${accts.map((a) => (a.character ? `${name(a.account)} (${a.character})` : name(a.account))).join(', ')}`, body, undefined, 8);
          para(chars.length && this.only ? `Claude may play only ${chars.join(', ')}.` : 'Claude may play any character on these accounts.', body, undefined, 8);
          if (chars.length) para('ONLY ONE / ANY ONE (bottom left) switches between these characters and any of yours.', body, this.dim);
          if (this.phase === 'paired') para(`Another account too? Type /automation pair ${code} in its tab.`, body, this.dim, 8);
          para(this.phase === 'leaving' ? 'Returning to Claude…' : 'Press ALLOW to let it play, or DENY.', body, undefined, 8);
          break;
        }
        const ch = this.status.character;
        para(`Let ${this.client} play?`, LAUNCHER_TEXT.title);
        para(`Account: ${this.accountName}`, body, undefined, 8);
        if (ch) para(`In the world now: ${ch}`, body);
        para(ch && this.only ? `Claude may play only ${ch}.` : 'Claude may play any character on this account.', body, undefined, 8);
        // The plate buttons fit about 8 characters (CUSTOM…, CREDITS), so the scope button says ONLY ONE / ANY ONE.
        if (ch) para('ONLY ONE / ANY ONE (bottom left) switches between this character and any of yours.', body, this.dim);
        para(this.phase === 'leaving' ? 'Returning to Claude…' : 'Press ALLOW to let it play, or DENY.', body, undefined, 8);
        para('In the game, acting yourself takes control back; /automation pause stops Claude and /automation unpair disconnects it.', body, this.dim, 10);
        break;
      }
      case 'expired':
        para('This pairing has expired', LAUNCHER_TEXT.title);
        para('Codes last 10 minutes. Start again from Claude\'s connect button.', body, undefined, 8);
        break;
      case 'error':
        para('Couldn\'t connect Claude', LAUNCHER_TEXT.title);
        para(this.note ?? 'Something went wrong.', body, undefined, 8);
        para('Start again from Claude\'s connect button.', body, this.dim, 8);
        break;
    }
    return out;
  }

  private render(): void {
    const plate = this.plateEl;
    if (!plate) return;
    const lines = this.lines();
    const sig = JSON.stringify(lines);
    if (sig !== this.drawn) {
      this.drawn = sig;
      plate.querySelectorAll('.connect-line').forEach((n) => n.remove());
      let y = PAD;
      for (const l of lines) {
        y += l.gap ?? 0;
        const row = document.createElement('div');
        row.className = 'connect-line';
        const h = this.kit.lineHeight(l.ref) || 12;
        Object.assign(row.style, { position: 'absolute', left: `${PAD}px`, top: `${y}px`, whiteSpace: 'nowrap', pointerEvents: 'none' });
        row.appendChild(this.kit.text(l.text, l.ref, l.color ? { color: l.color } : {}));
        if (l.select) {
          // The bitmap font draws the look; a transparent copy of the same text on top is what a
          // selection (and copy) takes. The page itself turns selection off, so this turns it on.
          row.classList.add('connect-command');
          row.style.pointerEvents = 'auto';
          const sel = document.createElement('span');
          sel.className = 'connect-command-text';
          sel.textContent = l.text;
          Object.assign(sel.style, {
            position: 'absolute', left: '0', top: '0', width: `${PLATE.w - 2 * PAD}px`, height: `${h}px`, lineHeight: `${h}px`,
            color: 'transparent', userSelect: 'text', webkitUserSelect: 'text', cursor: 'text', whiteSpace: 'nowrap',
            fontFamily: 'Tahoma, Verdana, sans-serif', fontSize: `${Math.max(10, h - 4)}px`,
          });
          row.appendChild(sel);
        }
        plate.appendChild(row);
        y += h;
      }
    }
    if (this.copyBtn) {
      this.copyBtn.style.display = this.phase === 'waiting' ? 'flex' : 'none';
      if (this.phase === 'waiting') this.label(this.copyBtn, 'COPY', descRef(CHARSEL_LAYOUT, EL_CREDITS), !!this.command);
    }
    const decidable = this.phase === 'paired';
    this.label(this.allowBtn, 'ALLOW', LAUNCHER_TEXT.enter, decidable);
    this.label(this.denyBtn, 'DENY', descRef(CHARSEL_LAYOUT, EL_EXIT), decidable);
    const showScope = (this.phase === 'paired' || this.phase === 'leaving') && !!this.status.character;
    if (this.scopeBtn) {
      this.scopeBtn.style.display = showScope ? 'flex' : 'none';
      if (showScope) this.label(this.scopeBtn, this.only ? 'ONLY ONE' : 'ANY ONE', LAUNCHER_TEXT.button, decidable);
    }
  }
}
