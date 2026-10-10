/**
 * When the gameplay UI (the HUD) comes up for a session.
 *
 * Retail: gmCharacterManagementUI::RecvNotice_BeginEnterWorld @ 004e79f0 →
 * QueueUIMode(0x10000008), and gmGamePlayUI's constructor @ 004ea010 builds
 * the gameplay layout (SetupChildren @ 004e9ec0: the 3D view, radar, vitals,
 * chat windows) and Show(true)s it at once, so the login tunnel runs under the
 * HUD. (RecvNotice_PlayerDescReceived @ 004eb660 later loads the saved screen
 * layout.)
 *
 * Ours (main.ts): when a streamed-DAT login hold begins, the HUD comes up as
 * soon as its art is resident (LayoutRenderer draws once), while the hold is
 * still running; otherwise when the game starts. Before 2026-10-09 it waited
 * for the hold to release, so a fresh login showed bare portal space.
 */
export class GameplayUiShow {
  private shown = false;
  /** Bumped by reset(): a readiness wait from an earlier session never shows this one's UI. */
  private session = 0;

  constructor(private readonly show: () => void) {}

  get isShown(): boolean { return this.shown; }

  /** Bring the gameplay UI up (once per session). */
  enter(): void {
    if (this.shown) return;
    this.shown = true;
    this.show();
  }

  /**
   * Bring it up once `ready` (the HUD's art) resolves, if `stillWanted()`
   * (the arrival is still held) — never after a reset in between. A failed
   * wait leaves it to the game start.
   */
  enterWhen(ready: Promise<unknown>, stillWanted: () => boolean): void {
    if (this.shown) return;
    const session = this.session;
    ready.then(() => { if (session === this.session && stillWanted()) this.enter(); }, () => { /* the game start shows it */ });
  }

  /** The session ended (logout, disconnect): the next one shows it again. */
  reset(): void {
    this.shown = false;
    this.session++;
  }
}
