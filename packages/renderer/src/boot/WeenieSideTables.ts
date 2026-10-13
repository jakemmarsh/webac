/**
 * The three wcid-keyed weenie side-files (tools/export-weenie-setups.ts):
 * combat style (PropertyInt 46, bow/crossbow → LeftHand), attack type (47,
 * swing animation) and weapon time (49, melee swing speed).
 *
 * BOOT.side-tables-off-critical-path (2026-10-13): main() used to fetch them
 * one after another, with no timeout, after the data patch. A UK visitor on a
 * cold CDN edge sat ~25 s in the `side_tables` boot stage for 53 KB of JSON.
 * Now the fetches start together as soon as the era is known, run beside the
 * patch download, and boot waits for them only until SIDE_TABLE_WAIT_MS after
 * they started. Boot then goes on with whatever arrived.
 *
 * Late arrival is safe: each table fills the same Map the game reads, and
 * every reader looks the wcid up at use time (equippedWeaponAttackType /
 * equippedWeaponSpeed on each swing, wieldLocationFromMask on each wield).
 * A table that is still missing at a lookup gives that lookup's existing
 * default (RightHand, thrust/slash, the unarmed speed), exactly as a 404 did
 * before. The one lasting effect: a missile weapon attached before the
 * combat-style table landed keeps RightHand until it is next wielded, and
 * only when its CreateObject carried no Parent block (the server's
 * ParentLocation wins over the table everywhere).
 */
import { CombatStyle, EquipMask, ParentLocation } from '@ac/shared';

export type WeenieSideTableKey = 'combatStyles' | 'attackTypes' | 'weaponTimes';

export interface WeenieSideTableSpec {
  key: WeenieSideTableKey;
  /** Path under the asset base (assetUrl). */
  path: string;
  /** What one entry maps a wcid to, for the log line. */
  label: string;
  /** What the game does while the table is missing. */
  fallback: string;
}

export const WEENIE_SIDE_TABLES: readonly WeenieSideTableSpec[] = [
  { key: 'combatStyles', path: '/weenie-combat-styles.json', label: 'combatStyle', fallback: 'bow/crossbow routing will fall back to RightHand' },
  { key: 'attackTypes', path: '/weenie-attack-types.json', label: 'attackType', fallback: 'weapon swings will use thrust/slash defaults' },
  { key: 'weaponTimes', path: '/weenie-weapon-time.json', label: 'weaponTime', fallback: 'melee swing speed will use the unarmed default' },
];

/** How long boot waits for the tables, counted from when their fetches started. */
export const SIDE_TABLE_WAIT_MS = 8000;

export type WeenieSideTableStatus = 'pending' | 'loaded' | 'missing' | 'skipped';

export interface WeenieSideTables {
  readonly combatStyles: Map<number, number>;
  readonly attackTypes: Map<number, number>;
  readonly weaponTimes: Map<number, number>;
  /** Each table's state right now. */
  status(): Record<WeenieSideTableKey, WeenieSideTableStatus>;
  /** Resolves once every fetch has finished (loaded or missing); never rejects. */
  readonly settled: Promise<void>;
  /**
   * Wait for every table, but no later than `startedAt + waitMs`. Resolves
   * true when all settled in time; false when boot goes on without some
   * (those keep loading and apply when they arrive).
   */
  waitForBoot(waitMs?: number): Promise<boolean>;
}

export interface WeenieSideTableOptions {
  /** Absolute URL for a side-table path (assetUrl(runtimeConfig, path)). */
  url: (path: string) => string;
  fetchFn?: (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
  log?: Pick<Console, 'log' | 'warn'>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

function tablesFrom(maps: Record<WeenieSideTableKey, Map<number, number>>, state: Record<WeenieSideTableKey, WeenieSideTableStatus>,
  settled: Promise<void>, waitForBoot: WeenieSideTables['waitForBoot']): WeenieSideTables {
  return {
    combatStyles: maps.combatStyles,
    attackTypes: maps.attackTypes,
    weaponTimes: maps.weaponTimes,
    status: () => ({ ...state }),
    settled,
    waitForBoot,
  };
}

/** No tables (an era whose wcids are not end of retail's: every lookup takes its default). */
export function skippedWeenieSideTables(): WeenieSideTables {
  const maps = { combatStyles: new Map(), attackTypes: new Map(), weaponTimes: new Map() };
  const state = { combatStyles: 'skipped', attackTypes: 'skipped', weaponTimes: 'skipped' } as const;
  return tablesFrom(maps, { ...state }, Promise.resolve(), async () => true);
}

/** Start all three fetches now, in parallel; the returned maps fill as each arrives. */
export function startWeenieSideTables(opts: WeenieSideTableOptions): WeenieSideTables {
  const fetchFn = opts.fetchFn ?? ((u: string) => fetch(u));
  const log = opts.log ?? console;
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const startedAt = now();
  const maps: Record<WeenieSideTableKey, Map<number, number>> = {
    combatStyles: new Map(), attackTypes: new Map(), weaponTimes: new Map(),
  };
  const state: Record<WeenieSideTableKey, WeenieSideTableStatus> = {
    combatStyles: 'pending', attackTypes: 'pending', weaponTimes: 'pending',
  };
  /** Set once boot stopped waiting: a table landing after it says so. */
  let bootMovedOn = false;

  const one = async (spec: WeenieSideTableSpec): Promise<void> => {
    const file = spec.path.replace(/^\//, '');
    try {
      const resp = await fetchFn(opts.url(spec.path));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as Record<string, number>;
      const map = maps[spec.key];
      for (const [k, v] of Object.entries(data)) map.set(Number(k), v);
      state[spec.key] = 'loaded';
      const late = bootMovedOn ? ` (${Math.round(now() - startedAt)} ms after its fetch began, after boot moved on — applied now)` : '';
      log.log(`[AC] Loaded ${map.size} weenie → ${spec.label} entries${late}`);
    } catch (e) {
      state[spec.key] = 'missing';
      log.warn(`[AC] ${file} not loaded (${e instanceof Error ? e.message : String(e)}) — ${spec.fallback}`);
    }
  };
  const settled = Promise.all(WEENIE_SIDE_TABLES.map(one)).then(() => undefined);

  const waitForBoot = (waitMs = SIDE_TABLE_WAIT_MS): Promise<boolean> => {
    const left = startedAt + waitMs - now();
    let timer: unknown = null;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimer(() => resolve(false), Math.max(0, left));
    });
    return Promise.race([settled.then(() => true), timeout]).then((done) => {
      if (timer !== null) clearTimer(timer);
      if (!done) {
        bootMovedOn = true;
        const pending = WEENIE_SIDE_TABLES.filter((s) => state[s.key] === 'pending').map((s) => s.path.replace(/^\//, ''));
        log.warn(`[AC] boot not waiting longer than ${waitMs} ms for ${pending.join(', ')} — they apply when they arrive; until then ${WEENIE_SIDE_TABLES.filter((s) => state[s.key] === 'pending').map((s) => s.fallback).join('; ')}`);
      }
      return done;
    });
  };

  return tablesFrom(maps, state, settled, waitForBoot);
}

/**
 * Map an EquipMask slot (+ the item's wcid) to the ParentLocation it attaches
 * at, anchored to ACViewer Creature_Equipment.cs:60-101 GetPlacementLocation:
 * melee / held / two-handed → RightHand; a missile weapon → LeftHand for a
 * bow or crossbow (ACE CombatStyle Bow 0x10 / Crossbow 0x20, from the
 * combat-style table), else RightHand (atlatl, thrown, sling); a shield →
 * Shield; every other slot → None (armor uses animPartChanges). The table
 * is read at the call, so one that lands late applies to the next wield.
 */
export function wieldLocationFromMask(slot: number, wcid: number | undefined, combatStyles: ReadonlyMap<number, number>): ParentLocation {
  switch (slot) {
    case EquipMask.MeleeWeapon:
    case EquipMask.Held:
    case EquipMask.TwoHanded:
      return ParentLocation.RightHand;
    case EquipMask.MissileWeapon: {
      const cs = wcid ? combatStyles.get(wcid) ?? 0 : 0;
      return (cs & (CombatStyle.Bow | CombatStyle.Crossbow)) !== 0
        ? ParentLocation.LeftHand
        : ParentLocation.RightHand;
    }
    case EquipMask.Shield:
      return ParentLocation.Shield;
    default:
      return ParentLocation.None;
  }
}
