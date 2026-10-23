/**
 * The retail default key bindings + the action-id constants the live input
 * router wires to real handlers.
 *
 * Action ids are the portal.dat ActionMap keys (see KeybindActions.generated.ts).
 * The default physical keys are the EoL portal KeyMap DAT's (0x14000000
 * "gmDefaultMap" + 0x14000002 "DefaultMap", baked by
 * tools/gen-keybind-defaults.mjs into KeybindDefaults.generated.ts —
 * CORE.17.k.b.b.a.g.f). Before that the table here was our own hand-written
 * set (I / B / C / M / P / O / Q for the panels, Tab for combat, NumLock for
 * autorun, S for backward), none of which is retail's: retail opens the
 * panels on F3–F12, toggles combat on ` alone, autoruns on Q, walks backward
 * on X and stops on S.
 */
import { CombatMode } from '@ac/shared';
import { RETAIL_DEFAULT_KEYBINDS } from './KeybindDefaults.generated.js';
import { KEY_REPEAT_ACTIONS } from './KeybindActions.generated.js';

/** Named action ids the router dispatches (subset of the 296 baked commands). */
export const ACT = {
  // Movement (class 1)
  MoveForward: 0x29,
  MoveBackward: 0x2a,
  StopMoving: 0x2b,
  StrafeRight: 0x2c,
  StrafeLeft: 0x2d,
  TurnRight: 0x2e,
  TurnLeft: 0x2f,
  Autorun: 0x30,
  Jump: 0x31,
  ToggleRunWalk: 0x32,
  // Emote input actions that hold a substate (ACCmdInterp::InitializeEmoteInputActionHash @ 0058b510)
  Ready: 0x10000094,
  Crouch: 0x10000095,
  Sitting: 0x10000096,
  Sleeping: 0x10000097,

  // Camera (class 2)
  ZoomCameraIn: 0x33,
  ZoomCameraOut: 0x34,
  RotateCameraLeft: 0x35,
  RotateCameraRight: 0x36,
  RotateCameraUp: 0x37,
  RotateCameraDown: 0x38,
  MoveCameraToDefault: 0x39,
  FirstPersonCamera: 0x3a,
  OverheadView: 0x3b,
  MapView: 0x3c,
  ToggleMouselook: 0x3d,
  ToggleAlternateCameraMode: 0x3e,

  // Combat (class 4)
  ToggleCombatMode: 0x1000005a,
  DecreasePower: 0x1000005b,
  IncreasePower: 0x1000005c,
  LowAttack: 0x1000005d,
  MediumAttack: 0x1000005e,
  HighAttack: 0x1000005f,
  // The missile map's power pair (ClientCombatSystem::HandleCombatAction @ 0056d600 steps them
  // like 0x1000005b / 5c).
  DecreaseAccuracy: 0x100000ef,
  IncreaseAccuracy: 0x100000f0,
  SpellSlot1: 0x10000065,
  SpellSlot2: 0x10000066,
  SpellSlot3: 0x10000067,
  SpellSlot4: 0x10000068,
  SpellSlot5: 0x10000069,
  SpellSlot6: 0x1000006a,
  SpellSlot7: 0x1000006b,
  SpellSlot8: 0x1000006c,
  SpellSlot9: 0x1000006d,
  // CORE.17.k.b.b.a.g.f — the DAT binds Spell Slot 1-9 only (gmDefaultMap
  // section 0x10000005 has 18 entries: the five Ins/PgUp/Del/End/PgDn
  // commands, their four Ctrl variants, and the nine digits). Slots 10-12
  // exist in the ActionMap and ship unbound, as in retail.
  SpellSlot10: 0x1000006e,
  SpellSlot11: 0x1000006f,
  SpellSlot12: 0x10000070,
  // CORE.17.k.b.b.a.g.c — gmSpellcastingUI's selection / tab notices
  // (RecvNotice_CastCurrentSpell @ 004c6400, Next/Prev/First/LastSpellSelection,
  // Next/Prev/First/LastSpellTab). Retail keys (section 0x10000005): End =
  // Cast, Delete / PageDown = Previous / Next Spell, Insert / PageUp =
  // Previous / Next Spell Tab, Ctrl+ those = First / Last.
  CastSpell: 0x10000060,
  PreviousSpell: 0x10000061,
  NextSpell: 0x10000062,
  PreviousSpellTab: 0x10000063,
  NextSpellTab: 0x10000064,
  FirstSpell: 0x10000102,
  LastSpell: 0x10000103,
  FirstSpellTab: 0x10000104,
  LastSpellTab: 0x10000105,

  // UI (class 3)
  ExamineSelected: 0x1000002b,
  UseSelected: 0x10000025,
  // CORE.10.f — "Split Selected Stack" (OnAction case 2 @ 00561890 →
  // CM_UI::SendNotice_SplitStack). Retail binds T (gmDefaultMap 0x10000007).
  SplitSelectedStack: 0x1000002d,
  // GAP.world-drag-drop.b — "Give Selected Object to Target" / "Drop
  // Selected Object" (OnAction cases 0x15 / 0x16 @ 00561890; see
  // inventory/GiveDropCommands.ts). Selection map 0x10000007; the retail
  // KeyMap DATs bind neither — they ship unbound.
  GiveSelectedToTarget: 0x10000040,
  DropSelected: 0x10000041,
  SelectSelf: 0x1000002a,
  SelectLastAttacker: 0x10000038,
  SelectClosestMonster: 0x10000035,
  SelectNextMonster: 0x10000037,
  SelectPrevMonster: 0x10000036,
  // CORE.retail-select-keys — the rest of CPlayerSystem::OnAction's
  // selection cases (Selection map 0x10000007).
  SelectPreviousSelection: 0x1000002e,
  SelectClosestCompassItem: 0x1000002f,
  SelectPrevCompassItem: 0x10000030,
  SelectNextCompassItem: 0x10000031,
  SelectClosestItem: 0x10000032,
  SelectPrevItem: 0x10000033,
  SelectNextItem: 0x10000034,
  SelectClosestPlayer: 0x10000039,
  SelectPrevPlayer: 0x1000003a,
  SelectNextPlayer: 0x1000003b,
  SelectPrevFellow: 0x1000003c,
  SelectNextFellow: 0x1000003d,
  SelectClosestUnopenedCorpse: 0x10000121,
  SelectNextUnopenedCorpse: 0x10000122,
  BeginChat: 0x10000023,
  EnterExitChatMode: 0x10000024,
  OpenHelp: 0x7b,
  ShowHideCharInfoPanel: 0x10000005,
  ShowHidePositiveMagicPanel: 0x10000006,
  // GAP.indicator-bar-interactive — the other indicator-strip InputActions
  // (layout 0x21000071 attribute 0x12; each panel registers for its action
  // via attribute 0x57): Negative Effects (0x2100001b:0x10000121), Link
  // Status (gmLinkStatusUI 0x2100001d:0x10000167). The Mini-Game panel's
  // action is MINIGAME_PANEL_ACTION below (no ActionMap command).
  ShowHideNegativeMagicPanel: 0x10000007,
  ShowHideLinkStatusPanel: 0x10000009,
  // gmAbuseUI / gmUrgentAssistanceUI register for these (their roots' p87):
  // in the EoL client the commands are how the panels open (the Options
  // buttons open the support web page instead).
  ShowHideAbuseReportingPanel: 0x10000003,
  ShowHideUrgentAssistancePanel: 0x1000000b,
  ShowHideAllegiancePage: 0x1000000e,
  ShowHideFellowshipPage: 0x1000000f,
  ShowHideSpellbookPage: 0x10000011,
  ShowHideSpellComponentsPage: 0x10000012,
  ShowHideCharDetailPanel: 0x10000013,
  ShowHideAttributesPage: 0x10000014,
  ShowHideSkillsPage: 0x10000015,
  ShowHideWorldPanel: 0x10000016,
  ShowHideMapPage: 0x10000017,
  ShowHideInventoryPanel: 0x10000019,
  ShowHideOptionsPanel: 0x1000001a,
  // gmGamePlayUI::HandleKeyPress @ 004e9df0: the logout with no dialog (Shift+Escape).
  EndCharacterSession: 0x10000026,
  ShowHideSocialPanel: 0x1000000d,
  ShowHideVitaePanel: 0x1000000c,
  ShowHideContractsPage: 0x1000012e,
  ShowHideKeyboardConfig: 0x1000001f,
  ToggleFloatingChatWindow1: 0x10000114,
  ToggleFloatingChatWindow2: 0x10000115,
  ToggleFloatingChatWindow3: 0x10000116,
  ToggleFloatingChatWindow4: 0x10000117,
} as const;

/**
 * Movement / hold actions translate to the canonical physical code that
 * CameraController's getters already understand (it keys off raw WASD/arrows/
 * Space/Shift/NumLock). Rebinding a movement command therefore Just Works:
 * the router maps the pressed key → action → canonical code → simulateKeyDown.
 */
export const MOVEMENT_CANONICAL: Record<number, string> = {
  [ACT.MoveForward]: 'KeyW',
  [ACT.MoveBackward]: 'KeyS',
  [ACT.TurnLeft]: 'KeyA',
  [ACT.TurnRight]: 'KeyD',
  [ACT.StrafeLeft]: 'KeyZ',
  [ACT.StrafeRight]: 'KeyC',
  [ACT.Jump]: 'Space',
  [ACT.Autorun]: 'NumLock',
  [ACT.ToggleRunWalk]: 'ShiftLeft',
};

/**
 * CORE.18.b.a.a.a.a.a — the camera actions CameraManager::OnAction runs on
 * press AND release (m_fStart): Zoom In / Out (Closer / Farther), Rotate
 * Left / Right (Rotate / StopRotating), Rotate Up / Down (Raise / Lower).
 * The OS key repeat must not restart them.
 */
export const HELD_CAMERA_ACTIONS: ReadonlySet<number> = new Set([
  ACT.ZoomCameraIn, ACT.ZoomCameraOut,
  ACT.RotateCameraLeft, ACT.RotateCameraRight, ACT.RotateCameraUp, ACT.RotateCameraDown,
  ACT.ToggleAlternateCameraMode,
]);

/**
 * Whether an OS key repeat (KeyboardEvent.repeat) runs `actionId` again. Retail reads the keyboard
 * through DirectInput, which sends no repeats; CInputManager makes its own only for the actions
 * whose ActionMap toggle type is 4 (KEY_REPEAT_ACTIONS: the text-entry and list-scroll commands),
 * after sm_timeKeyRepeatDelay. Every other command (cast a spell slot, use, open a panel, emote)
 * fires once per press. The 1999 client reads the keyboard through DirectInput too.
 */
export function keyRepeatDispatches(actionId: number): boolean {
  return KEY_REPEAT_ACTIONS.has(actionId >>> 0);
}

/**
 * Browser-UX default (Jake, 2026-10-03): the wheel over the 3D world zooms the
 * camera out of the box. Retail binds zoom to Numpad − / + only and offers
 * wheel zoom behind Options → "Use Mouse Turning Settings" (SetMouseTurningDefaults
 * @ 004886f0 binds exactly these two). Most browser players have no numpad,
 * and the wheel over the world did nothing in retail, so nothing is lost: the
 * wheel over a panel still scrolls it. The extra binding shows in Keyboard
 * Config and can be removed there. Codes match MouseTurningDefaults'
 * WHEEL_UP_CODE / WHEEL_DOWN_CODE.
 */
export const BROWSER_UX_BINDINGS: Readonly<Record<number, readonly string[]>> = {
  [ACT.ZoomCameraIn]: ['MouseWheelUp'],
  [ACT.ZoomCameraOut]: ['MouseWheelDown'],
};

/**
 * Built-in default bindings: actionId → up to 3 canonical codes. The retail
 * KeyMap DAT's (keyboard device only, KeybindDefaults.generated.ts), plus the
 * browser-UX additions above in the next free slot.
 */
export const DEFAULT_KEYBINDS: Record<number, string[]> = (() => {
  const out: Record<number, string[]> = { ...RETAIL_DEFAULT_KEYBINDS };
  for (const [id, codes] of Object.entries(BROWSER_UX_BINDINGS)) {
    const k = Number(id);
    out[k] = [...(out[k] ?? []), ...codes.filter((c) => !(out[k] ?? []).includes(c))].slice(0, 3);
  }
  return out;
})();

/**
 * The retail input maps (ActionMap 0x26000000 sections = KeyMap sections),
 * named after the systems that register them.
 */
export const INPUT_MAP = {
  System: 0x10,          // Client::InitUI @ 00411660 — priority -1 (Alt+Enter / Alt+Tab / Alt+F4 / Ctrl+Shift+Esc)
  Mouse: 0x3,            // UIElementManager::Init @ 0045ee10 — priority 0
  UIManager: 0xd,        // UIElementManager::Init — priority 4000
  Camera: 0x5,           // CameraManager::CameraManager @ 00457090 — priority 1000
  AltCamera: 0x6,        // CameraManager::OnAction @ 00455f40 — priority 2000 while Toggle Alternate Camera Mode (0x3e: F2 / Numpad-/) is held
  Movement: 0x4,         // CPlayerSystem::RegisterInputMaps @ 0055dd80 — 1000
  Emotes: 0x10000006,    // CPlayerSystem::RegisterInputMaps — 1000 (always on)
  Selection: 0x10000007, // CPlayerSystem::RegisterInputMaps — 1000
  CharSettings: 0x10000008, // CPlayerSystem::RegisterInputMaps — 1000
  UI: 0x10000009,        // ClientUISystem::OnBeginCharacterSession @ 005645e0 — 1000
  Quickslots: 0x1000000c, // ClientUISystem::OnBeginCharacterSession — 1000 (always on)
  TargetMode: 0x1000000b, // ClientUISystem::SetTargetMode @ 00564940 — 2000 while a target mode is armed
  CombatToggle: 0x10000002, // ClientCombatSystem::OnBeginCharacterSession @ 0056aef0 — 1000
  Melee: 0x10000003,     // ClientCombatSystem::RegisterInputMaps @ 0056aa20 — 1000 in melee mode
  Missile: 0x10000004,   // … in missile mode
  Magic: 0x10000005,     // … in magic mode
  ChatBegin: 0x1000000a, // gmMainChatUI::PostInit @ 004ce130 — 1000
  ChatToggle: 0x1000000d, // gmMainChatUI::PostInit — 0xbc2 (3010)
} as const;

/**
 * The input maps registered while in the world, in the order the retail
 * CInputManager keeps them: List<InputMapEntry>::insert_sort @ 00431510 walks
 * while `new.priority < node.priority` and inserts before the first node of
 * equal or lower priority — descending priority, and among equals the
 * newest registration first. ClientCombatSystem::RegisterInputMaps @
 * 0056aa20 unregisters the previous mode's map and registers the new one on
 * every SetCombatMode, so the mode map is the newest 1000-priority entry.
 * (The dispatcher's walk direction is not recovered from the decomp; a
 * head-first walk is assumed — it is what makes the digits cast in magic
 * mode over the always-on Quickslot map, as they did in retail.)
 */
export function activeInputMaps(mode: CombatMode, altCameraHeld = false): number[] {
  const modeMap = mode === CombatMode.Melee ? INPUT_MAP.Melee
    : mode === CombatMode.Missile ? INPUT_MAP.Missile
    : mode === CombatMode.Magic ? INPUT_MAP.Magic
    : null;
  return [
    INPUT_MAP.UIManager,
    INPUT_MAP.ChatToggle,
    // Held F2 / Numpad-/ registers the alternate camera map at 2000, above
    // every 1000 map, so the arrows rotate the camera instead of moving.
    ...(altCameraHeld ? [INPUT_MAP.AltCamera] : []),
    ...(modeMap !== null ? [modeMap] : []),
    INPUT_MAP.ChatBegin,
    INPUT_MAP.CombatToggle,
    INPUT_MAP.Quickslots,
    INPUT_MAP.UI,
    INPUT_MAP.CharSettings,
    INPUT_MAP.Selection,
    INPUT_MAP.Emotes,
    INPUT_MAP.Movement,
    INPUT_MAP.Camera,
    INPUT_MAP.Mouse,
    INPUT_MAP.System,
  ];
}

/** GAP.indicator-bar-interactive — gmMiniGameUI (0x2100001e:0x1000016a)
 *  registers for InputAction 0x1000000a via attribute 0x57, and the
 *  mini-game indicator (0x21000071:0x100000f3) fires it, but the DAT
 *  ActionMap 0x26000000 has no command for it (not rebindable, no key). */
export const MINIGAME_PANEL_ACTION = 0x1000000a;
