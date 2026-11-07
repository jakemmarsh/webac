/**
 * Client preferences whose default differs by era (EraClientRules.optionDefaults,
 * BUG.ac1999-environment-detail-default): kept in this browser per era (one key per EraProfile id),
 * like the Decal plugins switch, never in the every-era `ac_options_settings_v1` blob. Retail kept
 * these in the client's own files (end of retail's UserPreferences ini, the 1999 client's registry
 * blob), so each era's client had its own copy and its own default.
 *
 * An era's entry holds only the values that differ from that era's default, so a player still on
 * the default follows it.
 *
 * Migration from the shared blob. Earlier builds kept these keys in the shared blob, and every save
 * wrote the whole settings dict, the untouched defaults included. A stored value equal to the old
 * every-era default (end of retail's) is therefore indistinguishable from "never chosen", and is
 * read as the era's default. A stored value different from it can only have come from the player
 * changing the row, and is kept as their choice. That legacy value stays in the shared blob
 * unchanged (GameUI.saveOptionsSettings carries it), so an era visited later still finds it; once an
 * era has its own entry, that entry decides.
 */
import type { EraCharacterOption } from '../era/EraFeatures.js';
import { CHARACTER_SETTINGS_ROWS } from './CharacterSettingsModel.js';

type OptionValue = boolean | number | string;

/** The era a read of the options is for: its EraProfile id and its client's defaults (EraClientRules.optionDefaults). */
export interface OptionsEra {
  id: string;
  optionDefaults: Readonly<Record<string, OptionValue>>;
}

const STORE_PREFIX = 'acjs.eraOptions.v1.';

/** The browser-storage key for era `eraId`. */
export function eraOptionsStoreKey(eraId: string): string {
  return `${STORE_PREFIX}${eraId}`;
}

function readStore(storage: () => Storage | null, eraId: string): Record<string, unknown> | null {
  try {
    const raw = storage()?.getItem(eraOptionsStoreKey(eraId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** The era's default for `key`: its own (optionDefaults), else end of retail's. */
function eraDefault(key: string, eraDefaults: Readonly<Record<string, OptionValue>>, universal: Readonly<Record<string, OptionValue>>): OptionValue | undefined {
  return Object.prototype.hasOwnProperty.call(eraDefaults, key) ? eraDefaults[key] : universal[key];
}

/**
 * The values of `keys` for era `eraId`: the era's own entry when it has one, else the player's
 * definite choice from the shared blob (`legacy`, a value other than the old every-era default
 * `universal`), else the era's default. Blocked or broken storage reads as the defaults.
 */
export function readEraOptionValues(
  storage: () => Storage | null,
  eraId: string,
  keys: readonly string[],
  eraDefaults: Readonly<Record<string, OptionValue>>,
  universal: Readonly<Record<string, OptionValue>>,
  legacy: Readonly<Record<string, unknown>> | null,
): Record<string, OptionValue> {
  const stored = readStore(storage, eraId);
  const out: Record<string, OptionValue> = {};
  for (const key of keys) {
    const def = eraDefault(key, eraDefaults, universal);
    if (def === undefined) continue;
    const v = stored ? stored[key] : legacy?.[key];
    const usable = typeof v === typeof def && (stored !== null || v !== universal[key]);
    out[key] = usable ? v as OptionValue : def;
  }
  return out;
}

/** Keep era `eraId`'s values of `keys` (only those off the era's default). A failed write leaves them for this page only. */
export function writeEraOptionValues(
  storage: () => Storage | null,
  eraId: string,
  keys: readonly string[],
  eraDefaults: Readonly<Record<string, OptionValue>>,
  universal: Readonly<Record<string, OptionValue>>,
  values: Readonly<Record<string, OptionValue>>,
): void {
  const entry: Record<string, OptionValue> = {};
  for (const key of keys) {
    const def = eraDefault(key, eraDefaults, universal);
    const v = values[key];
    if (def !== undefined && typeof v === typeof def && v !== def) entry[key] = v;
  }
  try { storage()?.setItem(eraOptionsStoreKey(eraId), JSON.stringify(entry)); } catch { /* storage blocked */ }
}

/**
 * What an era client's Character-page Defaults sets each row of its page to, from the options_ word
 * it writes (EraClientRules.characterDefaultsWord), by optionsSettings key. A row's bit is its
 * era-only mask (EraCharacterOption.options1Mask) or its end-of-retail options1 mask. The stored
 * value is the bit itself; an inverted row only shows it the other way.
 */
export function eraCharacterPageDefaults(page: readonly EraCharacterOption[], word: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const o of page) {
    const row = o.ourKey ? undefined : CHARACTER_SETTINGS_ROWS.find((r) => r.playerOption === o.playerOption);
    const key = o.ourKey ?? row?.ourKey;
    const mask = o.options1Mask ?? (row?.pref.field === 'options1' ? row.pref.mask : undefined);
    if (!key || mask === undefined) continue;
    out[key] = ((word >>> 0) & mask) !== 0;
  }
  return out;
}
