/**
 * The one-shot command dispatcher (was main.ts's inline dispatchAction): an
 * ActionMap command id → the handler retail runs for it. DOM-free and
 * host-driven so tests run the shipped table: every command the Keyboard
 * Config lets a player bind must land here, on MOVEMENT_CANONICAL (the held
 * movement keys CameraController reads), or on UNHANDLED_BINDABLE_ACTIONS with
 * the reason (BUG.keybind-use-closest-corpse, webac#13: Use Closest Unopened
 * Corpse was listed, bindable, and did nothing).
 *
 * Retail's handlers, by owner:
 * - CPlayerSystem::OnAction @ 00561890 — selection, corpse, place-in-pack,
 *   give / drop and every Character Settings toggle (cases 0x17–0x4a:
 *   PlayerModule::Set<Option>(!<Option>)). Its action → case byte table is
 *   the jumptable at 0x00562758.
 * - ClientUISystem::OnAction @ 00564b90 — Use / Examine, Escape, Show/Hide
 *   Compass, Take Screenshot, the plugin manager, Open Help.
 * - ChatInterface::OnAction @ 004f5690 — the reply keys, Start Command, Tell
 *   to Selected, Begin / Enter-Exit Chat.
 * - CameraManager::OnAction, ClientCombatSystem::HandleCombatAction @
 *   0056d600 / HandleMagicAction @ 0056a6e0, ACCmdInterp::OnAction @ 0058b370.
 * - UIElementManager::DoVisibilityToggleAction — the Show/Hide panel and page
 *   commands, through each panel root's p87 InputAction.
 */
import { MotionCommand } from '../animation/MotionCommands.js';
import { ACT, MINIGAME_PANEL_ACTION } from './KeybindDefaults.js';
import { SPELL_RESEARCH_PAGE_ACTION } from './KeybindClientActions.js';
import { corpseCommand, runCorpseCommand, type CorpseCommandDeps } from './CorpseCommands.js';
import { SelectionType, type SelectCycle } from '../controllers/SelectNext.js';
import { attackHeightForAction, type AttackHeightName } from '../controllers/AttackRequest.js';
import { quickslotCommand, CREATE_SHORTCUT_ACTION } from '../network/itemShortcutRestore.js';
import { OPTION_KEYBIND_ACTIONS } from '../era/EraFeatures.js';
import { PLAYER_OPTIONS } from '../ui/PlayerOptions.js';

/** The GameUI methods the commands call (GameUI satisfies it structurally). */
export interface ActionUI {
  castFromSpellBar(slotIdx: number): void;
  castSelectedSpell(): void;
  cycleSpellSelection(dir: 'next' | 'prev' | 'first' | 'last'): void;
  switchSpellBarTab(dir: 'next' | 'prev' | 'first' | 'last'): void;
  toggleMiniGamePanel(): void;
  toggleSocialPage(tab: 'allegiance' | 'fellowship' | 'friends' | 'squelch'): void;
  toggleSocialPanel(): void;
  toggleMagicPage(tab: 'spells' | 'components' | 'research'): void;
  toggleMagicPanel(): void;
  toggleCharPage(tab: 'attributes' | 'skills' | 'titles'): void;
  toggleCharPanel(): void;
  toggleCharacterInfoTextPanel(): void;
  toggleMapPanel(): void;
  toggleWorldPage(tab: 'map' | 'house'): void;
  toggleInventory(): void;
  toggleOptionsPanel(): void;
  toggleOptionsPage(tab: 'gameplay' | 'character' | 'chat' | 'config'): void;
  toggleContractPanel(): void;
  toggleContractPage(tab: 'contracts' | 'journal' | 'page_list'): void;
  togglePositiveEffectsPanel(): void;
  toggleNegativeEffectsPanel(): void;
  toggleVitaePanel(): void;
  toggleLinkStatusPanel(): void;
  toggleKeyboardConfigPanel(): void;
  toggleFloatyChatWindow(index: number): void;
  focusToolbarSplitEntry(): void;
  togglePlayerOption(code: number): boolean;
}

/** The CameraController methods the camera commands call. */
export interface ActionCamera {
  stopMoving(): void;
  startZoom(dir: number): void;
  resetZoom(): void;
  enterHead(): void;
  toggleLookDown(): void;
  startRotate(dir: 'left' | 'right'): void;
  startRaiseLower(dir: 'raise' | 'lower'): void;
  toggleMapMode(): void;
}

/** What only main.ts can do (its world, selection, chat and network state). */
export interface ActionHost extends CorpseCommandDeps {
  ui: ActionUI;
  camera: ActionCamera;
  /** ACCmdInterp's emote input-action table (buildEmoteMotionMap). */
  emoteMotion(id: number): number | undefined;
  triggerEmote(motion: number): void;
  useItemShortcut(slot: number, use: boolean): void;
  createShortcut(): void;
  /** HandleCombatAction's attack-height press (StartAttackRequest). */
  pressAttackHeight(height: AttackHeightName): void;
  toggleCombatMode(): void;
  /** HandleCombatAction's power / accuracy step (±1 sixth). */
  stepPower(dir: 1 | -1): void;
  endCharacterSession(): void;
  /** ACCmdInterp::OnAction's held substates (Ready, or Crouch / Sit / Lay Down with the combat refusal). */
  holdSubstate(motion: number): void;
  holdPosture(actionId: number): void;
  examineSelected(): void;
  useSelected(): void;
  selectLastAttacker(): void;
  giveSelected(): boolean;
  dropSelected(): boolean;
  /** CPlayerSystem::PlaceInBackpack(selectedID, toMainPack); false when nothing is selected (the case breaks). */
  placeSelectedInBackpack(toMainPack: boolean): boolean;
  selectPreviousSelection(): boolean;
  selectFellow(next: boolean): void;
  selectSelf(): void;
  /** CameraManager::OnAction 0x3e: the alternate camera map + held mouse-look. */
  altCameraDown(): void;
  /** CameraManager::OnAction 0x3d: held mouse-look (CameraSet::ToggleMouseLook(m_fStart)). */
  mouseLookDown(): void;
  /** ChatInterface::OnAction 0x10000024 (OnToggleChatEntry). */
  toggleChatEntry(): void;
  /** ChatInterface::OnAction 0x10000023 (ActivateChatEntry + SelectAll). */
  beginChat(): void;
  /** ChatInterface::HandleReplyKey @ 004f5350. */
  replyKey(kind: 'monarch' | 'patron' | 'reply'): void;
  /** ChatInterface::HandleCommandOrAliasKey @ 004f2ff0. */
  startCommand(): void;
  /** ChatInterface::OnAction 0x10000119: a player selected → SendNotice_StartTell(its name). */
  tellToSelected(): void;
}

/**
 * Bindable commands with no handler, each with why (the Keyboard Config still
 * lists them: a retail command whose target exists in retail is kept
 * bindable, per CLAUDE.md "No Dead-End UI" only a gone target hides it).
 */
export const UNHANDLED_BINDABLE_ACTIONS: Readonly<Record<number, string>> = {
  [ACT.TakeScreenshot]: 'Device::SaveScreenshot @ 0043a540 writes the frame (3D + UI) to disk; our UI is DOM over a WebGL canvas, so a canvas grab would drop the HUD — task FEATURE.keybind-take-screenshot',
};

/** Retail's Spell Slot 1–12 (HandleMagicAction: CastQuickslotSpell(action − 0x10000065)). */
const SPELL_SLOT_FIRST = ACT.SpellSlot1;
const SPELL_SLOT_LAST = ACT.SpellSlot12;

/** The Character Settings command's PlayerOption code (OnAction cases 0x17–0x4a), or undefined. */
export function optionToggleCode(id: number): number | undefined {
  const name = OPTION_KEYBIND_ACTIONS[id];
  return name === undefined ? undefined : PLAYER_OPTIONS[name];
}

const SELECT_CYCLES: Readonly<Record<number, readonly [SelectionType, SelectCycle]>> = {
  [ACT.SelectClosestCompassItem]: [SelectionType.CompassItem, 'closest'],
  [ACT.SelectPrevCompassItem]: [SelectionType.CompassItem, 'previous'],
  [ACT.SelectNextCompassItem]: [SelectionType.CompassItem, 'next'],
  [ACT.SelectClosestItem]: [SelectionType.Item, 'closest'],
  [ACT.SelectPrevItem]: [SelectionType.Item, 'previous'],
  [ACT.SelectNextItem]: [SelectionType.Item, 'next'],
  [ACT.SelectClosestMonster]: [SelectionType.Monster, 'closest'],
  [ACT.SelectPrevMonster]: [SelectionType.Monster, 'previous'],
  [ACT.SelectNextMonster]: [SelectionType.Monster, 'next'],
  [ACT.SelectClosestPlayer]: [SelectionType.Player, 'closest'],
  [ACT.SelectPrevPlayer]: [SelectionType.Player, 'previous'],
  [ACT.SelectNextPlayer]: [SelectionType.Player, 'next'],
};

/** Dispatch a resolved one-shot command. Returns true when handled (the key is consumed). */
export function dispatchGameAction(id: number, h: ActionHost): boolean {
  const { ui, camera } = h;
  const emote = h.emoteMotion(id);
  if (emote !== undefined) { h.triggerEmote(emote); return true; }

  if (id >= SPELL_SLOT_FIRST && id <= SPELL_SLOT_LAST) { ui.castFromSpellBar(id - SPELL_SLOT_FIRST); return true; }

  // GAP.toolbar-item-shortcuts-inert — gmToolbarUI::ListenToGlobalMessage @ 004be4e0: Quickslot N
  // uses, Select Quickslot N selects, Create Shortcut puts the selection in the first free slot.
  const quickslot = quickslotCommand(id);
  if (quickslot) { h.useItemShortcut(quickslot.slot, quickslot.use); return true; }
  if (id === CREATE_SHORTCUT_ACTION) { h.createShortcut(); return true; }

  // GAP.indicator-bar-interactive — gmMiniGameUI's action has no ActionMap command.
  if (id === MINIGAME_PANEL_ACTION) { ui.toggleMiniGamePanel(); return true; }

  // BUG.combat-attack-charge-build — HandleCombatAction @ 0056d600: Low / Medium / High Attack.
  const pressedHeight = attackHeightForAction(id);
  if (pressedHeight) { h.pressAttackHeight(pressedHeight); return true; }

  // OnAction cases 0x13 / 0x14 / 0x43 / 0x44 (input/CorpseCommands.ts).
  const corpse = corpseCommand(id);
  if (corpse) return runCorpseCommand(corpse, h);

  // OnAction cases 0x17–0x4a: the Character Settings toggles.
  const optionCode = optionToggleCode(id);
  if (optionCode !== undefined) { ui.togglePlayerOption(optionCode); return true; }

  const cycle = SELECT_CYCLES[id];
  if (cycle) { h.selectCycle(cycle[0], cycle[1]); return true; }

  switch (id) {
    // CORE.17.k.b.b.a.g.c — gmSpellcastingUI's keyed notices (RecvNotice_CastCurrentSpell
    // @ 004c6400; the selection walks @ 004c7460 / 004c75d0 / 004c77a0 / 004c7820, the tab walks
    // @ 004c73e0 / 004c7420 / 004c7740 / 004c7770).
    case ACT.CastSpell: ui.castSelectedSpell(); return true;
    case ACT.NextSpell: ui.cycleSpellSelection('next'); return true;
    case ACT.PreviousSpell: ui.cycleSpellSelection('prev'); return true;
    case ACT.FirstSpell: ui.cycleSpellSelection('first'); return true;
    case ACT.LastSpell: ui.cycleSpellSelection('last'); return true;
    case ACT.NextSpellTab: ui.switchSpellBarTab('next'); return true;
    case ACT.PreviousSpellTab: ui.switchSpellBarTab('prev'); return true;
    case ACT.FirstSpellTab: ui.switchSpellBarTab('first'); return true;
    case ACT.LastSpellTab: ui.switchSpellBarTab('last'); return true;
    case ACT.StopMoving: camera.stopMoving(); return true;
    // Combat
    case ACT.ToggleCombatMode: h.toggleCombatMode(); return true;
    // SWEEP1999.input CM-5 — HandleCombatAction @ 0056d600 (1999: 0x0058b300 / 0058b390).
    case ACT.IncreasePower: case ACT.IncreaseAccuracy: h.stepPower(1); return true;
    case ACT.DecreasePower: case ACT.DecreaseAccuracy: h.stepPower(-1); return true;
    // UI panels and pages (UIElementManager::DoVisibilityToggleAction over the roots' p87).
    case ACT.ShowHideAllegiancePage: ui.toggleSocialPage('allegiance'); return true;
    case ACT.ShowHideFellowshipPage: ui.toggleSocialPage('fellowship'); return true;
    case ACT.ShowHideFriendsPage: ui.toggleSocialPage('friends'); return true;
    case ACT.ShowHideSocialPanel: ui.toggleSocialPanel(); return true;
    case ACT.ShowHideSpellManagementPanel: ui.toggleMagicPanel(); return true;
    case ACT.ShowHideSpellbookPage: ui.toggleMagicPage('spells'); return true;
    case ACT.ShowHideSpellComponentsPage: ui.toggleMagicPage('components'); return true;
    // 1999's SpellResearchPanel (F7 in its Default.map): the magic panel's Create Spell tab.
    case SPELL_RESEARCH_PAGE_ACTION: ui.toggleMagicPage('research'); return true;
    case ACT.ShowHideCharDetailPanel: ui.toggleCharPanel(); return true;
    case ACT.ShowHideAttributesPage: ui.toggleCharPage('attributes'); return true;
    case ACT.ShowHideSkillsPage: ui.toggleCharPage('skills'); return true;
    case ACT.ShowHideCharacterTitlesPage: ui.toggleCharPage('titles'); return true;
    case ACT.ShowHideCharInfoPanel: ui.toggleCharacterInfoTextPanel(); return true;
    case ACT.ShowHideWorldPanel: ui.toggleMapPanel(); return true;
    case ACT.ShowHideMapPage: ui.toggleWorldPage('map'); return true;
    case ACT.ShowHideHousePage: ui.toggleWorldPage('house'); return true;
    case ACT.ShowHideInventoryPanel: ui.toggleInventory(); return true;
    case ACT.ShowHideOptionsPanel: ui.toggleOptionsPanel(); return true;
    case ACT.ShowHideGameplayOptionsPage: ui.toggleOptionsPage('gameplay'); return true;
    case ACT.ShowHideCharacterSettingsPage: ui.toggleOptionsPage('character'); return true;
    case ACT.ShowHideConfigurationPage: ui.toggleOptionsPage('config'); return true;
    case ACT.ShowHideContractsPage: ui.toggleContractPage('contracts'); return true;
    case ACT.ShowHideQuestDetailPanel: ui.toggleContractPanel(); return true;
    case ACT.ShowHideQuestJournalPage: ui.toggleContractPage('journal'); return true;
    case ACT.ShowHideJournalPageList: ui.toggleContractPage('page_list'); return true;
    case ACT.ShowHidePositiveMagicPanel: ui.togglePositiveEffectsPanel(); return true;
    case ACT.ShowHideNegativeMagicPanel: ui.toggleNegativeEffectsPanel(); return true;
    case ACT.ShowHideVitaePanel: ui.toggleVitaePanel(); return true;
    case ACT.ShowHideLinkStatusPanel: ui.toggleLinkStatusPanel(); return true;
    case ACT.ShowHideKeyboardConfig: ui.toggleKeyboardConfigPanel(); return true;
    // gmGamePlayUI::HandleKeyPress @ 004e9df0: 0x10000026 is the logout with no dialog.
    case ACT.EndCharacterSession: h.endCharacterSession(); return true;
    // VISUAL.emote-poses-not-held — ACCmdInterp::OnAction @ 0058b370.
    case ACT.Ready: h.holdSubstate(MotionCommand.Ready); return true;
    case ACT.Crouch: case ACT.Sitting: case ACT.Sleeping: h.holdPosture(id); return true;
    // Targeting / selection (ClientUISystem::OnAction 0x1000002b / 0x10000025; CPlayerSystem::OnAction).
    case ACT.ExamineSelected: h.examineSelected(); return true;
    case ACT.UseSelected: h.useSelected(); return true;
    case ACT.SelectLastAttacker: h.selectLastAttacker(); return true;
    // CORE.10.f — OnAction case 2 → CM_UI::SendNotice_SplitStack(selectedID).
    case ACT.SplitSelectedStack: ui.focusToolbarSplitEntry(); return true;
    // GAP.world-drag-drop.b — OnAction cases 0x15 / 0x16; false (the key passes on) when retail's case breaks.
    case ACT.GiveSelectedToTarget: return h.giveSelected();
    case ACT.DropSelected: return h.dropSelected();
    // OnAction case 1 / 0x3e: PlaceInBackpack(selectedID, false / true); the case breaks with nothing selected.
    case ACT.PlaceSelectedInInventory: return h.placeSelectedInBackpack(false);
    case ACT.PlaceSelectedInMainPack: return h.placeSelectedInBackpack(true);
    case ACT.SelectPreviousSelection: return h.selectPreviousSelection();
    case ACT.SelectPrevFellow: h.selectFellow(false); return true;
    case ACT.SelectNextFellow: h.selectFellow(true); return true;
    case ACT.SelectSelf: h.selectSelf(); return true;
    // Camera — CameraManager::OnAction (held ones end in main.ts's keyup releaseAction).
    case ACT.ZoomCameraIn: camera.startZoom(-1); return true;
    case ACT.ZoomCameraOut: camera.startZoom(1); return true;
    case ACT.MoveCameraToDefault: camera.resetZoom(); return true;
    case ACT.FirstPersonCamera: camera.enterHead(); return true;
    case ACT.OverheadView: camera.toggleLookDown(); return true;
    case ACT.RotateCameraLeft: camera.startRotate('left'); return true;
    case ACT.RotateCameraRight: camera.startRotate('right'); return true;
    case ACT.RotateCameraUp: camera.startRaiseLower('raise'); return true;
    case ACT.RotateCameraDown: camera.startRaiseLower('lower'); return true;
    case ACT.MapView: camera.toggleMapMode(); return true;
    case ACT.ToggleAlternateCameraMode: h.altCameraDown(); return true;
    case ACT.ToggleMouselook: h.mouseLookDown(); return true;
    // Chat — ChatInterface::OnAction @ 004f5690.
    case ACT.BeginChat: h.beginChat(); return true;
    case ACT.EnterExitChatMode: h.toggleChatEntry(); return true;
    case ACT.MonarchReply: h.replyKey('monarch'); return true;
    case ACT.PatronReply: h.replyKey('patron'); return true;
    case ACT.Reply: h.replyKey('reply'); return true;
    case ACT.StartCommand: h.startCommand(); return true;
    case ACT.TellToSelected: h.tellToSelected(); return true;
    case ACT.ToggleFloatingChatWindow1: ui.toggleFloatyChatWindow(1); return true;
    case ACT.ToggleFloatingChatWindow2: ui.toggleFloatyChatWindow(2); return true;
    case ACT.ToggleFloatingChatWindow3: ui.toggleFloatyChatWindow(3); return true;
    case ACT.ToggleFloatingChatWindow4: ui.toggleFloatyChatWindow(4); return true;
  }
  return false;
}

/** Table 0x2300000c's ID_CmdPrefix: the text Start Command (0x10000028) opens the chat entry with. */
export const CHAT_COMMAND_PREFIX = '/';

/**
 * ClientCommunicationSystem::Handle_Communication__ChannelBroadcast @ 00570b90: a line on the
 * Monarch channel (0x4000) calls SetLastAtMonarchUserName(sender), on the Patron channel (0x2000)
 * SetLastAtPatronUserName; an empty sender is ACE's echo of our own line.
 */
export function channelReplyPartner(channel: number, senderName: string): 'monarch' | 'patron' | null {
  if (!senderName) return null;
  if (channel === 0x4000) return 'monarch';
  if (channel === 0x2000) return 'patron';
  return null;
}

/** Whether ChatInterface::OnAction 0x10000119 tells `guid`: a player id (0x50000000, 0x70000000). */
export function isTellableSelection(guid: number): boolean {
  const g = guid >>> 0;
  return g > 0x50000000 && g < 0x70000000;
}
