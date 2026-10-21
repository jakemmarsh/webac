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
 *   A fellow is told they are already in; a banned player is refused.
 * - line (also list, status): the fellowship's size and the waiting line.
 *   remove: leave the line.
 * - leader: who leads. location: your landcell (and map coordinates), for
 *   fellows only.
 * - startvote kick|ban|giveleader <fellow>, startvote setopen true|false: a
 *   2-minute vote, announced in fellowship chat; the caller votes yes, fellows
 *   tell "vote <n> yes|no"; a majority of the fellows (you excepted) passes it.
 *   kick dismisses the fellow; ban also refuses their xp from then on;
 *   giveleader hands leadership over; setopen opens or closes the fellowship.
 *   A caller may start one vote per 4 minutes, and the same vote can't run twice.
 * - help: the commands this fellowship can use; help startvote / help vote:
 *   their usage.
 *
 * At most 8 commands per player in 3 minutes (VTank CHG .39); more are
 * ignored. giveleader and setopen exist only where the client can hand
 * leadership over and open a fellowship (FellowshipInfo.handOff: the era's
 * own features; the 1999 client has neither, Absent1999
 * `fellowshipLeadership`); kick and ban dismiss, which every era has.
 *
 * The wiki gives the wording of the recruit, too-far, help, vote-call and
 * vote-total lines; the other replies are ours. The kick / ban / setopen
 * votes, location, list / status and the "already in" reply are VTank's
 * (MOSS `FellowshipManager`, read for facts only).
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
/** A caller may start one vote per 4 minutes. */
const CALLER_MS = 240_000;
/** How close a player must be to be recruited (in sight). */
const REACH = 60;

interface Ask { name: string; at: number; tries: number }
type VoteKind = 'kick' | 'ban' | 'giveleader' | 'setopen';
interface Vote { idx: number; caller: string; kind: VoteKind; target: string; ends: number; ballots: Map<string, boolean> }

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
  /** Players a ban vote put out, by lower-case name: their xp is refused while you lead. */
  private banned = new Set<string>();
  /** When each caller may start another vote. */
  private callerReady = new Map<string, number>();

  constructor(private readonly api: AgentApi, private readonly now: () => number) {}

  /** The commands `help` lists. */
  static commands(): string[] {
    return ['xp', 'line', 'remove', 'leader', 'location', 'startvote', 'vote', 'help'];
  }

  /** The vote types this era's fellowship can carry out: giveleader and setopen need the Leader hand-off and Open. */
  static voteKinds(handOff: boolean): VoteKind[] {
    return handOff ? ['kick', 'ban', 'giveleader', 'setopen'] : ['kick', 'ban'];
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
    const me = this.api.self()?.name ?? 'me';
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
      const near = this.api.look({ radius: REACH, max: 80 }).nearby.find((o) => o.kind === 'player' && lc(o.name) === lc(ask.name));
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
    const known = ['xp', 'line', 'list', 'status', 'remove', 'leader', 'location', 'help', 'startvote', 'vote'];
    if (!known.includes(cmd)) return;
    if (!this.allowed(name, c.t)) return;
    const k = lc(name);
    const place = () => this.line.findIndex((n) => lc(n) === k);
    const kinds = FellowManager.voteKinds(c.handOff);
    switch (cmd) {
      case 'help':
        if (words[1] === 'startvote') this.tell(name, `Usage: startvote <type> <parameter>. Vote types: ${kinds.map((x) => (x === 'setopen' ? 'setopen true|false' : `${x} <fellow>`)).join(', ')}.`);
        else if (words[1] === 'vote') this.tell(name, 'Usage: vote <vote number> yes|no');
        else this.tell(name, `Available commands: ${FellowManager.commands().join(', ')}`);
        return;
      case 'xp': {
        if (c.isMember(name)) { this.tell(name, 'You are already in the fellowship.'); return; }
        if (this.banned.has(k)) { this.tell(name, 'You have been banned from this fellowship.'); return; }
        if (this.offered.has(k) || this.asks.some((a) => lc(a.name) === k)) return;
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
      case 'line': case 'list': case 'status': {
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
      case 'location': {
        if (!c.isMember(name)) { this.tell(name, 'I only tell fellows where I am.'); return; }
        const me = this.api.self();
        if (!me) return;
        this.tell(name, `I am in landcell ${me.cell}${me.coords ? ` (${me.coords})` : ''}.`);
        return;
      }
      case 'startvote': {
        if (!c.isMember(name) || this.banned.has(k)) return;
        const kind = words[1] as VoteKind;
        const param = words.slice(2).join(' '); // names have spaces
        const usage = () => this.tell(name, `Usage: startvote <type> <parameter>. Vote types: ${kinds.map((x) => (x === 'setopen' ? 'setopen true|false' : `${x} <fellow>`)).join(', ')}.`);
        if (!kinds.includes(kind) || !param) { usage(); return; }
        let target: string | undefined;
        if (kind === 'setopen') target = param === 'true' || param === 'false' ? param : undefined;
        else target = c.members.find((m) => lc(m) === param && lc(m) !== lc(c.me));
        if (!target) { usage(); return; }
        if ((this.callerReady.get(k) ?? 0) > c.t) { this.tell(name, 'You started a vote too recently.'); return; }
        if (this.votes.some((v) => v.kind === kind && lc(v.target) === lc(target))) { this.tell(name, 'That vote is already running.'); return; }
        const v: Vote = { idx: this.nextVote++, caller: name, kind, target, ends: c.t + VOTE_MS, ballots: new Map([[k, true]]) };
        this.votes.push(v);
        this.callerReady.set(k, c.t + CALLER_MS);
        this.fellowChat(`${name} has called a new vote: ${kind} ${target}! To vote either tell me 'vote ${v.idx} yes' or 'vote ${v.idx} no'. You have 2 minutes.`);
        return;
      }
      case 'vote': {
        if (!c.isMember(name) || this.banned.has(k)) return;
        const v = this.votes.find((x) => String(x.idx) === words[1]);
        if (!v || (words[2] !== 'yes' && words[2] !== 'no')) { this.tell(name, 'Usage: vote <vote number> yes|no'); return; }
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
      this.fellowChat(`Vote total for '${v.kind} ${v.target}' (${v.idx}): ${yes}/${voters.length}`);
      if (yes * 2 <= voters.length) continue;
      if (v.kind === 'setopen') {
        if (handOff) this.out.push({ label: `fellow: vote ${v.idx} passed, ${v.target === 'true' ? 'opening' : 'closing'} the fellowship`, run: () => this.api.fellowship(v.target === 'true' ? 'open' : 'close') });
        continue;
      }
      const target = members.find((m) => lc(m) === lc(v.target));
      if (!target) continue;
      if (v.kind === 'giveleader') {
        if (handOff) this.out.push({ label: `fellow: vote ${v.idx} passed, giving leadership to ${target}`, run: () => this.api.fellowship('leader', target) });
        continue;
      }
      if (v.kind === 'ban') this.banned.add(lc(target));
      this.out.push({ label: `fellow: vote ${v.idx} passed, dismissing ${target}${v.kind === 'ban' ? ' (banned)' : ''}`, run: () => this.api.fellowship('dismiss', target) });
    }
  }

  /** Not leading (or switched off): nothing is pending. */
  private reset(): void {
    this.asks = [];
    this.line.length = 0;
    this.offered.clear();
    this.votes = [];
    this.out = [];
    this.banned.clear();
    this.callerReady.clear();
  }
}
