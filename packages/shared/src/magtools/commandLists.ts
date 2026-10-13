/**
 * Mag-Tools' On Login, On Login Complete and Periodic command lists (docs/plugin-specs/magtools.md §2.5,
 * §4, §7.3), rebuilt clean-room: the lists and the editors' rules. Running them is §9.4 (another part).
 *
 * Where they live: the global Mag-Tools store (MtOptionStorage), one JSON value per list, under
 * mtCommandListKey: Tools → Character's lists per account + server + character, Tools → Server's per
 * server (any character on it).
 */
import { mtCommandListKey, type MtCommandList, type MtOptionStorage } from './options.js';

// Tools → Character's / Server's scope and a periodic command: the same types (and stored the same way) as the scheduler's.
import type { MtCommandScope, MtPeriodicCommand } from './loginCommands.js';
export type { MtCommandScope, MtPeriodicCommand };
/** The two plain lists. */
export type MtTextCommandList = Exclude<MtCommandList, 'PeriodicCommands'>;


/** The list columns (AccountServerCharacterGUI): text 224, up / down / delete icons 16 each. */
export const MT_LOGIN_LIST_COLUMNS = [224, 16, 16, 16] as const;
/** The periodic list: text 216, interval 20, offset 20, delete icon 16. */
export const MT_PERIODIC_LIST_COLUMNS = [216, 20, 20, 16] as const;
/** The row icons (portal.dat). */
export const MT_ICON_UP = 0x060028fc;
export const MT_ICON_DOWN = 0x060028fd;
export const MT_ICON_DELETE = 0x060011f8;

export class MtCommandLists {
  constructor(private readonly store: MtOptionStorage) {}

  private read<T>(list: MtCommandList, scope: MtCommandScope): T[] {
    try {
      const raw = this.store.get(mtCommandListKey(list, scope));
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(v) ? (v as T[]) : [];
    } catch { return []; }
  }

  private write(list: MtCommandList, scope: MtCommandScope, v: unknown[]): void {
    this.store.set(mtCommandListKey(list, scope), JSON.stringify(v));
  }

  /** On Login / On Login Complete commands, in order. */
  commands(list: MtTextCommandList, scope: MtCommandScope): string[] {
    return this.read<unknown>(list, scope).filter((c): c is string => typeof c === 'string');
  }

  periodic(scope: MtCommandScope): MtPeriodicCommand[] {
    return this.read<MtPeriodicCommand>('PeriodicCommands', scope)
      .filter((p) => p && typeof p.command === 'string' && Number.isInteger(p.interval) && Number.isInteger(p.offset));
  }

  /** Add: the text box's contents appended (ignored when empty). True when added. */
  add(list: MtTextCommandList, scope: MtCommandScope, text: string): boolean {
    if (text.trim() === '') return false;
    this.write(list, scope, [...this.commands(list, scope), text]);
    return true;
  }

  /**
   * A periodic Add: needs non-empty text, an integer interval > 0 and an integer offset ≥ 0 (as typed in
   * their boxes). True when added.
   */
  addPeriodic(scope: MtCommandScope, text: string, interval: string, offset: string): boolean {
    if (text.trim() === '' || !/^\s*[+-]?\d+\s*$/.test(interval) || !/^\s*[+-]?\d+\s*$/.test(offset)) return false;
    const i = Number(interval), o = Number(offset);
    if (i <= 0 || o < 0) return false;
    this.write('PeriodicCommands', scope, [...this.periodic(scope), { command: text, interval: i, offset: o }]);
    return true;
  }

  private all(list: MtCommandList, scope: MtCommandScope): unknown[] {
    return list === 'PeriodicCommands' ? this.periodic(scope) : this.commands(list, scope);
  }

  /** Swap a row with the one above (ignored at the top). */
  moveUp(list: MtTextCommandList, scope: MtCommandScope, index: number): boolean {
    const l = this.all(list, scope);
    if (index <= 0 || index >= l.length) return false;
    [l[index - 1], l[index]] = [l[index], l[index - 1]];
    this.write(list, scope, l);
    return true;
  }

  /** Swap a row with the one below (ignored at the bottom). */
  moveDown(list: MtTextCommandList, scope: MtCommandScope, index: number): boolean {
    const l = this.all(list, scope);
    if (index < 0 || index >= l.length - 1) return false;
    [l[index], l[index + 1]] = [l[index + 1], l[index]];
    this.write(list, scope, l);
    return true;
  }

  remove(list: MtCommandList, scope: MtCommandScope, index: number): boolean {
    const l = this.all(list, scope);
    if (index < 0 || index >= l.length) return false;
    l.splice(index, 1);
    this.write(list, scope, l);
    return true;
  }
}
