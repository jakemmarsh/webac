/**
 * FAITHFUL.570 — restore server-persisted CharacterOptions1 + CharacterOptions2
 * from PlayerDescription into the local optionsSettings dict on every login.
 *
 * FAITHFUL.372 wired the SAVE side: toggling a row in the Options panel ships
 * `SetSingleCharacterOption` → ACE persists into the player row's
 * `CharacterOptions1`/`CharacterOptions2` columns. The LOAD side was missing:
 * PlayerDescriptionParser dropped both bitfields silently, so `optionsSettings`
 * came up at its built-in DEFAULTS every login and ACE's authoritative server-
 * side state got overwritten the next time any toggle fired.
 *
 * Pre-fix visible bug: a player who turned OFF "Show Helm" on machine A,
 * logged out, logged in on machine B — helm rendered visible until they
 * re-toggled. Same for ShowCloak, AcceptLootPermits, AutoTarget, weather,
 * fog, mouse-turning, daylight-clamp, LockUI, the 7 chat-listen toggles, etc.
 *
 * Wire format per ACE `GameEventPlayerDescription.cs:341-394`:
 *   uint optionFlags                          (CharacterOptionDataFlag bits)
 *   uint CharacterOptions1                    (UNCONDITIONAL, line 359)
 *   if (Shortcut bit):    Shortcut PHashTable
 *   if (SpellLists8 bit): 8 × (count + spellIds)  else: u32 0u
 *   if (DesiredComps bit): PHashTable header u16+u16 + N × (u32+u32)
 *   uint SpellbookFilters                     (UNCONDITIONAL — `if` commented out)
 *   if (CharacterOptions2 bit): uint CharacterOptions2  (ACE always sets the bit)
 *
 * Per-option bit decode lives in `@ac/shared`'s
 * `CHARACTER_OPTION_BIT_MAP` + `characterOptionIsSet(opt, co1, co2)`, sourced
 * directly from `reference/ACE/Source/ACE.Entity/Enum/CharacterOption.cs` and
 * the two `CharacterOptions{1,2}` Flags enums in `ace-enums.ts`.
 *
 * Restore happens in `GameUI.restoreCharacterOptions(co1, co2)` which returns
 * the list of optionsSettings keys whose value flipped; main.ts mirrors the
 * client-rendered side-effects (FAITHFUL.373/440/484/490/492/495) so the
 * camera/weather/fog/skybox/etc. systems pick up the restored state without
 * waiting for the user to re-toggle.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser';
import { applyLocalOptionEffects, LOCAL_EFFECT_OPTION_KEYS, type LocalOptionSinks } from '../packages/renderer/src/ui/LocalOptionEffects.js';
import {
  CHARACTER_OPTION_BIT_MAP,
  CharacterOptions1,
  CharacterOptions2,
  characterOptionIsSet,
} from '@ac/shared';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const PARSER = readFileSync(resolve(REPO, 'packages/renderer/src/network/PlayerDescriptionParser.ts'), 'utf-8');
const GAMEUI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf-8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');
const SHARED_ENUMS = readFileSync(resolve(REPO, 'packages/shared/src/ace-enums.ts'), 'utf-8');
const ACE_PD = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventPlayerDescription.cs'), 'utf-8');
const ACE_CO = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CharacterOption.cs'), 'utf-8');
const ACE_OPT_FLAG = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CharacterOptionDataFlag.cs'), 'utf-8');

/* ================================================================ */
/*  Shared map + helper                                              */
/* ================================================================ */

describe('FAITHFUL.570 — CHARACTER_OPTION_BIT_MAP + characterOptionIsSet helper', () => {
  it('CHARACTER_OPTION_BIT_MAP has all 53 entries (0x00..0x34)', () => {
    const keys = Object.keys(CHARACTER_OPTION_BIT_MAP).map(k => parseInt(k, 10));
    expect(keys).toHaveLength(53);
    expect(Math.min(...keys)).toBe(0x00);
    expect(Math.max(...keys)).toBe(0x34);
  });

  it('every entry has either field=1 or field=2 and a non-zero mask', () => {
    for (const [optStr, m] of Object.entries(CHARACTER_OPTION_BIT_MAP)) {
      expect([1, 2]).toContain(m.field);
      expect(m.mask).toBeGreaterThan(0);
      // optStr just needs to be a valid integer; sanity-check it.
      expect(Number.isFinite(parseInt(optStr, 10))).toBe(true);
    }
  });

  it('spot-check key bit assignments per ACE CharacterOption.cs', () => {
    // ShowHelm 0x2F → CO2 ShowHelm (0x00100000)
    expect(CHARACTER_OPTION_BIT_MAP[0x2F]).toEqual({ field: 2, mask: CharacterOptions2.ShowHelm });
    // LockUI 0x33 → CO2 LockUI (0x01000000)
    expect(CHARACTER_OPTION_BIT_MAP[0x33]).toEqual({ field: 2, mask: CharacterOptions2.LockUI });
    // RunAsDefault 0x0A → CO1 ToggleRun (0x00000400)
    expect(CHARACTER_OPTION_BIT_MAP[0x0A]).toEqual({ field: 1, mask: CharacterOptions1.ToggleRun });
    // AutoRepeat 0x00 → CO1 AutoRepeatAttack (0x00000002)
    expect(CHARACTER_OPTION_BIT_MAP[0x00]).toEqual({ field: 1, mask: CharacterOptions1.AutoRepeatAttack });
    // AutoTarget 0x0D → CO1 AutoTarget (0x00002000)
    expect(CHARACTER_OPTION_BIT_MAP[0x0D]).toEqual({ field: 1, mask: CharacterOptions1.AutoTarget });
    // DisableMostWeatherEffects 0x04 → CO1 DisableMostWeatherEffects (0x00010000)
    expect(CHARACTER_OPTION_BIT_MAP[0x04]).toEqual({ field: 1, mask: CharacterOptions1.DisableMostWeatherEffects });
    // AlwaysDaylightOutdoors 0x05 → CO2 PersistentAtDay (0x00000001)
    expect(CHARACTER_OPTION_BIT_MAP[0x05]).toEqual({ field: 2, mask: CharacterOptions2.PersistentAtDay });
    // UseMouseTurning 0x31 → CO2 UseMouseTurning (0x00400000)
    expect(CHARACTER_OPTION_BIT_MAP[0x31]).toEqual({ field: 2, mask: CharacterOptions2.UseMouseTurning });
    // DisableDistanceFog 0x30 → CO2 DisableDistanceFog (0x00200000)
    expect(CHARACTER_OPTION_BIT_MAP[0x30]).toEqual({ field: 2, mask: CharacterOptions2.DisableDistanceFog });
  });

  it('characterOptionIsSet returns true when the corresponding bit is set', () => {
    // ShowHelm bit set in CO2 only
    expect(characterOptionIsSet(0x2F, 0, CharacterOptions2.ShowHelm)).toBe(true);
    // ShowHelm bit not set
    expect(characterOptionIsSet(0x2F, 0xFFFFFFFF, 0)).toBe(false);
    // ToggleRun bit set in CO1 only
    expect(characterOptionIsSet(0x0A, CharacterOptions1.ToggleRun, 0)).toBe(true);
    // Check we don't cross fields: CO2 bit shouldn't trigger a CO1 option lookup.
    expect(characterOptionIsSet(0x0A, 0, 0xFFFFFFFF)).toBe(false);
  });

  it('characterOptionIsSet returns false for unknown option ints', () => {
    expect(characterOptionIsSet(0xFF, 0xFFFFFFFF, 0xFFFFFFFF)).toBe(false);
    expect(characterOptionIsSet(-1, 0xFFFFFFFF, 0xFFFFFFFF)).toBe(false);
  });

  it('shared ace-enums.ts docblock cites ACE CharacterOption.cs source', () => {
    expect(SHARED_ENUMS).toMatch(/CHARACTER_OPTION_BIT_MAP/);
    expect(SHARED_ENUMS).toMatch(/CharacterOption\.cs/);
    expect(SHARED_ENUMS).toMatch(/FAITHFUL\.570/);
  });
});

/* ================================================================ */
/*  PlayerDescriptionParser                                          */
/* ================================================================ */

describe('FAITHFUL.570 — PlayerDescriptionResult surfaces CO1/CO2/SpellbookFilters', () => {
  it('PlayerDescriptionResult type has characterOptions1, characterOptions2, spellbookFilters', () => {
    expect(PARSER).toMatch(/characterOptions1:\s*number/);
    expect(PARSER).toMatch(/characterOptions2:\s*number/);
    expect(PARSER).toMatch(/spellbookFilters:\s*number/);
  });

  it('docblock cites ACE GameEventPlayerDescription.cs:359,387 (CO1 + CO2 emit sites)', () => {
    expect(PARSER).toMatch(/GameEventPlayerDescription\.cs:359,387/);
  });

  it('default result initializes all three to -1 (sentinel "not received")', () => {
    expect(PARSER).toMatch(/characterOptions1:\s*-1/);
    expect(PARSER).toMatch(/characterOptions2:\s*-1/);
    expect(PARSER).toMatch(/spellbookFilters:\s*-1/);
  });

  it('parser surfaces CO1 unconditionally (per ACE line 359)', () => {
    expect(PARSER).toMatch(/result\.characterOptions1 = r\.readUInt32\(\)/);
  });

  it('parser reads SpellbookFilters unconditionally (per ACE line 384 — `if` commented out)', () => {
    expect(PARSER).toMatch(/result\.spellbookFilters = r\.readUInt32\(\)/);
  });

  it('parser gates CO2 read on CHAR_OPT_CHARACTER_OPT2 bit (0x40)', () => {
    expect(PARSER).toMatch(/CHAR_OPT_CHARACTER_OPT2[\s\S]+?0x00000040/);
    expect(PARSER).toMatch(/if \(optionFlags & CHAR_OPT_CHARACTER_OPT2\)/);
    expect(PARSER).toMatch(/result\.characterOptions2 = r\.readUInt32\(\)/);
  });

  it('parser reads DesiredComps PHashTable entries when bit set (VISUAL.134, per ACE WriteOld)', () => {
    // VISUAL.134 — was r.skip(fillCount*8); now reads each 8-byte entry
    // (SpellComponentId u32 + QuantityToRebuy u32) into result.desiredComps.
    // Consumes the same fillCount*8 bytes, so the rest of the walk stays aligned
    // (the synthetic-roundtrip test below proves spellbookFilters still parses).
    expect(PARSER).toMatch(/CHAR_OPT_DESIRED_COMPS/);
    expect(PARSER).toMatch(/for \(let i = 0; i < fillCount; i\+\+\)/);
    expect(PARSER).toMatch(/result\.desiredComps\.set\(wcid, qty\)/);
  });
});

/* ================================================================ */
/*  Synthetic-payload roundtrip                                      */
/* ================================================================ */

describe('FAITHFUL.570 — synthetic PlayerDescription roundtrip restores CO1/CO2', () => {
  /** Build the minimal PlayerDescription header preceding optionFlags. */
  function buildBase(): { dv: DataView; buf: ArrayBuffer; pos: () => number; w32: (v: number) => void; w16: (v: number) => void } {
    const buf = new ArrayBuffer(4096);
    const dv = new DataView(buf);
    let p = 0;
    const w32 = (v: number) => { dv.setUint32(p, v >>> 0, true); p += 4; };
    const w16 = (v: number) => { dv.setUint16(p, v, true); p += 2; };
    // Pre-optionFlags header — propertyFlags + weenieType + vectorFlags + _hasHealth.
    w32(0); w32(0); w32(0); w32(0);
    return { dv, buf, pos: () => p, w32, w16 };
  }

  it('parser captures CO1 + CO2 + spellbookFilters from a payload with all option bits set', () => {
    const b = buildBase();
    // optionFlags = SpellLists8 (0x400) | CharacterOptions2 (0x40)
    b.w32(0x400 | 0x40);
    // CO1 = ToggleRun | AutoTarget | DisableMostWeatherEffects
    const co1 = CharacterOptions1.ToggleRun | CharacterOptions1.AutoTarget | CharacterOptions1.DisableMostWeatherEffects;
    b.w32(co1 >>> 0);
    // SpellLists8: 8 empty bars (count=0 each).
    for (let i = 0; i < 8; i++) b.w32(0);
    // SpellbookFilters = 0xABCD1234
    b.w32(0xABCD1234);
    // CharacterOptions2 = ShowHelm | LockUI | DisableDistanceFog
    const co2 = CharacterOptions2.ShowHelm | CharacterOptions2.LockUI | CharacterOptions2.DisableDistanceFog;
    b.w32(co2 >>> 0);

    const payload = new Uint8Array(b.buf, 0, b.pos());
    const result = parsePlayerDescription(payload);

    expect(result).not.toBeNull();
    expect(result!.characterOptions1 >>> 0).toBe(co1 >>> 0);
    expect(result!.characterOptions2 >>> 0).toBe(co2 >>> 0);
    expect(result!.spellbookFilters >>> 0).toBe(0xABCD1234);
  });

  it('parser leaves CO2 = -1 when the CharacterOptions2 bit is not set', () => {
    const b = buildBase();
    b.w32(0x400);                                // optionFlags = SpellLists8 only
    b.w32(0x12345678);                           // CO1
    for (let i = 0; i < 8; i++) b.w32(0);        // SpellLists8 empty bars
    b.w32(0xDEADBEEF);                           // SpellbookFilters

    const payload = new Uint8Array(b.buf, 0, b.pos());
    const result = parsePlayerDescription(payload);

    expect(result).not.toBeNull();
    expect(result!.characterOptions1 >>> 0).toBe(0x12345678);
    expect(result!.characterOptions2).toBe(-1);
    expect(result!.spellbookFilters >>> 0).toBe(0xDEADBEEF);
  });

  it('parser reads DesiredComps PHashTable entries between SpellLists8 and SpellbookFilters', () => {
    const b = buildBase();
    // optionFlags = SpellLists8 (0x400) | DesiredComps (0x08) | CharacterOptions2 (0x40)
    b.w32(0x400 | 0x08 | 0x40);
    b.w32(0xC0C0C0C0);                           // CO1
    for (let i = 0; i < 8; i++) b.w32(0);        // SpellLists8 empty bars
    // DesiredComps: count=3, buckets=256, then 3 × (SpellComponentId u32 + Quantity u32)
    b.w16(3); b.w16(256);
    b.w32(100); b.w32(50);
    b.w32(200); b.w32(75);
    b.w32(300); b.w32(99);
    b.w32(0xCAFEBABE);                           // SpellbookFilters
    b.w32(0xFEEDFACE);                           // CO2

    const payload = new Uint8Array(b.buf, 0, b.pos());
    const result = parsePlayerDescription(payload);

    expect(result).not.toBeNull();
    expect(result!.characterOptions1 >>> 0).toBe(0xC0C0C0C0);
    expect(result!.spellbookFilters >>> 0).toBe(0xCAFEBABE);
    expect(result!.characterOptions2 >>> 0).toBe(0xFEEDFACE);
    // VISUAL.134 — the 3 fill-comp entries are now captured (wcid → quantity)
    expect(result!.desiredComps.size).toBe(3);
    expect(result!.desiredComps.get(100)).toBe(50);
    expect(result!.desiredComps.get(200)).toBe(75);
    expect(result!.desiredComps.get(300)).toBe(99);
  });
});

/* ================================================================ */
/*  GameUI.restoreCharacterOptions — behavioral                      */
/* ================================================================ */

// restoreCharacterOptions() is a real public method — driven directly
// below via the established happy-dom + private-field-cast idiom
// (layoutRenderer stays null, so renderOptionsPanel's DAT-gated body
// never executes even when optionsPanelVisible is flipped true).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.570 — GameUI.restoreCharacterOptions (behavioral, requires happy-dom devDep)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function freshUI(): any {
    domWindow.document.body.innerHTML = '';
    domWindow.localStorage.clear();
    // GameUI.ts's optionsSettings field initializer returns the literal
    // GameUI.OPTIONS_DEFAULTS object BY REFERENCE when localStorage has no
    // 'ac_options_settings_v1' entry (only the merge branch, taken when an
    // entry exists, produces a fresh `{...DEFAULTS}` copy). Since
    // restoreCharacterOptions mutates optionsSettings in place, an empty
    // localStorage would let one test's mutation leak into the shared
    // static DEFAULTS for every later instance/test in this process. Seed
    // an empty JSON object so every fresh instance always takes the
    // copy-producing merge branch (observably identical to DEFAULTS).
    domWindow.localStorage.setItem('ac_options_settings_v1', '{}');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new GameUICtor(container);
  }

  it('sentinel co1=-1, co2=-1 returns [] and touches nothing', () => {
    const ui = freshUI();
    const before = { ...ui.optionsSettings };
    const changed = ui.restoreCharacterOptions(-1, -1);
    expect(changed).toEqual([]);
    expect(ui.optionsSettings).toEqual(before);
  });

  it('restores a CO1 bit (AutoTarget) and reports it as changed', () => {
    const ui = freshUI();
    expect(ui.optionsSettings.autoTarget).toBe(true); // OPTIONS_DEFAULTS default
    // AutoTarget bit clear in CO1 → server says "off" → local default (true) must flip to false.
    const changed = ui.restoreCharacterOptions(0, -1);
    expect(changed).toContain('autoTarget');
    expect(ui.optionsSettings.autoTarget).toBe(false);
  });

  it('restores a CO2 bit (ShowHelm) and reports it as changed', () => {
    const ui = freshUI();
    expect(ui.optionsSettings.showHelm).toBe(true); // OPTIONS_DEFAULTS default
    // Clear ShowHelm's CO2 bit → server says "off" → local default (true) must flip to false.
    const changed = ui.restoreCharacterOptions(-1, 0);
    expect(changed).toContain('showHelm');
    expect(ui.optionsSettings.showHelm).toBe(false);
  });

  it('returns [] and leaves optionsSettings alone when every bit already matches', () => {
    const ui = freshUI();
    // optionsSettings already equals OPTIONS_DEFAULTS with everything off/on
    // as ACE's zero-bit CO1/CO2 would also represent, EXCEPT showHelm/
    // dragItemToPlayerOpensTrade/etc default true — restoring co1=0,co2=0
    // will flip those, so instead prove idempotence by restoring twice.
    ui.restoreCharacterOptions(CharacterOptions1.AutoTarget, 0);
    const afterFirst = { ...ui.optionsSettings };
    const changed = ui.restoreCharacterOptions(CharacterOptions1.AutoTarget, 0);
    expect(changed).toEqual([]);
    expect(ui.optionsSettings).toEqual(afterFirst);
  });

  it('only the field with a real (non -1) value is consulted — co1=-1 leaves CO1-mapped keys untouched', () => {
    const ui = freshUI();
    const before = ui.optionsSettings.autoTarget;
    // co1 sentinel -1 means "field not received" — must not touch autoTarget
    // (a CO1-mapped key) even though co2 has a real value.
    ui.restoreCharacterOptions(-1, CharacterOptions2.ShowHelm);
    expect(ui.optionsSettings.autoTarget).toBe(before);
  });

  it('persists restored state via saveOptionsSettings (localStorage round-trip)', () => {
    const ui = freshUI();
    ui.restoreCharacterOptions(CharacterOptions1.AutoTarget, -1);
    const stored = JSON.parse(domWindow.localStorage.getItem('ac_options_settings_v1'));
    expect(stored.autoTarget).toBe(true);
  });

  it('does not throw when optionsPanelVisible is true (DAT-free layoutRenderer=null path)', () => {
    const ui = freshUI();
    ui.optionsPanelVisible = true;
    expect(() => ui.restoreCharacterOptions(CharacterOptions1.AutoTarget, 0)).not.toThrow();
  });

  it('docblock cites FAITHFUL.372 (save side) so the LOAD/SAVE pairing is documented', () => {
    expect(GAMEUI).toMatch(/FAITHFUL\.570[\s\S]+?FAITHFUL\.372/);
  });
});

/* ================================================================ */
/*  main.ts onPlayerDescription wiring                               */
/* ================================================================ */

describe('FAITHFUL.570 — main.ts onPlayerDescription calls restoreCharacterOptions', () => {
  it('main.ts invokes gameUI.restoreCharacterOptions(desc.characterOptions1, desc.characterOptions2)', () => {
    expect(MAIN).toMatch(/gameUI\.restoreCharacterOptions\(\s*desc\.characterOptions1,\s*desc\.characterOptions2,?\s*\)/);
  });

  it('main.ts mirrors client-rendered side-effects for changed runAsDefault', () => {
    expect(MAIN).toMatch(/changedOpts\.includes\('runAsDefault'\)[\s\S]+?cameraController\.runIsDefault/);
  });

  it('restored weather / fog / daylight / mouse-turning options reach their effects (applyLocalOptionEffects, inverted where "disable")', () => {
    const calls: Record<string, boolean> = {};
    const sinks: LocalOptionSinks = {
      setWeatherEnabled: (v) => { calls.weather = v; }, setFogEnabled: (v) => { calls.fog = v; },
      setForceDaylight: (v) => { calls.daylight = v; }, setUseMouseTurning: (v) => { calls.turning = v; },
      setRightClickMouseLook: (v) => { calls.rightClick = v; },
    };
    const on = new Set(['disableWeather', 'alwaysDaylight', 'useMouseTurning']);
    applyLocalOptionEffects((k) => on.has(k), sinks);
    expect(calls).toEqual({ weather: false, fog: true, daylight: true, turning: true, rightClick: false });
    for (const k of ['disableWeather', 'disableDistanceFog', 'alwaysDaylight', 'useMouseTurning']) expect(LOCAL_EFFECT_OPTION_KEYS).toContain(k);
  });

  it('main.ts mirrors side-effects for lockUI', () => {
    expect(MAIN).toMatch(/changedOpts\.includes\('lockUI'\)[\s\S]+?LayoutRenderer\.setUILocked/);
  });

  it('main.ts logs the count + list of restored options for diagnostics', () => {
    expect(MAIN).toMatch(/Restored \$\{changedOpts\.length\} character option\(s\)/);
  });

  it('docblock cites FAITHFUL.372 save side + ACE line refs', () => {
    expect(MAIN).toMatch(/FAITHFUL\.570[\s\S]+?FAITHFUL\.372/);
    expect(MAIN).toMatch(/FAITHFUL\.570[\s\S]+?GameEventPlayerDescription\.cs:359,387/);
  });
});

/* ================================================================ */
/*  ACE source still anchors the fix                                  */
/* ================================================================ */

describe('FAITHFUL.570 — ACE source still anchors the fix', () => {
  it('ACE GameEventPlayerDescription.cs still writes CharacterOptions1 unconditionally', () => {
    expect(ACE_PD).toMatch(/Writer\.Write\(Session\.Player\.Character\.CharacterOptions1\)/);
  });

  it('ACE GameEventPlayerDescription.cs still writes CharacterOptions2 gated on the flag bit', () => {
    expect(ACE_PD).toMatch(/if \(\(optionFlags & CharacterOptionDataFlag\.CharacterOptions2\) != 0\)/);
    expect(ACE_PD).toMatch(/Writer\.Write\(Session\.Player\.Character\.CharacterOptions2\)/);
  });

  it('ACE GameEventPlayerDescription.cs still always sets the CharacterOptions2 bit', () => {
    // The blanket assignment at line 341: `var optionFlags = CharacterOptionDataFlag.CharacterOptions2;`
    expect(ACE_PD).toMatch(/var optionFlags = CharacterOptionDataFlag\.CharacterOptions2/);
  });

  it('ACE GameEventPlayerDescription.cs still writes SpellbookFilters unconditionally', () => {
    // The `if (optionFlags & SpellbookFilters)` is commented out at line 383,
    // so the Writer.Write fires every time — anchor that pattern.
    expect(ACE_PD).toMatch(/Writer\.Write\(Session\.Player\.Character\.SpellbookFilters\)/);
  });

  it('ACE CharacterOptionDataFlag still has CharacterOptions2 = 0x40', () => {
    expect(ACE_OPT_FLAG).toMatch(/CharacterOptions2\s*=\s*0x00000040/);
  });

  it('ACE CharacterOptionDataFlag still has DesiredComps = 0x08', () => {
    expect(ACE_OPT_FLAG).toMatch(/DesiredComps\s*=\s*0x00000008/);
  });

  it('ACE CharacterOption.cs still maps ShowHelm = 0x2F to CharacterOptions2.ShowHelm', () => {
    expect(ACE_CO).toMatch(/\[CharacterOptions2\(CharacterOptions2\.ShowHelm\)\][\s\S]+?ShowYourHelmOrHeadGear\s*=\s*0x2F/);
  });

  it('ACE CharacterOption.cs still maps LockUI = 0x33 to CharacterOptions2.LockUI', () => {
    expect(ACE_CO).toMatch(/\[CharacterOptions2\(CharacterOptions2\.LockUI\)\][\s\S]+?LockUI\s*=\s*0x33/);
  });

  it('ACE CharacterOption.cs still maps AutoRepeatAttacks = 0x00 to CharacterOptions1.AutoRepeatAttack', () => {
    expect(ACE_CO).toMatch(/\[CharacterOptions1\(CharacterOptions1\.AutoRepeatAttack\)\][\s\S]+?AutoRepeatAttacks\s*=\s*0x00/);
  });
});
