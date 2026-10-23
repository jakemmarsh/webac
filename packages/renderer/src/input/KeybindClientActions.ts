/**
 * Keyboard commands an era client has that the end-of-retail ActionMap (0x26000000, baked into
 * KeybindActions.generated.ts) does not (SWEEP1999.input).
 *
 * The 1999 client.exe's command list has "SpellResearchPanel" (Default.map binds it to F7): it
 * shows the magic panel's Create Spell tab (MagicPanBase @ 0x54c500's third tab). The panel was
 * cut before the 2005 client, so no ActionMap id exists; this one is ours, outside the ActionMap's
 * range, and lives in the UI map (0x10000009) beside the other panel commands. Only an era whose
 * client rules build the research tab lists it (EraFeatures.clientRuleHiddenActions).
 */
import { ActionClass } from './KeybindActionClass.js';
import type { KeybindAction } from './KeybindActions.generated.js';

/** Show/Hide Spell Research Page (1999 SpellResearchPanel). Not an ActionMap id. */
export const SPELL_RESEARCH_PAGE_ACTION = 0x1000f001;

/** The UI input map (ClientUISystem::OnBeginCharacterSession's 0x10000009). */
const UI_INPUT_MAP = 0x10000009;

export const CLIENT_KEYBIND_ACTIONS: readonly KeybindAction[] = Object.freeze([
  {
    id: SPELL_RESEARCH_PAGE_ACTION, cls: ActionClass.UI, name: 'Show/Hide Spell Research Page',
    desc: 'Opens or closes the Create Spell page of the magic panel.',
  },
]);

/** actionId → its input map, as ACTION_INPUT_MAP for the ActionMap's commands. */
export const CLIENT_ACTION_INPUT_MAP: Readonly<Record<number, number>> = Object.freeze({
  [SPELL_RESEARCH_PAGE_ACTION]: UI_INPUT_MAP,
});

/** The Keyboard Config rows for these commands, as KEYBIND_ACTION_ROWS. */
export const CLIENT_KEYBIND_ACTION_ROWS: ReadonlyArray<{ map: number; id: number }> = Object.freeze(
  CLIENT_KEYBIND_ACTIONS.map((a) => ({ map: CLIENT_ACTION_INPUT_MAP[a.id], id: a.id })),
);
