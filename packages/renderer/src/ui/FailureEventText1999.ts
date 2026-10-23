/**
 * The 1999 client.exe's failure-code texts (SWEEP1999.messages HC-6 / VTE-2 / MAG-9).
 *
 * `UI_HandleFailureEvent @ 0x004ccd10` (reference/ac1999/Client/decomp/ui/HandleFailureEvent.c) is
 * the one switch for 0x1C AttemptFailed and a non-zero 0x1C7 UseDone. Its arms call the status line,
 * `SetStatusText(text, urgent = 1)` (vtable +0x114), which is our spew box (the 1999 urgent status
 * colour is the spew yellow), except 0x4a and 0x402, which go to the chat scroll (channel 0 / 7). A
 * code with no arm prints nothing, so the codes the AC1999 server sends from a later code set
 * (MOVED_TOO_FAR, the chest and lockpick codes, the recall and portal-link codes, HEAL_NOT_TRAINED,
 * MISSILE_OUT_OF_RANGE, ...) are silent, as they were for a 1999 player. The texts are the exe's
 * literals with their trailing "\n" dropped; 0x3e, 0x434 and 0x437 word it differently from end of
 * retail ("too fatigued to attack", "goods", "Your craft goods are unsatisfactory.").
 */
import { WEENIE_ERROR_TEXT_TYPE_SPEW } from '@ac/shared';

/** One arm of a client's failure switch: the AddTextToScroll type (0x1a = the spew box) and its text. */
export interface FailureEventArm {
  readonly type: number;
  readonly text: string;
}

/** A client's whole failure switch: code → arm. A code not in it prints nothing. */
export type FailureEventTable = ReadonlyMap<number, FailureEventArm>;

const spew = (text: string): FailureEventArm => Object.freeze({ type: WEENIE_ERROR_TEXT_TYPE_SPEW, text });
const chat = (type: number, text: string): FailureEventArm => Object.freeze({ type, text });

const UNABLE_TO_MOVE = spew('Unable to move to object!'); // 0x23, 0x37-0x39 (LAB_004cce91)
const TOO_FATIGUED = spew('You are too fatigued to attack!'); // 0x3e, 0x3f7
const CRAFT_FAILS = spew('Your craft attempt fails.'); // 0x432, 0x433, 0x435

export const FAILURE_EVENT_TEXT_1999: FailureEventTable = new Map<number, FailureEventArm>([
  [0x1d, spew("You're too busy!")],
  [0x20, spew('You must control both objects!')],
  [0x23, UNABLE_TO_MOVE],
  [0x26, spew('That is not a valid command.')],
  [0x28, spew("The item is under someone else's control!")],
  [0x29, spew('You cannot pick that up!')],
  [0x2a, spew('You are too encumbered to carry that!')],
  [0x36, spew('Action cancelled!')],
  [0x37, UNABLE_TO_MOVE],
  [0x38, UNABLE_TO_MOVE],
  [0x39, UNABLE_TO_MOVE],
  [0x3d, spew('You charged too far!')],
  [0x3e, TOO_FATIGUED],
  [0x4a, chat(0, 'Ack! You killed yourself!')],
  [0x3ee, spew('The container is closed!')],
  [0x3f7, TOO_FATIGUED],
  [0x3f8, spew('You are out of ammunition!')],
  [0x3f9, spew('Your missile attack misfired!')],
  [0x3fa, spew("You've attempted an impossible spell path!")],
  [0x3fe, spew("You don't know that spell!")],
  [0x3ff, spew('Incorrect target type')],
  [0x400, spew("You don't have all the components for this spell.")],
  [0x401, spew("You don't have enough Mana to cast this spell.")],
  [0x402, chat(7, 'Your spell fizzled.')],
  [0x403, spew("Your spell's target is missing!")],
  [0x404, spew('Your projectile spell mislaunched!')],
  [0x407, spew('Your spell cannot be cast outside')],
  [0x408, spew('Your spell cannot be cast inside')],
  [0x40a, spew('You are unprepared to cast a spell')],
  [0x40b, spew("You've already sworn your Allegiance")],
  [0x40c, spew("You don't have enough experience available to swear Allegiance")],
  [0x41d, spew('You must be the leader of a Fellowship')],
  [0x41e, spew('Your Fellowship is full')],
  [0x41f, spew('That Fellowship name is not permitted')],
  [0x422, spew("That channel doesn't exist.")],
  [0x423, spew("You can't use that channel.")],
  [0x424, spew("You're already on that channel.")],
  [0x425, spew("You're not currently on that channel.")],
  [0x427, spew('You cannot merge different stacks!')],
  [0x428, spew('You cannot merge enchanted items!')],
  [0x429, spew('You must control at least one stack!')],
  [0x432, CRAFT_FAILS],
  [0x433, CRAFT_FAILS],
  [0x434, spew('Given that number of goods, you cannot craft anything.')],
  [0x435, CRAFT_FAILS],
  [0x437, spew('Your craft goods are unsatisfactory.')],
  [0x438, spew('You do not have all the neccessary items.')], // sic
  [0x43a, spew('You must be at rest in peace mode to do trade skills.')],
  [0x43b, spew('You are not trained in that trade skill.')],
  [0x43c, spew('Your hands must be free.')],
]);
