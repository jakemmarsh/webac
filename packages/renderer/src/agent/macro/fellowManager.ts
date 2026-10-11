/**
 * AGENT.vtank-window — VirindiTank's Auto Fellow Mgmt (Fellowship Commands,
 * http://www.virindi.net/wiki/index.php/Virindi_Tank_Fellowship_Commands):
 * while you lead the fellowship, players /tell you commands and the macro
 * answers by /tell, recruits through the fellowship pane's Recruit, and
 * hands leadership over through the pane's Leader button.
 *
 * - xp: recruit the teller. Too far: wait 20 s and give one more chance.
 *   Full (9, counting recruits already asked): a place in the waiting line.
 *   When a slot frees (a fellow leaves) the next in line is recruited.
 * - line: the fellowship's size and the waiting line. remove: leave the line.
 * - leader: who leads. startvote giveleader <fellow>: a 2-minute vote,
 *   announced in fellowship chat; fellows tell "vote <n> yes|no"; a majority
 *   of the fellows (you excepted) passes leadership to that fellow.
 * - help: the commands this fellowship can use.
 *
 * At most 8 commands per player in 3 minutes (VTank CHG .39); more are
 * ignored. startvote / vote exist only where the client can hand leadership
 * over (FellowshipInfo.handOff: the era's own features; the 1999 client has
 * no Assign New Leader, Absent1999 `fellowshipLeadership`).
 *
 * The wiki gives the wording of the recruit, too-far, help, vote-call and
 * vote-total lines; the line / remove / leader / full replies are ours.
 */
import type { AgentApi } from '../AgentApi.ts';
import type { AgentResult } from '../types.ts';

export interface FellowStep { label: string; run: () => Promise<AgentResult> }

const TAG = '[VT Fellow Manager]';
const END = '-v-';
const MAX = 9;
/** A recruit offer's server dialog lasts 30 s; until then the asked player holds a slot. */
const JOIN_WAIT_MS = 30_000;
const RETRY_MS = 20_000;
const VOTE_MS = 120_000;
const RATE_N = 8;
const RATE_MS = 180_000;
/** How close a player must be to be recruited (in sight). */
const REACH = 60;

interface Ask { name: string; at: number; tries: number }
interface Vote { idx: number; caller: string; target: string; ends: number; ballots: Map<string, boolean> }

const lc = (s: string) => s.toLowerCase();

export class FellowManager {
  private mark = 0;
  /** Players being recruited now (the reach check, with its one 20 s second chance). */
  private asks: Ask[] = [];
  /** The waiting line, first in line first. */
  readonly line: string[] = [];
  /** Recruit offers sent, by lower-case name: they hold a slot until they join or the offer lapses. */
  private offered = new Map<string, number>();
  /** What to do, in order: chat lines (sent together in one step) and pane actions. */
  private out: Array<FellowStep & { say?: string }> = [];
  private heard = new Map<string, number[]>();
  private votes: Vote[] = [];
  private nextVote = 1;

  constructor(private readonly api: AgentApi, private readonly now: () => number) {}

  /** The commands `help` lists here: startvote / vote only where leadership can be handed over. */
  static commands(handOff: boolean): string[] {
    return handOff ? ['xp', 'line', 'remove', 'leader', 'startvote', 'vote', 'help'] : ['xp', 'line', 'remove', 'leader', 'help'];
  }

  private tell(name: string, text: string): void {
    const say = `/tell ${name}, ${TAG} ${text} ${END}`;
    this.out.push({ label: `fellow: tell ${name}: ${text}`, say, run: async () => this.api.say(say) });
  }

  private fellowChat(text: string): void {
    const say = `/f ${TAG} ${text} ${END}`;
    this.out.push({ label: `fellow: ${text}`, say, run: async () => this.api.say(say) });
  }

  /** Per player: true while they are within 8 commands in 3 minutes (this one counted). */
  private allowed(name: string, t: number): boolean {
    const k = lc(name);
    const h = (this.heard.get(k) ?? []).filter((x) => t - x < RATE_MS);
    if (h.length >= RATE_N) { this.heard.set(k, h); return false; }
    h.push(t);
    this.heard.set(k, h);
    return true;
  }

  /** The next thing to do (a reply, a recruit, a hand-off), or null. `on`: Auto Fellow Mgmt. */
  step(on: boolean): FellowStep | null {
    const ev = this.api.eventsSince(this.mark);
    if (ev.length) this.mark = ev[ev.length - 1].seq;
    const info = this.api.fellowshipInfo();
    if (!on || !info?.leader) { this.reset(); return null; }
    const t = this.now();
    const me = this.api.snapshot({ radius: 1, max: 1 }).me?.name ?? 'me';
    const members = info.members ?? [];
    const isMember = (n: string) => members.some((m) => lc(m) === lc(n));
    const handOff = info.handOff !== false;

    // Offers that were answered (they joined) or lapsed free their slot.
    for (const [k, at] of this.offered) if (isMember(k) || t - at > JOIN_WAIT_MS) this.offered.delete(k);

    for (const e of ev) {
      const m = /^\(tell\) (.+?) tells you, "([\s\S]*)"$/.exec(e.text);
      if (m) this.command(m[1], m[2], { info, me, members, isMember, handOff, t });
    }

    this.closeVotes(t, members, me, handOff);

    // A slot is free: the next in line is recruited.
    const used = () => info.count + this.offered.size + this.asks.length;
    while (this.line.length && used() < MAX) {
      const name = this.line.shift()!;
      if (isMember(name)) continue;
      this.tell(name, 'I will recruit you in a moment. Please stand close to me.');
      this.asks.push({ name, at: t, tries: 0 });
    }

    // Recruit whoever is in reach; one out of reach is told so and gets one more try 20 s later.
    for (const ask of [...this.asks]) {
      if (ask.tries === 1 && t - ask.at < RETRY_MS) continue;
      if (isMember(ask.name)) { this.asks.splice(this.asks.indexOf(ask), 1); continue; }
      const near = this.api.snapshot({ radius: REACH, max: 80 }).nearby.find((o) => o.kind === 'player' && lc(o.name) === lc(ask.name));
      if (!near) {
        if (ask.tries === 0) { ask.tries = 1; ask.at = t; this.tell(ask.name, 'You are too far away. I will wait 20 seconds and give you one more chance.'); continue; }
        this.asks.splice(this.asks.indexOf(ask), 1);
        continue;
      }
      if (this.out.some((s) => s.label.startsWith('fellow: recruiting'))) break; // one Recruit at a time (it selects them first)
      this.asks.splice(this.asks.indexOf(ask), 1);
      this.offered.set(lc(near.name), t);
      this.out.push({ label: `fellow: recruiting ${near.name}`, run: () => this.api.fellowship('recruit', near.name) });
    }

    // Replies go out together (chat lines); a pane action (Recruit, Leader) is a step of its own.
    let n = 0;
    while (n < this.out.length && this.out[n].say !== undefined) n++;
    if (n <= 1) return this.out.shift() ?? null;
    const lines = this.out.splice(0, n);
    return {
      label: lines.map((l) => l.label).join('; '),
      run: async () => { let r: AgentResult = { ok: true, message: '' }; for (const l of lines) r = this.api.say(l.say!); return r; },
    };
  }

  private command(name: string, raw: string, c: { info: { count: number }; me: string; members: string[]; isMember: (n: string) => boolean; handOff: boolean; t: number }): void {
    const words = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const cmd = words[0] ?? '';
    const known = ['xp', 'line', 'remove', 'leader', 'help', ...(c.handOff ? ['startvote', 'vote'] : [])];
    if (!known.includes(cmd)) return;
    if (!this.allowed(name, c.t)) return;
    const k = lc(name);
    const place = () => this.line.findIndex((n) => lc(n) === k);
    switch (cmd) {
      case 'help':
        this.tell(name, `Available commands: ${FellowManager.commands(c.handOff).join(', ')}`);
        return;
      case 'xp': {
        if (c.isMember(name) || this.offered.has(k) || this.asks.some((a) => lc(a.name) === k)) return;
        if (place() >= 0) { this.tell(name, `You are number ${place() + 1} in line.`); return; }
        if (this.line.length || c.info.count + this.offered.size + this.asks.length >= MAX) {
          this.line.push(name);
          this.tell(name, `The fellowship is full. You are number ${this.line.length} in line.`);
          return;
        }
        this.tell(name, 'I will recruit you in a moment. Please stand close to me.');
        this.asks.push({ name, at: c.t, tries: 0 });
        return;
      }
      case 'line': {
        const p = place();
        this.tell(name, `Fellowship: ${c.info.count}/${MAX}. Waiting list: ${this.line.length ? this.line.join(', ') : 'empty'}.${p >= 0 ? ` You are number ${p + 1}.` : ''}`);
        return;
      }
      case 'remove': {
        const p = place();
        if (p < 0) { this.tell(name, 'You are not on the waiting list.'); return; }
        this.line.splice(p, 1);
        this.tell(name, 'You have been removed from the waiting list.');
        return;
      }
      case 'leader':
        this.tell(name, `The fellowship leader is ${c.me}.`);
        return;
      case 'startvote': {
        if (!c.isMember(name)) return;
        const target = c.members.find((m) => lc(m) === words.slice(2).join(' ') && lc(m) !== lc(c.me)); // names have spaces
        if (words[1] !== 'giveleader' || !target) { this.tell(name, 'Usage: startvote giveleader <fellow>'); return; }
        if (this.votes.some((v) => lc(v.target) === lc(target))) return;
        const v: Vote = { idx: this.nextVote++, caller: name, target, ends: c.t + VOTE_MS, ballots: new Map() };
        this.votes.push(v);
        this.fellowChat(`${name} has called a new vote: giveleader ${target}! To vote either tell me 'vote ${v.idx} yes' or 'vote ${v.idx} no'. You have 2 minutes.`);
        return;
      }
      case 'vote': {
        if (!c.isMember(name)) return;
        const v = this.votes.find((x) => String(x.idx) === words[1]);
        if (!v || (words[2] !== 'yes' && words[2] !== 'no')) return;
        v.ballots.set(k, words[2] === 'yes');
        return;
      }
    }
  }

  private closeVotes(t: number, members: string[], me: string, handOff: boolean): void {
    for (const v of [...this.votes]) {
      if (t < v.ends) continue;
      this.votes.splice(this.votes.indexOf(v), 1);
      // Fellows still in it count; you (the leader) don't vote.
      const voters = members.filter((m) => lc(m) !== lc(me));
      const yes = voters.filter((m) => v.ballots.get(lc(m)) === true).length;
      this.fellowChat(`Vote total for 'giveleader ${v.target}' (${v.idx}): ${yes}/${voters.length}`);
      const target = members.find((m) => lc(m) === lc(v.target));
      if (handOff && target && yes * 2 > voters.length) {
        this.out.push({ label: `fellow: vote ${v.idx} passed, giving leadership to ${target}`, run: () => this.api.fellowship('leader', target) });
      }
    }
  }

  /** Not leading (or switched off): nothing is pending. */
  private reset(): void {
    this.asks = [];
    this.line.length = 0;
    this.offered.clear();
    this.votes = [];
    this.out = [];
  }
}
