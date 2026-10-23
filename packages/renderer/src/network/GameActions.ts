/**
 * DEBT.acdebug-production-coupling — the outbound GameActions that real
 * features (Options toggles, spell-bar favorites, barber, fellowship
 * leader/dismiss, the server-load ping heartbeat, spellbook Delete, Report
 * Abuse) ship. They used to live only on the `window.acDebug` console
 * helper, so production code reached them through
 * `(window as any).acDebug?.x?.()`: a debug surface doubling as the send
 * path, silently a no-op whenever acDebug was absent. Production code now
 * calls this typed module directly and acDebug delegates to it.
 *
 * Every method is a no-op before the ACE connection exists (the send
 * function is resolved per call — main.ts assigns it when the session
 * opens), exactly as each acDebug helper's `if (!sendGameAction) return;`
 * guard behaved. Payloads come from the @ac/network builders; each method
 * cites the ACE GameAction handler it matches.
 */
import {
  GameActionType, BinaryWriter,
  buildSetCharacterOptionPayload, buildSetCharacterOptionsPayload, buildAddSpellFavoritePayload,
  buildRemoveSpellFavoritePayload, buildFinishBarberPayload, buildAbuseLogRequestPayload,
  type FinishBarberFields,
} from '@ac/network';

/** Sends one GameAction; false when the inventory-request gate refused it. */
export type SendGameAction = (actionType: GameActionType, payload: Uint8Array) => boolean;

/** The slice of PingLatencyTracker the ping heartbeat needs. */
export interface PingRequestRecorder {
  requestSent(): void;
}

export class GameActions {
  /**
   * @param getSend resolves the live send function (null before the ACE
   *   session is up / after it is torn down).
   * @param ping the latency tracker a PingRequest stamps (FAITHFUL.272).
   */
  constructor(
    private readonly getSend: () => SendGameAction | null,
    private readonly ping: PingRequestRecorder,
  ) {}

  /**
   * The era's spell-bar tab count (eraClientRules().spellBarTabs; BUG.ac1999-spell-tabs): a
   * favorite on a tab past it is never sent. The 1999 client.exe has one bar, and its
   * Event_AddToSpellbar @ 0x53e2d0 carries no bar field at all.
   */
  spellBarTabs = 8;

  /** Whether `barIndex` is a tab this era's spell bar has. */
  private spellBarExists(barIndex: number): boolean {
    return Number.isInteger(barIndex) && barIndex >= 0 && barIndex < this.spellBarTabs;
  }

  /**
   * Toggle a single CharacterOption. Per GameActionSetSingleCharacterOption.cs:
   *   option u32 (CharacterOption enum) + value u32 (bool, 0/1).
   */
  setCharacterOption(option: number, value: boolean): void {
    const send = this.getSend();
    if (!send) return;
    send(GameActionType.SetSingleCharacterOption, buildSetCharacterOptionPayload(option, value));
    console.log(`[AC] Sent SetSingleCharacterOption: ${option} = ${value}`);
  }

  /**
   * SWEEP1999.character — send the whole options_ word (SetCharacterOptions 0x1A1 with options1
   * alone), for an option that has no SetSingleCharacterOption code: the 1999 options page's
   * Automatically Create Shortcuts / Invert Mouse Look / Right-click mouselook bits. The 1999 client
   * sends every option change this way (SetCharacterOption1's worker @ 0x593b70; kb
   * Character/0x1A1), and the 1999 adapter keeps the one dword (Misc1999).
   */
  setCharacterOptionsWord(options1: number): void {
    const send = this.getSend();
    if (!send) return;
    send(GameActionType.SetCharacterOptions, buildSetCharacterOptionsPayload({ options1: options1 | 0 }));
    console.log(`[AC] Sent SetCharacterOptions (word): options1=0x${(options1 >>> 0).toString(16)}`);
  }

  /**
   * Add a spell to one of the 8 quickbar pages. Per GameActionAddSpellFavorite.cs:
   *   spellId u32 + spellBarPositionId u32 (slot 0-8) + spellBarId u32 (page 0-7).
   */
  addSpellFavorite(spellId: number, position: number, barIndex: number): void {
    if (!this.spellBarExists(barIndex)) return;
    const send = this.getSend();
    if (!send) return;
    send(GameActionType.AddSpellFavorite, buildAddSpellFavoritePayload(spellId, position, barIndex));
    console.log(`[AC] Sent AddSpellFavorite: spell=${spellId} pos=${position} bar=${barIndex}`);
  }

  /**
   * Remove a spell from a quickbar page. Per GameActionRemoveSpellFavorite.cs:
   *   spellId u32 + spellBarId u32 (page 0-7).
   */
  removeSpellFavorite(spellId: number, barIndex: number): void {
    if (!this.spellBarExists(barIndex)) return;
    const send = this.getSend();
    if (!send) return;
    send(GameActionType.RemoveSpellFavorite, buildRemoveSpellFavoritePayload(spellId, barIndex));
    console.log(`[AC] Sent RemoveSpellFavorite: spell=${spellId} bar=${barIndex}`);
  }

  /**
   * Commit barber appearance changes. Per GameActionFinishBarber.cs +
   * Player_Character.HandleActionFinishBarber: 16 u32 fields matching
   * the StartBarber inbound layout (palette/textures/setup + 2 options).
   */
  finishBarber(fields: FinishBarberFields): void {
    const send = this.getSend();
    if (!send) return;
    send(GameActionType.FinishBarber, buildFinishBarberPayload(fields));
  }

  /** Hand fellowship leadership to a member. Per GameActionFellowshipAssignNewLeader.cs: playerId u32. */
  fellowshipAssignNewLeader(newLeaderId: number): void {
    const send = this.getSend();
    if (!send) return;
    const p = new BinaryWriter(4); p.writeUInt32(newLeaderId);
    send(GameActionType.FellowshipAssignNewLeader, p.toBuffer());
  }

  /** Dismiss a fellowship member (leader-only). Per GameActionFellowshipDismiss.cs: playerId u32. */
  fellowshipDismiss(playerIdToDismiss: number): void {
    const send = this.getSend();
    if (!send) return;
    const p = new BinaryWriter(4); p.writeUInt32(playerIdToDismiss);
    send(GameActionType.FellowshipDismiss, p.toBuffer());
  }

  /**
   * Ping the server (round-trip latency). Per GameActionPingRequest.cs: no
   * payload. FAITHFUL.272 — records the sent timestamp so the matching
   * PingResponse can compute the latency for the 'server-load' indicator.
   * The timestamp is only taken when the request actually goes out.
   */
  pingRequest(): void {
    const send = this.getSend();
    if (!send) return;
    this.ping.requestSent();
    send(GameActionType.PingRequest, new Uint8Array(0));
  }

  /**
   * Remove a learned spell from the player's spellbook. Per
   * GameActionMagicRemoveSpellId.cs: spellId u32 = 4 bytes.
   */
  removeSpellC2S(spellId: number): void {
    const send = this.getSend();
    if (!send) return;
    const p = new BinaryWriter(4);
    p.writeUInt32(spellId);
    send(GameActionType.RemoveSpellC2S, p.toBuffer());
  }

  /** Report Abuse Send — AbuseLogRequest with the name and complaint (buildAbuseLogRequestPayload). No ACE handler: the server no-ops it. */
  abuseLogRequest(name: string, complaint: string): void {
    const send = this.getSend();
    if (!send) return;
    send(GameActionType.AbuseLogRequest, buildAbuseLogRequestPayload(name, complaint));
  }
}
