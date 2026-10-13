/**
 * Mag-Tools' `/mt` command line (docs/plugin-specs/magtools.md §10), rebuilt from the spec's
 * facts: the parser, the name lookup, and a dispatcher onto an injected host (`MtHost`), in the
 * shape of renderer agent/ub/ubCommands.ts (a line in, chat lines out, null when not ours).
 *
 * - A line that isn't a `/mt` command, or that fails (unknown verb, nothing found by that name,
 *   bad arguments), returns null: upstream leaves it unconsumed and the game answers it.
 * - Most commands print nothing on success ([]); `/mt opt` prints `<{Mag-Tools}>: …` lines.
 * - Left out (no browser target, No Dead-End UI, spec §14): `/mt send …`, `/mt click <x> <y>`,
 *   `/mt get xy`, `/mt quit` / `exit`, `/mt client minimize`. Not here yet: `jump` / `movement`,
 *   `attack_melee`, `autopack`, `dumpspells` (they need the movement input, the packer, a download).
 */
import { mtLine } from './format.js';
import type { MtOptions } from './options.js';

/** An object the host can name: an inventory item, something in the open container, or on the landscape. */
export interface MtObject {
  id: number;
  name: string;
  /** For `/mt use closestnpc|closestvendor|closestportal` and the like. */
  kind?: 'npc' | 'vendor' | 'portal' | 'monster' | 'player' | 'item' | 'other';
  /** Worn or wielded (inventory items). */
  equipped?: boolean;
}

export type MtCombatState = 'magic' | 'melee' | 'missile' | 'peace';
export type MtDialogButton = 'ok' | 'yes' | 'no';

/**
 * What `/mt` reads and does in the game. Every action goes through the client's own paths (what a
 * player can do by hand); the lead builds it over the agent API, tests fake it.
 */
export interface MtHost {
  /** Your inventory, main pack first, worn items flagged. */
  inventory(): readonly MtObject[];
  /** The open container's (chest, corpse, pack) contents, or null. */
  openContainer(): { id: number; name: string; items: readonly MtObject[] } | null;
  /** Objects on the landscape, nearest first, you excluded. */
  landscape(): readonly MtObject[];
  /** The spells `/mt cast` can name (the spell table or your spellbook). */
  spells(): Iterable<{ id: number; name: string }>;
  select(id: number): void;
  /** Use an object (a double-click: opens, talks, equips or takes off an inventory item, picks up from a container). */
  use(id: number): void;
  /** Select the target, then use the item on it. */
  useOn(item: number, target: number): void;
  give(item: number, target: number): void;
  drop(item: number): void;
  /** `target` null: the spell's own default (self, or the current selection). */
  cast(spellId: number, target: number | null): void;
  combatState(state: MtCombatState): void;
  /** Turn to an absolute heading in degrees. */
  face(degrees: number): void;
  logout(): void;
  /** Press a button of the open confirmation dialog; false when there is none. */
  clickDialog(button: MtDialogButton): boolean;
  fellowship(action: 'create', name: string): void;
  fellowship(action: 'open' | 'close' | 'disband' | 'quit'): void;
  fellowship(action: 'recruit', id: number): void;
  trade(action: 'add', id: number): void;
  trade(action: 'accept' | 'decline' | 'reset' | 'end'): void;
  /** The open vendor's goods, or null when no vendor is open. */
  vendor(): { items: readonly MtObject[] } | null;
  vendorAddBuy(id: number, count: number): void;
  vendorAddSell(id: number): void;
  vendorAction(action: 'buy' | 'clearbuy' | 'sell' | 'clearsell'): void;
}

interface Where { inventory?: boolean; container?: boolean; landscape?: boolean }
const ALL: Where = { inventory: true, container: true, landscape: true };

export class MtCommands {
  /** `/mt opt remember`: session memory only. */
  private remembered = new Map<string, string>();

  constructor(private readonly host: MtHost, private readonly options: MtOptions) {}

  /**
   * Mag-Tools' FindIdForName: an exact (case-insensitive) name in inventory, then the open
   * container, then the nearest on the landscape; for a partial (`…p`) command, then the same
   * order with "name contains".
   */
  find(name: string, where: Where, partial: boolean, filter?: (o: MtObject) => boolean): MtObject | null {
    const want = name.trim().toLowerCase();
    if (!want) return null;
    const pools: Array<readonly MtObject[]> = [];
    if (where.inventory) pools.push(this.host.inventory());
    if (where.container) pools.push(this.host.openContainer()?.items ?? []);
    if (where.landscape) pools.push(this.host.landscape());
    const ok = (o: MtObject) => !filter || filter(o);
    for (const pool of pools) {
      const hit = pool.find((o) => ok(o) && o.name.toLowerCase() === want);
      if (hit) return hit;
    }
    if (!partial) return null;
    for (const pool of pools) {
      const hit = pool.find((o) => ok(o) && o.name.toLowerCase().includes(want));
      if (hit) return hit;
    }
    return null;
  }

  /**
   * A typed chat line: the lines to print when `/mt` took it, else null (the line goes to the game).
   * The verb is matched case-insensitively; arguments keep the case typed (spec §12 #3, fixed:
   * upstream lower-cases the whole line, so `opt set` strings and `fellow create` names lost their case).
   */
  command(line: string): string[] | null {
    const m = /^\s*\/mt(?:\s+(.*))?$/i.exec(line);
    if (!m) return null;
    const rest = (m[1] ?? '').trim();
    const sp = rest.search(/\s/);
    const verb = (sp < 0 ? rest : rest.slice(0, sp)).toLowerCase();
    const args = sp < 0 ? '' : rest.slice(sp + 1).trim();
    const h = this.host;
    const done = (ran: boolean): string[] | null => (ran ? [] : null);

    switch (verb) {
      case 'test': return [];
      case 'logoff': case 'logout': h.logout(); return [];
      case 'click': {
        const b = args.toLowerCase();
        if (b !== 'ok' && b !== 'yes' && b !== 'no') return null;
        h.clickDialog(b);
        return [];
      }
      case 'face': {
        if (!/^-?\d+(\.\d+)?$/.test(args)) return null;
        h.face(Number(args));
        return [];
      }
      case 'combatstate': {
        const s = args.toLowerCase();
        if (s !== 'magic' && s !== 'melee' && s !== 'missile' && s !== 'peace') return null;
        h.combatState(s);
        return [];
      }
      case 'select': case 'selectp': {
        const o = this.find(args, ALL, verb.endsWith('p'));
        if (o) h.select(o.id);
        return done(!!o);
      }
      case 'use': case 'usep': case 'usei': case 'useip': case 'usel': case 'uselp':
        return this.use(verb, args);
      case 'equip': case 'equipp': case 'dequip': case 'dequipp': {
        const wantEquipped = verb.startsWith('dequip');
        const o = this.find(args, { inventory: true }, verb.endsWith('pp'),(x) => !!x.equipped === wantEquipped);
        if (o) h.use(o.id);
        return done(!!o);
      }
      case 'give': case 'givep': {
        const parts = /^(.+?)\s+to\s+(.+)$/i.exec(args);
        if (!parts) return null;
        const partial = verb === 'givep';
        const item = this.find(parts[1]!, { inventory: true }, partial);
        const target = item ? this.find(parts[2]!, { landscape: true }, partial) : null;
        if (item && target) h.give(item.id, target.id);
        return done(!!(item && target));
      }
      case 'loot': case 'lootp': {
        const o = this.find(args, { container: true }, verb === 'lootp');
        if (o) h.use(o.id);
        return done(!!o);
      }
      case 'drop': case 'dropp': {
        const o = this.find(args, { inventory: true }, verb === 'dropp');
        if (o) h.drop(o.id);
        return done(!!o);
      }
      case 'cast': case 'castp': return this.cast(verb === 'castp', args);
      case 'fellow': return this.fellow(args);
      case 'trade': return this.trade(args);
      case 'vendor': return this.vendor(args);
      case 'opt': return this.opt(args);
      default: return null;
    }
  }

  private use(verb: string, args: string): string[] | null {
    const h = this.host;
    const partial = verb.endsWith('p');
    const scope = verb.replace(/^use/, '').replace(/p$/, '');
    const special = args.toLowerCase();
    if (scope === '' && (special === 'closestnpc' || special === 'closestvendor' || special === 'closestportal')) {
      const kind = special.slice('closest'.length) as 'npc' | 'vendor' | 'portal';
      const o = h.landscape().find((x) => x.kind === kind);
      if (o) h.use(o.id);
      return o ? [] : null;
    }
    const on = /^(.+?)\s+on\s+(.+)$/i.exec(args);
    if (on) {
      // Spec §12 #2 (fixed): upstream searched usel's first item with inventory and landscape both off, so
      // `/mt usel <a> on <b>` never worked; usel's item comes from the landscape, as the wiki says.
      const itemWhere: Where = scope === 'l' ? { landscape: true } : { inventory: true };
      const item = this.find(on[1]!, itemWhere, partial);
      const target = item ? this.find(on[2]!, { inventory: true, landscape: true }, partial) : null;
      if (item && target) h.useOn(item.id, target.id);
      return item && target ? [] : null;
    }
    const where: Where = scope === 'i' ? { inventory: true } : scope === 'l' ? { landscape: true } : ALL;
    const o = this.find(args, where, partial);
    if (o) h.use(o.id);
    return o ? [] : null;
  }

  private cast(partial: boolean, args: string): string[] | null {
    const m = /^(.+?)(?:\s+on\s+(.+))?$/i.exec(args);
    if (!m) return null;
    const what = m[1]!.trim();
    let spellId: number | null = null;
    if (/^\d+$/.test(what)) spellId = Number(what);
    else {
      const want = what.toLowerCase();
      let contains: number | null = null;
      for (const s of this.host.spells()) {
        const n = s.name.toLowerCase();
        if (n === want) { spellId = s.id; break; }
        if (partial && contains === null && n.includes(want)) contains = s.id;
      }
      spellId ??= contains;
    }
    if (spellId === null) return null;
    let target: number | null = null;
    if (m[2]) {
      const t = this.find(m[2], { landscape: true }, partial);
      if (!t) return null;
      target = t.id;
    }
    this.host.cast(spellId, target);
    return [];
  }

  private fellow(args: string): string[] | null {
    const sp = args.search(/\s/);
    const action = (sp < 0 ? args : args.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : args.slice(sp + 1).trim();
    switch (action) {
      case 'create':
        if (!rest) return null;
        this.host.fellowship('create', rest);
        return [];
      case 'open': case 'close': case 'disband': case 'quit':
        this.host.fellowship(action);
        return [];
      case 'recruit': {
        const o = this.find(rest, { landscape: true }, false);
        if (!o) return null;
        this.host.fellowship('recruit', o.id);
        return [];
      }
      default: return null;
    }
  }

  private trade(args: string): string[] | null {
    const sp = args.search(/\s/);
    const action = (sp < 0 ? args : args.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : args.slice(sp + 1).trim();
    if (action === 'add' || action === 'addp') {
      const o = this.find(rest, { inventory: true }, action === 'addp');
      if (!o) return null;
      this.host.trade('add', o.id);
      return [];
    }
    if (action === 'accept' || action === 'decline' || action === 'reset' || action === 'end') {
      this.host.trade(action);
      return [];
    }
    return null;
  }

  private vendor(args: string): string[] | null {
    const v = this.host.vendor();
    if (!v) return null;
    const sp = args.search(/\s/);
    const action = (sp < 0 ? args : args.slice(0, sp)).toLowerCase();
    let rest = sp < 0 ? '' : args.slice(sp + 1).trim();
    const matchIn = (items: readonly MtObject[], name: string, partial: boolean): MtObject | null => {
      const want = name.toLowerCase();
      return items.find((o) => o.name.toLowerCase() === want) ?? (partial ? items.find((o) => o.name.toLowerCase().includes(want)) ?? null : null);
    };
    switch (action) {
      case 'addbuy': case 'addbuyp': {
        let count = 1;
        const n = /^(.*?)\s+(\d+)$/.exec(rest);
        if (n) { rest = n[1]!; count = Number(n[2]); }
        const o = matchIn(v.items, rest, action === 'addbuyp');
        if (!o) return null;
        this.host.vendorAddBuy(o.id, count);
        return [];
      }
      case 'addsell': case 'addsellp': {
        const o = this.find(rest, { inventory: true }, action === 'addsellp');
        if (!o) return null;
        this.host.vendorAddSell(o.id);
        return [];
      }
      case 'buy': case 'clearbuy': case 'sell': case 'clearsell':
        this.host.vendorAction(action);
        return [];
      default: return null;
    }
  }

  /**
   * `/mt opt list|get|set|remember|restore`. Spec §12 #1 (fixed): upstream prints the field name
   * twice (`Set KeyRinger.KeyRinger = False`); we print `<Group>.<Field>`.
   */
  private opt(args: string): string[] | null {
    const o = this.options;
    const parts = args.split(/\s+/).filter(Boolean);
    const action = (parts[0] ?? '').toLowerCase();
    if (action === 'list') return o.list().map((d) => mtLine(`${d.path} ${o.text(d.path)}`));
    const d = parts[1] ? o.def(parts[1]) : null;
    if (!d) return null;
    switch (action) {
      case 'get': return [mtLine(`${d.path} = ${o.text(d.path)}`)];
      case 'set': {
        const value = parts.slice(2).join(' ');
        if (!o.setText(d.path, value)) return [mtLine(`Failed to Set ${d.path} to ${value}`)];
        return [mtLine(`Set ${d.path} = ${o.text(d.path)}`)];
      }
      case 'remember':
        this.remembered.set(d.path, o.text(d.path));
        return [mtLine(`Remembered ${d.path} = ${o.text(d.path)}`)];
      case 'restore': {
        const was = this.remembered.get(d.path);
        if (was === undefined || !o.setText(d.path, was)) return [mtLine(`Failed to Restore ${d.path}`)];
        return [mtLine(`Restored ${d.path} = ${o.text(d.path)}`)];
      }
      default: return null;
    }
  }
}
