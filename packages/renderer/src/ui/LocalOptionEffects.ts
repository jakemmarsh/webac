/**
 * The client-side effects of the character options our client renders itself (FAITHFUL.440 /
 * 490 / 492 / 495; SWEEP1999.character). One place applies them at startup and after the
 * server's PlayerDescription restores the options, each from GameUI.optionOn: the value the
 * world's client acts on, so an era's pin (EraClientRules.optionPins) wins over a value another
 * era's session stored (a 1999 world never gets Always Daylight, no-fog or no-weather views it
 * never had, nor Use Mouse Turning; end of retail never gets 1999's Right-click mouselook).
 */

/** Where each option's effect lands (the skybox, the scene fog, the camera controller). */
export interface LocalOptionSinks {
  /** LScape::weather_enabled (DisableMostWeatherEffects, inverted). */
  setWeatherEnabled(enabled: boolean): void;
  /** The scene fog and LScape::m_fFogEnabled (DisableDistanceFog, inverted). */
  setFogEnabled(enabled: boolean): void;
  /** LScape::SetDay (AlwaysDaylightOutdoors / PersistentAtDay). */
  setForceDaylight(on: boolean): void;
  /** UseMouseTurning (CharacterOption 0x31). */
  setUseMouseTurning(on: boolean): void;
  /** The 1999 options page's Right-click mouselook (options_ 0x4000). */
  setRightClickMouseLook(on: boolean): void;
}

/** The option keys whose effects applyLocalOptionEffects sets. */
export const LOCAL_EFFECT_OPTION_KEYS: readonly string[] = [
  'disableWeather', 'disableDistanceFog', 'alwaysDaylight', 'useMouseTurning', 'rightClickMouselook',
];

/** The CharacterOption codes whose toggle has a local effect here, and their GameUI option keys. */
export const LOCAL_EFFECT_OPTION_CODES: Readonly<Record<number, string>> = {
  0x04: 'disableWeather', // DisableMostWeatherEffects — FAITHFUL.440
  0x30: 'disableDistanceFog', // FAITHFUL.490
  0x05: 'alwaysDaylight', // PersistentAtDay — FAITHFUL.492
  0x31: 'useMouseTurning', // FAITHFUL.495
};

/**
 * A toggled CharacterOption's local effect, live (the Options row, @day, a plugin): `value`, unless
 * the era pins the option (EraClientRules.optionPins). Returns whether `option` has one.
 */
export function applyToggledOptionEffect(option: number, value: boolean, pins: Readonly<Record<string, boolean>>, sinks: LocalOptionSinks): boolean {
  const key = LOCAL_EFFECT_OPTION_CODES[option];
  if (!key) return false;
  const on = pins[key] ?? value;
  if (option === 0x04) sinks.setWeatherEnabled(!on);
  else if (option === 0x30) sinks.setFogEnabled(!on);
  else if (option === 0x05) sinks.setForceDaylight(on);
  else sinks.setUseMouseTurning(on);
  return true;
}

/** Apply every local option effect from `optionOn` (GameUI.optionOn). Idempotent. */
export function applyLocalOptionEffects(optionOn: (key: string) => boolean, sinks: LocalOptionSinks): void {
  sinks.setWeatherEnabled(!optionOn('disableWeather'));
  sinks.setFogEnabled(!optionOn('disableDistanceFog'));
  sinks.setForceDaylight(optionOn('alwaysDaylight'));
  sinks.setUseMouseTurning(optionOn('useMouseTurning'));
  sinks.setRightClickMouseLook(optionOn('rightClickMouselook'));
}
