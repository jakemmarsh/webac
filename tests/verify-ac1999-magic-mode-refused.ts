/**
 * BUG.ac1999-magic-mode-refused (2026-10-16, local AC1999 server) — a
 * bare-handed 1999 mage's cast made the client send ChangeCombatMode Magic.
 * The AC1999 server refused it (Player.cpp CPlayerWeenie::ChangeCombatMode,
 * "no-held-item") with only a flat 0x1C AttemptFailed(WERROR_INTERRUPTED =
 * 0x36): no stance, no CombatMode int. The client kept showing magic mode (the
 * spell bar, a magic stance) and sent the cast, which failed with
 * MagicGeneralFailure every time.
 *
 * Two fixes, both driven here through shipped code:
 *  1. The 1999 rule. client.exe (1999-10-09) asks only for the mode
 *     PanelUI::GetDefaultCombatMode @ 0x4f9130 picks: magic only with a Caster
 *     held, missile only with a missile weapon, melee bare-handed; UI_CastSpell
 *     @ 0x4d1bd0 never changes the mode. So bare-handed magic is refused before
 *     anything is sent, silently (1999 has no line for it).
 *  2. Following the server. A mode the server refuses with ActionCancelled is
 *     undone: the client goes back to the mode and stance the server kept, and
 *     the cast's auto-switch sends no cast. GDLE (the classic servers) refuses
 *     the same way; ACE's CombatMode int already covered end of retail.
 */
import { describe, expect, it, vi } from 'vitest';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerCombat1999 } from '../packages/network/src/era1999/codecs/Combat1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { CombatMode, EquipMask } from '../packages/shared/src/index.js';
import {
  UnconfirmedCombatMode, followModeRefusal, castOnceMagicTaken, combatModeOfStance, compatibleCombatMode,
  incompatibleCombatModeRefusal, combatModeRefusalReason, MODE_REFUSED_ERROR, MODE_REFUSAL_WINDOW_MS,
} from '../packages/renderer/src/controllers/CombatModeChange.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';

const PLAYER = 0x50000001;
const PEACE_STANCE = 0x8000003d, MAGIC_STANCE = 0x80000049, SWORD_STANCE = 0x8000003e;
const HELD = EquipMask.Held, MELEE = EquipMask.MeleeWeapon, MISSILE = EquipMask.MissileWeapon;

/** The client side: a mode + body stance, a tracker, and onWeenieError's refusal step, fed by the REAL 1999 adapter + handler. */
function client(startMode = CombatMode.NonCombat, startStance = PEACE_STANCE) {
  const state = { mode: startMode, stance: startStance };
  const tracker = new UnconfirmedCombatMode();
  let now = 1000;
  const errors: number[] = [];
  const c = emptyCodecs();
  registerCombat1999(c, { player: () => ({ guid: PLAYER, eventSequence: 0 }) });
  const adapter = new Adapter1999(c, { account: 'acjs', log: () => {} });
  const h = new ServerMessageHandler();
  h.setHandlers({
    onWeenieError: (d: { errorType: number }) => {
      errors.push(d.errorType);
      followModeRefusal(tracker, d.errorType, now, {
        setMode: (m) => { state.mode = m; },
        stance: () => state.stance,
        setStance: (s) => { state.stance = s; },
      });
    },
  });
  return {
    state, tracker, errors,
    tick: (ms: number) => { now += ms; },
    /** sendChangeCombatMode's commit: record, then show the new mode (and magic's one stance). */
    request: (mode: CombatMode) => {
      tracker.sent(state.mode, state.stance, mode, now);
      state.mode = mode;
      if (mode === CombatMode.Magic) state.stance = MAGIC_STANCE;
      if (mode === CombatMode.NonCombat) state.stance = PEACE_STANCE;
    },
    /** The AC1999 server's NotifyWeenieError: flat 0x1C, i32 WERROR. */
    serverError: (code: number) => {
      for (const e of adapter.inbound(new Writer1999().u32(0x1c).i32(code).toBytes(), 4)) h.handleMessage(deserializeMessage(e));
    },
    /** The server's movement for the player puts the body in `stance` (onLocalPlayerStyle). */
    serverStance: (stance: number) => { state.stance = stance; tracker.stance(combatModeOfStance(stance)); },
  };
}

describe('1999: magic mode needs a held caster, missile a missile weapon (GetDefaultCombatMode @ 0x4f9130)', () => {
  it('the era runs the 1999 check, and bare-handed magic is refused before anything is sent, silently', () => {
    expect(eraClientRules(eraProfile('ac1999-retail')).combatModeCheck).toBe('ac1999');
    expect(compatibleCombatMode(CombatMode.Magic, 0, 'ac1999')).toBe(false);
    expect(compatibleCombatMode(CombatMode.Magic, MELEE, 'ac1999')).toBe(false);
    expect(incompatibleCombatModeRefusal(CombatMode.Magic, 0, null, 'ac1999')).toEqual({ text: null });
    // A sword is wielded: still no line, 1999's only one is the Held check's.
    expect(incompatibleCombatModeRefusal(CombatMode.Magic, MELEE, 'Sword', 'ac1999')).toEqual({ text: null });
    expect(compatibleCombatMode(CombatMode.Magic, HELD, 'ac1999')).toBe(true);
  });

  it('missile needs a missile weapon; melee bare-handed or armed is fine; a Held item still refuses melee / missile with its line', () => {
    expect(compatibleCombatMode(CombatMode.Missile, 0, 'ac1999')).toBe(false);
    expect(compatibleCombatMode(CombatMode.Missile, MELEE, 'ac1999')).toBe(false);
    expect(incompatibleCombatModeRefusal(CombatMode.Missile, MELEE, 'Sword', 'ac1999')).toEqual({ text: null });
    expect(compatibleCombatMode(CombatMode.Missile, MISSILE, 'ac1999')).toBe(true);
    expect(compatibleCombatMode(CombatMode.Melee, 0, 'ac1999')).toBe(true);
    expect(compatibleCombatMode(CombatMode.Melee, MELEE, 'ac1999')).toBe(true);
    expect(compatibleCombatMode(CombatMode.Melee, MISSILE, 'ac1999')).toBe(true);
    expect(compatibleCombatMode(CombatMode.Melee, HELD, 'ac1999')).toBe(false);
    expect(incompatibleCombatModeRefusal(CombatMode.Melee, HELD, 'Wand', 'ac1999')).toEqual({ text: "You can't enter combat mode while wielding the Wand" });
    expect(incompatibleCombatModeRefusal(CombatMode.Missile, HELD | MISSILE, 'Wand', 'ac1999')).toEqual({ text: "You can't enter combat mode while wielding the Wand" });
    expect(compatibleCombatMode(CombatMode.NonCombat, HELD, 'ac1999')).toBe(true);
  });

  it("the automation's reason names the missing caster in 1999 too", () => {
    expect(combatModeRefusalReason(CombatMode.Magic, 0, null, 'ac1999')).toMatch(/^magic mode needs a wielded wand, staff or orb/);
    expect(combatModeRefusalReason(CombatMode.Magic, HELD, 'Wand', 'ac1999')).toBeNull();
  });

  it('end of retail and the classic eras keep their own rule (unchanged)', () => {
    for (const id of ['eor', 'classicace-customdm', 'classic-dereth']) expect(eraClientRules(eraProfile(id)).combatModeCheck).toBe('eor');
    expect(compatibleCombatMode(CombatMode.Magic, 0, 'eor')).toBe(false);
    expect(compatibleCombatMode(CombatMode.Magic, HELD, 'eor')).toBe(true);
    expect(compatibleCombatMode(CombatMode.Melee, MISSILE, 'eor')).toBe(false);
    expect(compatibleCombatMode(CombatMode.Melee, 0, 'eor')).toBe(true);
    expect(incompatibleCombatModeRefusal(CombatMode.Missile, MELEE, 'Tachi', 'eor')).toEqual({ text: "You can't enter missile mode while wielding the Tachi" });
  });
});

describe("a mode the server refuses with ActionCancelled is undone (the AC1999 server's 0x1C, GDLE's 0x28A)", () => {
  it('peace → magic, refused: the client is back in peace, in the peace stance', () => {
    const c = client();
    c.request(CombatMode.Magic);
    expect(c.state).toEqual({ mode: CombatMode.Magic, stance: MAGIC_STANCE });
    c.tick(80);
    c.serverError(0x36); // Player.cpp reject("no-held-item") → NotifyWeenieError(WERROR_INTERRUPTED)
    expect(c.errors).toEqual([MODE_REFUSED_ERROR]);
    expect(c.state).toEqual({ mode: CombatMode.NonCombat, stance: PEACE_STANCE });
    expect(c.tracker.waiting).toBeNull();
  });

  it('melee (sword stance) → magic, refused: back to melee in the sword stance', () => {
    const c = client(CombatMode.Melee, SWORD_STANCE);
    c.request(CombatMode.Magic);
    c.serverError(0x36);
    expect(c.state).toEqual({ mode: CombatMode.Melee, stance: SWORD_STANCE });
  });

  it('two requests before the answer: back to the mode the server last had', () => {
    const c = client();
    c.request(CombatMode.Melee);
    c.request(CombatMode.Magic);
    c.serverError(0x36);
    expect(c.state).toEqual({ mode: CombatMode.NonCombat, stance: PEACE_STANCE });
  });

  it('taken (the server moved the body into the magic stance): a later ActionCancelled leaves the mode alone', () => {
    const c = client();
    c.request(CombatMode.Magic);
    c.serverStance(MAGIC_STANCE);
    expect(c.tracker.waiting).toBeNull();
    c.serverError(0x36);
    expect(c.state).toEqual({ mode: CombatMode.Magic, stance: MAGIC_STANCE });
  });

  it("a movement in the old stance doesn't take it; the refusal after it still undoes it", () => {
    const c = client();
    c.request(CombatMode.Magic);
    c.tracker.stance(combatModeOfStance(PEACE_STANCE));
    expect(c.tracker.waiting).toBe(CombatMode.Magic);
    c.serverError(0x36);
    expect(c.state.mode).toBe(CombatMode.NonCombat);
  });

  it("ACE's CombatMode int settles it (end of retail): a later ActionCancelled is not read as a refusal", () => {
    const c = client();
    c.request(CombatMode.Magic);
    c.tracker.serverMode();
    c.serverError(0x36);
    expect(c.state.mode).toBe(CombatMode.Magic);
  });

  it('other errors, or an ActionCancelled long after the request, change nothing', () => {
    const c = client();
    c.request(CombatMode.Magic);
    c.serverError(0x3f8); // some other WERROR
    expect(c.state.mode).toBe(CombatMode.Magic);
    expect(c.tracker.waiting).toBe(CombatMode.Magic);
    c.tick(MODE_REFUSAL_WINDOW_MS + 1);
    c.serverError(0x36);
    expect(c.state.mode).toBe(CombatMode.Magic);
    expect(c.tracker.waiting).toBeNull();
  });

  it('combatModeOfStance reads the player stances', () => {
    expect(combatModeOfStance(PEACE_STANCE)).toBe(CombatMode.NonCombat);
    expect(combatModeOfStance(MAGIC_STANCE)).toBe(CombatMode.Magic);
    expect(combatModeOfStance(SWORD_STANCE)).toBe(CombatMode.Melee);
    expect(combatModeOfStance(0x8000003f)).toBe(CombatMode.Missile);
    expect(combatModeOfStance(0x41000003)).toBeNull();
  });
});

describe("the cast's auto-switch sends the cast only once the server took magic mode", () => {
  const gate = (c: ReturnType<typeof client>) => {
    const sent: string[] = [];
    const deps = {
      mode: () => c.state.mode,
      waiting: () => c.tracker.waiting,
      schedule: (fn: () => void, ms: number) => { setTimeout(fn, ms); },
      cast: () => sent.push('cast'),
      suppressed: () => sent.push('suppressed'),
    };
    return { sent, start: () => setTimeout(() => castOnceMagicTaken(deps, 500), 500) };
  };

  it('refused: no cast goes out', async () => {
    vi.useFakeTimers();
    try {
      const c = client();
      const g = gate(c);
      c.request(CombatMode.Magic);
      g.start();
      await vi.advanceTimersByTimeAsync(300);
      c.serverError(0x36);
      await vi.advanceTimersByTimeAsync(5000);
      expect(g.sent).toEqual(['suppressed']);
    } finally { vi.useRealTimers(); }
  });

  it('refused after the first check (a slow server): still no cast', async () => {
    vi.useFakeTimers();
    try {
      const c = client();
      const g = gate(c);
      c.request(CombatMode.Magic);
      g.start();
      await vi.advanceTimersByTimeAsync(900);
      expect(g.sent).toEqual([]);
      c.serverError(0x36);
      await vi.advanceTimersByTimeAsync(5000);
      expect(g.sent).toEqual(['suppressed']);
    } finally { vi.useRealTimers(); }
  });

  it('taken: the cast goes out once the magic stance arrives', async () => {
    vi.useFakeTimers();
    try {
      const c = client();
      const g = gate(c);
      c.request(CombatMode.Magic);
      g.start();
      await vi.advanceTimersByTimeAsync(700);
      expect(g.sent).toEqual([]);
      c.serverStance(MAGIC_STANCE);
      await vi.advanceTimersByTimeAsync(200);
      expect(g.sent).toEqual(['cast']);
    } finally { vi.useRealTimers(); }
  });

  it('no word from the server at all: the cast goes after the window, as before', async () => {
    vi.useFakeTimers();
    try {
      const c = client();
      const g = gate(c);
      c.request(CombatMode.Magic);
      g.start();
      await vi.advanceTimersByTimeAsync(MODE_REFUSAL_WINDOW_MS + 200);
      expect(g.sent).toEqual(['cast']);
    } finally { vi.useRealTimers(); }
  });
});
