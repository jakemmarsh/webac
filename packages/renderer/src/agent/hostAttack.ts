/**
 * The agent host's attack (AgentHost.attack / attackPending): the context-menu Attack's
 * auto-enter (CORE.12.a: switch to the weapon's stance first, then swing), and the attack
 * key's press + release once in a combat stance.
 *
 * The stance switch takes a moment, so the swing goes out AUTO_ENTER_DELAY_MS later. Until
 * then the attack counts as pending: AgentApi.attack's loop resends whenever nothing is
 * pending, and each resend made ACE cancel the approach or swing in flight (AttackDone
 * ActionCancelled 0x36). Claude Bulwark stood among rats swinging about once (2026-10-10).
 * The delayed swing also goes through the attack-key path, whose request state the
 * pending check reads, not a bare TargetedMeleeAttack that nothing tracks.
 */
import type { AttackHeightName } from './AgentApi.js';

export const AUTO_ENTER_DELAY_MS = 1000;
/** How long past the delayed swing the attack still counts as pending, for the server's reply. */
const AUTO_ENTER_GRACE_MS = 1000;

export interface HostAttackDeps {
  /** In a melee or missile stance (the attack key works as is). */
  inAttackStance(): boolean;
  /** The stance to enter for the wielded weapon; sendAttack false = nothing to attack with. */
  autoEnterPlan(): { sendAttack: boolean; mode: number };
  changeCombatMode(mode: number): void;
  /** The attack key's press + release on `guid` (AttackRequestController). */
  swing(guid: number, power: number, height: AttackHeightName): void;
  /**
   * Move the combat bar's power slider to `power` before the swing, as a player sets the bar to attack at a power.
   * A swing at a power off the slider made retail's AttackDone handler (EoL @ 0056c500, 1999 @ 0x004f8bb0) re-send at
   * the slider's power after every swing; the AC1999 server refuses that as too soon (BUG.ac1999-melee-never-swings).
   * Unset: the slider stays.
   */
  setSliderPower?(power: number): void;
  /** The attack key's request is waiting on the server or a swing is in progress. */
  requestPending(): boolean;
  now(): number;
  schedule(fn: () => void, ms: number): void;
  /**
   * Whether `guid` can still be swung at (there, not dying, attackable): the stance switch's delayed swing checks it, for
   * a target that died meanwhile drew the client's "You must select a valid combat target before attacking" (Bulwark,
   * 2026-10-18 04:26Z). Unset: always.
   */
  canSwing?(guid: number): boolean;
  /**
   * A use or cast of yours still in progress (the agent host's busy rule: the client's busy count, a pending inventory
   * request, a teleport): the delayed swing doesn't go out then, as AgentApi.attack's loop sends none while busy, and
   * the loop sends it afresh once free. ACE answers a request sent meanwhile "You're too busy!" (Player_Melee
   * HandleActionTargetedMeleeAttack: IsBusy). Unset: never busy.
   */
  busy?(): boolean;
  /**
   * Your body is in the air (a jump, a drop): the delayed swing doesn't go out then either, for ACE refuses it
   * (Player_Melee / Player_Missile: "You can't do that while in the air!"); AgentApi.attack's loop sends it once landed.
   * Unset: never in the air.
   */
  inAir?(): boolean;
}

export function createHostAttack(d: HostAttackDeps): {
  attack(guid: number, power: number, height: AttackHeightName): void;
  pending(): boolean;
} {
  let enteringUntil = 0;
  return {
    attack(guid, power, height) {
      d.setSliderPower?.(power);
      if (d.inAttackStance()) { d.swing(guid, power, height); return; }
      const plan = d.autoEnterPlan();
      if (!plan.sendAttack) return;
      d.changeCombatMode(plan.mode);
      enteringUntil = d.now() + AUTO_ENTER_DELAY_MS + AUTO_ENTER_GRACE_MS;
      d.schedule(() => { if ((!d.canSwing || d.canSwing(guid)) && !d.busy?.() && !d.inAir?.()) d.swing(guid, power, height); else enteringUntil = 0; }, AUTO_ENTER_DELAY_MS);
    },
    pending: () => d.now() < enteringUntil || d.requestPending(),
  };
}
