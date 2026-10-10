/**
 * When the client tells the server it is done teleporting — retail's
 * LoginComplete (GameAction 0xA1, ACE GameActionLoginComplete →
 * Player.OnTeleportComplete: un-hide, stop Teleporting, CheckMonsters).
 * DECOMP.login-complete-timing.
 *
 * Retail (decompiled EoL client) never sends it on the PlayerTeleport
 * message. It is sent from gmSmartBoxUI::UseTime @ 004d6e30 when the
 * teleport animation finishes: at the end of TAS_WORLD_FADE_IN (the world
 * has zoomed back in, decomp :207609) — on the first login as well as on
 * every later teleport, since both run the portal-space animation — or, with
 * no animation running, when SmartBox::teleport_occured reports one (:207453).
 *
 * Both call `CPlayerSystem::SendLoginCompleteNotification @ 00562e90`, which
 * sends only when the player's weenie exists and
 * `ACCWeenieObject::AllContainedObjectsExist @ 0058c000` (every item and
 * container in the player's inventory lists has been created); otherwise it
 * sets `sendLoginCompletePending`. `AttemptSendLoginCompleteNotification
 * @ 00562f20` retries a pending send once `player_desc_received` is set and
 * the contents exist — called as contained objects arrive (@ 345886) and
 * after the PlayerDescription is applied (@ 346045).
 */

export interface LoginCompleteDeps {
  /** Queue the LoginComplete game action. */
  send(): void;
}

export class LoginCompleteNotifier {
  /** CPlayerSystem::sendLoginCompletePending. */
  private pending = false;
  /** CPlayerSystem::player_desc_received. */
  private playerDescReceived = false;
  /** Our player's CreateObject has arrived (GetWeenieObject(playerID) != null). */
  private playerExists = false;
  /** The player's inventory lists (items + containers) from the PlayerDescription. */
  private contained: readonly number[] = [];
  /** Guids with a live CreateObject (ClientObjMaintSystem::GetWeenieObject). */
  private readonly created = new Set<number>();

  constructor(private readonly deps: LoginCompleteDeps) {}

  /** Whether a send is waiting on the contained objects. */
  get isPending(): boolean { return this.pending; }

  /** CPlayerSystem::player_desc_received: this session's PlayerDescription has arrived. */
  get hasPlayerDescription(): boolean { return this.playerDescReceived; }

  /** A new character session (logout / reconnect): forget everything. */
  reset(): void {
    this.pending = false;
    this.playerDescReceived = false;
    this.playerExists = false;
    this.contained = [];
    this.created.clear();
  }

  /** Our own CreateObject arrived. */
  notePlayerCreated(): void {
    this.playerExists = true;
  }

  /** Any other CreateObject; retries a pending send (the @ 345886 call). */
  noteObjectCreated(guid: number): void {
    this.created.add(guid >>> 0);
    this.attempt();
  }

  /**
   * DeleteObject — the weenie no longer exists, and a destroyed item has
   * left the player's lists too (retail removes it from its container on
   * delete), so a consumed potion never blocks a later teleport's send.
   */
  noteObjectDeleted(guid: number): void {
    const g = guid >>> 0;
    this.created.delete(g);
    this.contained = this.contained.filter((c) => c !== g);
  }

  /**
   * The PlayerDescription was applied: its inventory list (items and
   * containers, PlayerDescriptionParser.inventoryPlacement) becomes the
   * player's contained lists; then AttemptSend (@ 346045).
   */
  notePlayerDescription(containedGuids: readonly number[]): void {
    this.contained = containedGuids.map((g) => g >>> 0);
    this.playerDescReceived = true;
    this.attempt();
  }

  /**
   * The PlayerDescription arrived, parsed or not. A description our parser
   * cannot fully read still sets player_desc_received (with no contained
   * lists to wait on): ACE keeps the player Hidden until LoginComplete, so a
   * parser gap must never leave them in the purple bubble.
   */
  notePlayerDescriptionFrom(desc: { inventoryPlacement: ReadonlyArray<{ guid: number }> } | null): void {
    this.notePlayerDescription(desc ? desc.inventoryPlacement.map((p) => p.guid) : []);
  }

  /** ACCWeenieObject::AllContainedObjectsExist @ 0058c000 over the player's lists. */
  allContainedObjectsExist(): boolean {
    return this.contained.every((g) => this.created.has(g));
  }

  /**
   * CPlayerSystem::SendLoginCompleteNotification @ 00562e90 — the teleport
   * animation finished. Sends now, or leaves the send pending.
   */
  sendLoginCompleteNotification(): void {
    if (this.playerExists && this.allContainedObjectsExist()) {
      this.pending = false;
      this.deps.send();
      return;
    }
    this.pending = true;
  }

  /** Contained guids that never got a CreateObject (what a pending send waits on). */
  missingContained(): number[] {
    return this.contained.filter((g) => !this.created.has(g));
  }

  /**
   * Safety valve (not retail): a send still pending after the grace period
   * goes out anyway. Retail waits forever for AllContainedObjectsExist, but
   * here an item the server never creates would leave the player Hidden (the
   * purple bubble) for the whole session. Returns the guids that were
   * missing, or null when nothing was pending.
   */
  forceSendIfPending(): number[] | null {
    if (!this.pending || !this.playerExists) return null;
    const missing = this.missingContained();
    this.pending = false;
    this.deps.send();
    return missing;
  }

  /** CPlayerSystem::AttemptSendLoginCompleteNotification @ 00562f20. */
  private attempt(): void {
    if (!this.playerDescReceived || !this.playerExists) return;
    if (!this.allContainedObjectsExist() || !this.pending) return;
    this.sendLoginCompleteNotification();
  }
}
