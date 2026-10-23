/**
 * The era client's world and pre-world presentation values (SWEEP1999.world): the parts of
 * `eraClientRules()` that the landscape, the sky, the UI sounds, character select and chargen
 * read. End of retail (and the classic eras, which run its exe) keep today's values; the 1999
 * entry holds what the 1999 client.exe did (reference/ac1999/Client/decomp, client.exe
 * disassembly). One table, no era checks in the panels (docs/ac1999-support.md).
 */
import { Sound } from '@ac/shared';

/** The chargen "you have unspent credits" requesters (gmCharGenMainUI::DoFinish / the 1999 CG pages). */
export interface ChargenCreditWarnings {
  /**
   * FINISH with attribute credits left. End of retail: ID_CharGen_CreditWarning (a string-table
   * token, read by GameUI); 1999: CharGen_OnCreateConfirm @ 0x567980's literal.
   */
  attributes: string | null;
  /** FINISH with skill (training) credits left: 1999 only (OnCreateConfirm, after the attribute check). */
  trainingAtFinish: string | null;
  /** The Skills page's Next with training credits left: 1999 only (CG_8 ListenToMessage, its ctor's requester). */
  trainingAtSkillsNext: string | null;
  /** The requesters' chime: 1999 UI_GeneralQuery 0x6C at each (end of retail plays none). */
  sound: Sound | null;
}

export interface EraWorldRules {
  /**
   * What the Config page's brightness slider drives. End of retail: Render.ScreenBrightness, a gamma
   * ramp (ui/ScreenGamma.ts), and LScape::min_ambient is the constant 0.2. 1999: there is no gamma
   * slider; the Performance panel's brightness b (0..1, default 0.5) goes to SmartBox_SetBrightness
   * @ 0x40df93 → LScape_SetMinBrightness @ 0x441d91, `min_ambient = b * 0.3 + 0.2` (0.35 at the
   * default), the floor LScape_UseTime @ 0x442242 holds the region ambient to (every 1999 day
   * group's amb_bright is 0.3, so the floor always wins).
   */
  brightness: { gamma: boolean; minAmbientBase: number; minAmbientPerBrightness: number };
  /**
   * Client-local UI sounds the era plays beyond end of retail's own (audio/RetailLocalSounds.ts).
   * 1999 (each through SoundManager_PlaySoundFromCenter, gated on UI_GetUISoundsEnabled): 0x6C
   * GeneralQuery (chargen refusals and warnings), 0x6D GeneralError (create refused,
   * CG_10_UI_Global_Loop; the research panel's magic-mode refusal), 0x6E TransientMessage (every
   * urgent status line, UI_PlayTransientMessageSound @ 0x4cccc0), 0x6F / 0x70 / 0x71 icon pick-up /
   * drop / refused drop (ItemSlot / ItemList / ShopList / ShortcutSlot / InventoryPanel
   * ReleaseDragObject and DropNotify), 0x74 slider release (the UI ctor's `mov ecx,0x74` @ 0x4c6134
   * into the slider sound @ 0x656b6c, played by the slider's release @ 0x4945b0) and 0x75
   * NewTargetSelected (PanelUI_SetSelectedItem @ 0x4fcb20, a change to a non-zero selection).
   */
  localUiSounds: readonly Sound[];
  /**
   * Every button plays UI_ButtonPress on its press. 1999: the UI ctor stores 0x72 (`mov ecx,0x72`
   * @ 0x4c612a) as the global press sound @ 0x656400 that every button class's press @ 0x4516e0
   * plays. End of retail: only the elements whose LayoutDesc pressed state carries Sound media
   * (ui/LayoutPressSound.ts).
   */
  pressSoundOnEveryButton: boolean;
  chargenCreditWarnings: ChargenCreditWarnings;
  /**
   * A fixed landscape radius in landblocks, or null for the Config page's Landscape Draw Distance.
   * 1999: LScape_ctor @ 0x441b42 calls SetMidRadius(5) and the client has no draw-distance option
   * (only the `@render radius` debug command), so its world is an 11 x 11 grid.
   */
  fixedLandscapeRadius: number | null;
  /**
   * The text a character pending deletion shows in place of its name, or null for the name (end of
   * retail: the name in red, CharacterSet::GetGreyedOutFor). 1999: IntroUI_Update @ 0x504e80 /
   * CharSlot_SetAvailable @ 0x505b10 write "Temporarily Unavailable", the row cannot be selected,
   * and the slot is cleared locally when its deleteTimeout counts out (CharList_ClearEntry).
   */
  pendingDeleteRowText: string | null;
  /**
   * After the server accepts a new character. End of retail: the new character enters the world
   * (m_bAwaitingCharSetForLogin). 1999: CG_10_UI_Global_Loop's code-1 path runs
   * CharGenState_Reset and Game_SetUIMode(2): back to character select.
   */
  afterCharacterCreate: 'enterWorld' | 'characterSelect';
  /**
   * The selection blink's end count in SelectionLighting's numbering (it starts at 1, HIGH). End of
   * retail: 5 (HIGH, LOW, HIGH, LOW, restore). 1999: ItemHolder's loop @ 0x59de50 starts at 0 and
   * toggles while ++count < 2 (0x0059fa90 sets HIGH, count 0): HIGH, LOW, restore = 3 here.
   */
  selectionFlipEndCount: number;
  /**
   * Sky objects move only on the landscape tick (sky_info.tick_size, 0.8 s). 1999: LScape_UseTime
   * @ 0x442242 calls GameSky_UseTime inside its next_tick gate, so the sun and moon step. End of
   * retail runs GameSky::UseTime every frame.
   */
  skyObjectsOnTick: boolean;
  /**
   * The hourglass while an inventory request is pending. 1999: PanelUI_Global_Loop raises the busy
   * count while ACCWeenieObject_get_prevRequest() is non-zero and drops it when the request clears.
   * End of retail has no such site (ui/BusyCount.ts).
   */
  inventoryRequestBusy: boolean;
  /**
   * The chat log's cap: past `max` entries the oldest go until `trimTo` remain. End of retail: ours,
   * 100 / 100 (FAITHFUL.267). 1999: PanelUI_AddTextToScroll @ 0x4f9b70 deletes the first 100 once
   * it holds more than 300.
   */
  chatHistory: { max: number; trimTo: number };
}

export const EOR_WORLD_RULES: EraWorldRules = Object.freeze({
  brightness: Object.freeze({ gamma: true, minAmbientBase: 0.2, minAmbientPerBrightness: 0 }),
  localUiSounds: Object.freeze([]),
  pressSoundOnEveryButton: false,
  chargenCreditWarnings: Object.freeze({ attributes: null, trainingAtFinish: null, trainingAtSkillsNext: null, sound: null }),
  fixedLandscapeRadius: null,
  pendingDeleteRowText: null,
  afterCharacterCreate: 'enterWorld' as const,
  selectionFlipEndCount: 5,
  skyObjectsOnTick: false,
  inventoryRequestBusy: false,
  chatHistory: Object.freeze({ max: 100, trimTo: 100 }),
});

export const AC1999_WORLD_RULES: EraWorldRules = Object.freeze({
  brightness: Object.freeze({ gamma: false, minAmbientBase: 0.2, minAmbientPerBrightness: 0.3 }),
  localUiSounds: Object.freeze([
    Sound.UI_GeneralQuery, Sound.UI_GeneralError, Sound.UI_TransientMessage,
    Sound.UI_IconPickUp, Sound.UI_IconSuccessfulDrop, Sound.UI_IconInvalid_Drop,
    Sound.UI_ReleaseSlider, Sound.UI_NewTargetSelected,
  ]),
  pressSoundOnEveryButton: true,
  // The literals' leading layout newlines are dropped (as spellDeleteConfirm's).
  chargenCreditWarnings: Object.freeze({
    attributes: "You have not spent all your Attribute Credits.  If you don't spend them during character creation, you will lose them.  Create this character anyway?",
    trainingAtFinish: "You have not spent all your Training Credits.  If you don't spend them during character creation, you will lose them.  Create this character anyway?",
    trainingAtSkillsNext: "You have not spent all your Training Credits.  If you don't spend them during character creation, you will lose them.  Do you want to continue?",
    sound: Sound.UI_GeneralQuery,
  }),
  fixedLandscapeRadius: 5,
  pendingDeleteRowText: 'Temporarily Unavailable',
  afterCharacterCreate: 'characterSelect' as const,
  selectionFlipEndCount: 3,
  skyObjectsOnTick: true,
  inventoryRequestBusy: true,
  chatHistory: Object.freeze({ max: 300, trimTo: 200 }),
});

/** LScape min_ambient for the brightness slider's value `pref` (Render.ScreenBrightness, -1..1). */
export function landscapeMinAmbient(rules: EraWorldRules, pref: number): number {
  const b = Math.max(0, Math.min(1, ((Number.isFinite(pref) ? pref : 0) + 1) / 2));
  return rules.brightness.minAmbientBase + rules.brightness.minAmbientPerBrightness * b;
}

/** Whether the Config page lists Landscape Draw Distance (not on a fixed-radius era: 1999 had no such option). */
export function landscapeDrawDistanceOption(rules: EraWorldRules): boolean {
  return rules.fixedLandscapeRadius === null;
}

/** The landscape radius the era draws: its fixed one, else the player's choice. */
export function eraLandscapeRadius(rules: EraWorldRules, chosen: number): number {
  return rules.fixedLandscapeRadius ?? chosen;
}

/** Trim a chat log's children to the era's history cap. */
export function trimChatLog(log: Element, cap: EraWorldRules['chatHistory']): void {
  if (log.children.length <= cap.max) return;
  while (log.children.length > cap.trimTo) log.removeChild(log.children[0]);
}

/**
 * Every UI sound some era's client plays on its own beyond end of retail's: the shared call sites
 * ask for these, and an era whose client never played one skips it quietly.
 */
export const ERA_OPTIONAL_UI_SOUNDS: ReadonlySet<Sound> = new Set(AC1999_WORLD_RULES.localUiSounds);
