/**
 * UtilityBelt's networking between your own clients (docs/vtank-parity-gaps.md
 * §10.4), in a browser: each game tab is a client, and tabs of the same
 * browser talk over a BroadcastChannel (UB uses a local TCP server between
 * game clients on one PC).
 *
 * Ported from UtilityBelt (MIT; https://gitlab.com/utilitybelt/utilitybelt.gitlab.io,
 * Tools/Networking.cs and Tools/VTankFellowHeals.cs; contributors credited in
 * docs/vtank-parity-gaps.md §10.4), rewritten for this client:
 * - `/ub bc [millisecondDelay] <command>`: runs the command here at once and
 *   on every other client, each one `delay` later than the one before.
 * - `/ub bct <tag,tag…> [millisecondDelay] <command>`: the same for the
 *   clients with any of the tags (here too when this client has one).
 *   Tags are the per-character setting Networking.Tags.
 * - `/ub netclients [tag]`: the other clients (optionally with a tag).
 * - Vital sharing (VTank.VitalSharing, on by default): each client sends its
 *   health / stamina / mana when they change (UB: at most every 150 ms; here
 *   on the 300 ms tick) and its whole client data every 3 s, so the macro's
 *   Helper heals, restams and infuses your other characters near you even
 *   when they aren't in your fellowship.
 * - Cast sharing: a debuff the macro lands is sent with its target and
 *   duration, and the other clients' macros count it as cast (they pick
 *   other targets or spells instead of doubling it). UB sends only debuffs.
 *
 * A received `/ub bc|bct` is not run again (that would bounce between tabs).
 */

/** What carries the messages: a BroadcastChannel, or a fake in tests. */
export interface NetChannel {
  post(msg: NetMessage): void;
  listen(fn: (msg: NetMessage) => void): void;
  close(): void;
}

export interface NetVitals { health: { cur: number; max: number }; stamina: { cur: number; max: number }; mana: { cur: number; max: number } }

/** This client as the others see it. */
export interface NetSelf { name: string; world: string; vitals?: NetVitals | null; coords?: string | null }

export interface NetClient { id: string; name: string; world: string; tags: string[]; vitals?: NetVitals; coords?: string; seen: number }

export type NetMessage =
  | { v: 1; from: string; kind: 'data'; name: string; world: string; tags: string[]; vitals?: NetVitals; coords?: string; hello?: boolean }
  | { v: 1; from: string; kind: 'vitals'; vitals: NetVitals }
  | { v: 1; from: string; kind: 'bye' }
  | { v: 1; from: string; kind: 'cmd'; to: string; command: string; delay: number; req: string }
  | { v: 1; from: string; kind: 'ack'; to: string; command: string; delay: number; req: string }
  | { v: 1; from: string; kind: 'cast'; target: number; spellId: number; durationMs: number };

/** A debuff another client landed (cast sharing). */
export interface SharedCast { from: string; target: number; spellId: number; durationMs: number; at: number }

/** Per-character and per-browser settings (localStorage; memory when it's blocked). */
export interface NetStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

export interface UbNetOptions {
  channel: NetChannel;
  self: () => NetSelf | null;
  /** Run a command line as if typed in chat. */
  run: (command: string) => void;
  /** A line for chat. */
  report?: (line: string) => void;
  store?: NetStore | null;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
  id?: string;
}

const DATA_EVERY_MS = 3000;
/** A client not heard from in this long has closed (its tab was closed without a goodbye). */
const GONE_AFTER_MS = 10_000;

// A tab's id on the channel (not a game rule): time plus a few random bytes.
const randomId = (): string => `${Date.now().toString(36)}${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
const sameVitals = (a: NetVitals | null | undefined, b: NetVitals | null | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** UB's tag list syntax: comma-separated, a tag with spaces in "quotes". */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|([^",\s]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push((m[1] ?? m[2]).trim());
  return out.filter(Boolean);
}

export class UbNet {
  readonly id: string;
  private readonly clientsById = new Map<string, NetClient>();
  private readonly casts: SharedCast[] = [];
  private lastData = -Infinity;
  private lastVitals: NetVitals | null = null;
  private lastName: string | null = null;
  private started = false;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private memory = new Map<string, string>();

  constructor(private readonly o: UbNetOptions) {
    this.id = o.id ?? randomId();
    this.now = o.now ?? (() => Date.now());
    this.schedule = o.schedule ?? ((fn, ms) => { setTimeout(fn, ms); });
    o.channel.listen((m) => this.receive(m));
  }

  // ── settings ──

  private get(k: string): string | null { try { return this.o.store ? this.o.store.getItem(k) : this.memory.get(k) ?? null; } catch { return this.memory.get(k) ?? null; } }
  private put(k: string, v: string): void { this.memory.set(k, v); try { this.o.store?.setItem(k, v); } catch { /* storage blocked */ } }
  private tagKey(): string { return `acjs.ub.networking.tags.${(this.o.self()?.name ?? '').trim().toLowerCase()}`; }

  /** Networking.Tags: this character's tags. */
  get tags(): string[] { try { const v = JSON.parse(this.get(this.tagKey()) ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } }
  setTags(tags: string[]): void { this.put(this.tagKey(), JSON.stringify([...new Set(tags)])); this.sendData(); }
  /** VTank.VitalSharing (UB's default: on), per browser. */
  get vitalSharing(): boolean { return this.get('acjs.ub.vtank.vitalSharing') !== 'false'; }
  setVitalSharing(on: boolean): void { this.put('acjs.ub.vtank.vitalSharing', on ? 'true' : 'false'); if (on) this.sendData(); }

  // ── lifecycle ──

  /** Say hello (the others answer with their data) and start sending ours. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.sendData(true);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.o.channel.post({ v: 1, from: this.id, kind: 'bye' });
  }

  /** Goodbye, and the channel closed (the tab's game is going away). */
  close(): void { this.stop(); this.o.channel.close(); }

  /** The 300 ms beat: vitals when they changed, the whole client data every 3 s, and closed tabs dropped. */
  tick(): void {
    if (!this.started) return;
    const me = this.o.self();
    if (!me) return;
    const t = this.now();
    if (me.name !== this.lastName || t - this.lastData >= DATA_EVERY_MS) this.sendData();
    else if (this.vitalSharing && me.vitals && !sameVitals(me.vitals, this.lastVitals)) {
      this.lastVitals = me.vitals;
      this.o.channel.post({ v: 1, from: this.id, kind: 'vitals', vitals: me.vitals });
    }
    for (const [id, c] of this.clientsById) if (t - c.seen > GONE_AFTER_MS) this.clientsById.delete(id);
  }

  private sendData(hello = false): void {
    const me = this.o.self();
    if (!me || !this.started) return;
    this.lastData = this.now();
    this.lastName = me.name;
    const share = this.vitalSharing;
    if (share && me.vitals) this.lastVitals = me.vitals;
    this.o.channel.post({
      v: 1, from: this.id, kind: 'data', name: me.name, world: me.world, tags: this.tags,
      ...(share && me.vitals ? { vitals: me.vitals } : {}), ...(share && me.coords ? { coords: me.coords } : {}), ...(hello ? { hello: true } : {}),
    });
  }

  private receive(m: NetMessage): void {
    if (!m || m.v !== 1 || m.from === this.id) return;
    const t = this.now();
    switch (m.kind) {
      case 'data': {
        const had = this.clientsById.get(m.from);
        this.clientsById.set(m.from, { id: m.from, name: m.name, world: m.world, tags: m.tags ?? [], ...(m.vitals ? { vitals: m.vitals } : {}), ...(m.coords ? { coords: m.coords } : {}), seen: t });
        // A new client: it doesn't know us yet.
        if ((m.hello || !had) && this.started) this.sendData();
        return;
      }
      case 'vitals': { const c = this.clientsById.get(m.from); if (c) { c.vitals = m.vitals; c.seen = t; } return; }
      case 'bye': this.clientsById.delete(m.from); return;
      case 'cmd': {
        if (m.to !== this.id) return;
        this.o.channel.post({ v: 1, from: this.id, kind: 'ack', to: m.from, command: m.command, delay: m.delay, req: m.req });
        if (/^\s*\/ub\s+(bc|bct)\b/i.test(m.command)) { this.o.report?.(`Not running a broadcast command from another client (it would bounce back): ${m.command}`); return; }
        this.schedule(() => this.o.run(m.command), Math.max(0, m.delay));
        return;
      }
      case 'ack': {
        if (m.to !== this.id) return;
        const c = this.clientsById.get(m.from);
        this.o.report?.(`${c?.name ?? 'A client'} ack'd command broadcast request. (${m.command} /// ${m.delay}ms)`);
        return;
      }
      case 'cast': {
        this.casts.push({ from: m.from, target: m.target, spellId: m.spellId, durationMs: m.durationMs, at: t });
        if (this.casts.length > 200) this.casts.splice(0, this.casts.length - 200);
        return;
      }
    }
  }

  // ── what the commands and the macro use ──

  /** The other clients, optionally only those with any of `tags`. */
  clients(tags: string[] = []): NetClient[] {
    return [...this.clientsById.values()].filter((c) => !tags.length || c.tags.some((x) => tags.includes(x))).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * `/ub bc` (no tags) and `/ub bct`: run `command` here (when this client is
   * included) and send it to each other client, each `delayMs` after the last.
   */
  broadcast(command: string, delayMs: number, tags: string[] | null): string[] {
    const targets = tags ? this.clients(tags) : this.clients();
    const lines = [tags
      ? `Broadcasting command to clients with tags (${tags.join(',')}): "${command}" with delay inbetween of ${delayMs}ms`
      : `Broadcasting command to all clients: "${command}" with delay inbetween of ${delayMs}ms`];
    if (!tags || tags.some((x) => this.tags.includes(x))) this.schedule(() => this.o.run(command), 0);
    let at = 0;
    for (const c of targets) {
      at += delayMs;
      if (!tags) lines.push(`Sending ${c.name}: "${command}" with delay inbetween of ${delayMs}ms`);
      this.o.channel.post({ v: 1, from: this.id, kind: 'cmd', to: c.id, command, delay: at, req: randomId() });
    }
    return lines;
  }

  /** Cast sharing: a debuff this client's macro landed. */
  shareCast(target: number, spellId: number, durationMs: number): void {
    if (!this.started) return;
    this.o.channel.post({ v: 1, from: this.id, kind: 'cast', target, spellId, durationMs });
  }

  /** The debuffs other clients landed since the last call (the macro adds them to its cast log). */
  takeCasts(): SharedCast[] { return this.casts.splice(0, this.casts.length); }

  /** Vitals of the other clients that share them, by character name. */
  sharedVitals(): Array<{ name: string; vitals: NetVitals }> {
    return this.clients().flatMap((c) => (c.vitals ? [{ name: c.name, vitals: c.vitals }] : []));
  }
}

/** A BroadcastChannel as a NetChannel, or null where the browser has none. */
export function browserNetChannel(name = 'acjs-utilitybelt'): NetChannel | null {
  const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (!BC) return null;
  const ch = new BC(name);
  return {
    post: (m) => { try { ch.postMessage(m); } catch { /* closed */ } },
    listen: (fn) => { ch.onmessage = (e: MessageEvent) => fn(e.data as NetMessage); },
    close: () => ch.close(),
  };
}

// The tab's client, for the macro (one game per tab).
let active: UbNet | null = null;
export function setActiveUbNet(net: UbNet | null): void { active = net; }
export function activeUbNet(): UbNet | null { return active; }

/**
 * The `/ub` networking commands: bc, bct, netclients, and Networking.Tags /
 * VTank.VitalSharing through `/ub opt get|set|toggle`. Null when the line is
 * none of these (another handler takes it).
 */
export function ubNetCommand(line: string, net: UbNet): string[] | null {
  const m = /^\s*\/ub\s+(\S+)\s*(.*)$/i.exec(line);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = m[2].trim();
  if (cmd === 'bc') {
    const a = /^(\d*)\s*(.*)$/.exec(rest)!;
    if (!a[2]) return ['Usage: /ub bc [millisecondDelay] <command>'];
    return net.broadcast(a[2], a[1] ? Number(a[1]) : 0, null);
  }
  if (cmd === 'bct') {
    const a = /^((?:"[^"]+"|[^"\s,]+)(?:,(?:"[^"]+"|[^"\s,]+))*)\s+(\d*)\s*(.*)$/.exec(rest);
    if (!a || !a[3]) return ['Usage: /ub bct <teamslist> [millisecondDelay] <command>'];
    const tags = parseTags(a[1]);
    if (!tags.length) return ['You must specify at least one tag to send the command to.'];
    return net.broadcast(a[3], a[2] ? Number(a[2]) : 0, tags);
  }
  if (cmd === 'netclients') {
    const tags = parseTags(rest);
    const cs = net.clients(tags);
    if (!cs.length) return ['No net clients to show'];
    return cs.map((c) => `${c.name} (${c.world})${c.tags.length ? ` tags: ${c.tags.join(', ')}` : ''}${c.vitals ? ` H ${c.vitals.health.cur}/${c.vitals.health.max} S ${c.vitals.stamina.cur}/${c.vitals.stamina.max} M ${c.vitals.mana.cur}/${c.vitals.mana.max}` : ''}${c.coords ? ` at ${c.coords}` : ''}`);
  }
  if (cmd === 'opt') {
    const o = /^(get|set|toggle)\s+(networking\.tags|vtank\.vitalsharing)\b\s*(.*)$/i.exec(rest);
    if (!o) return null;
    const verb = o[1].toLowerCase(), key = o[2].toLowerCase(), val = o[3].trim();
    if (key === 'networking.tags') {
      if (verb === 'set') net.setTags(parseTags(val.replace(/^\[|\]$/g, '')));
      else if (verb === 'toggle') return ['Networking.Tags is a list: /ub opt set Networking.Tags one,two'];
      return [`Networking.Tags = [${net.tags.join(', ')}]`];
    }
    if (verb === 'set') {
      if (!/^(true|false)$/i.test(val)) return ['Usage: /ub opt set VTank.VitalSharing true|false'];
      net.setVitalSharing(/^true$/i.test(val));
    } else if (verb === 'toggle') net.setVitalSharing(!net.vitalSharing);
    return [`VTank.VitalSharing = ${net.vitalSharing}`];
  }
  return null;
}
