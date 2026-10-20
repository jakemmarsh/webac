/**
 * PlayerModuleSave — when the dirty PlayerModule (window options, chat
 * filters and opacities: the SetCharacterOptions 0x01A1 GameplayOptions blob)
 * must reach the server before the session ends.
 *
 * Retail (decompiled EoL client):
 *  - CPlayerModule::UseTime @ 0059a710 ships a dirty module once
 *    c_timeUpdateInterval (480 s) has passed since the first change.
 *  - CPlayerSystem::LogOffCharacter @ 00563520 calls
 *    CPlayerModule::SaveToServer(false) @ 0059a660 FIRST, then
 *    ExecuteLogOff / RequestLogOff. So a change made a second before logging
 *    out is saved; it does not wait out the 480 s.
 *  - PlayerOptionPage::SaveCurrentValues (the Options Apply button) also
 *    calls SaveToServer(false).
 *
 * The browser adds one exit retail never had: closing the tab. The save must
 * go out BEFORE the connection is torn down (the old beforeunload handler
 * disconnected first, and the pagehide flush that followed had no socket).
 */

/** The PlayerModule side: send now if dirty (GameUI.flushChatOptionsSave). */
export interface PlayerModuleFlush {
  flushChatOptionsSave(): void;
}

/**
 * BUG.gameplay-options-entry-order — self-repair of a stored module the
 * retail client cannot load. Older webAC saves wrote the GameplayOptions
 * tables out of retail's bucket order; the retail client then hangs entering
 * the world with that character (black world, empty vitals) while every other
 * character on the account works. Nothing on the retail side can overwrite
 * it, so when a login's PlayerDescription carries such a blob (parse flag
 * `needsRepair`), the module is re-saved, now in retail order, as soon as the
 * server accepts SetCharacterOptions: ACE ignores it until LoginComplete
 * (GameActionSetCharacterOptions.cs: FirstEnterWorldDone). The delay keeps
 * the save well behind LoginComplete in ACE's action queue.
 */
export const CHAT_OPTIONS_REPAIR_DELAY_MS = 2000;

export class ChatOptionsRepair {
  private pending = false;

  constructor(private readonly deps: {
    /** Mark the module dirty and send it now (GameUI.markChatOptionsDirty + flushChatOptionsSave). */
    resave(): void;
    schedule(fn: () => void, ms: number): void;
  }) {}

  /** Each PlayerDescription: remember whether its stored module needs rewriting. */
  noteLoginModule(stored: { needsRepair?: boolean } | null | undefined): void {
    this.pending = stored?.needsRepair === true;
  }

  /** LoginComplete went out: the server will now accept the re-save. */
  loginCompleteSent(): void {
    if (!this.pending) return;
    this.pending = false;
    this.deps.schedule(() => this.deps.resave(), CHAT_OPTIONS_REPAIR_DELAY_MS);
  }
}

/** CPlayerSystem::LogOffCharacter: SaveToServer(false), then the logoff request. */
export function logOffCharacter(module: PlayerModuleFlush, connection: { sendCharacterLogOff(): void }): void {
  module.flushChatOptionsSave();
  connection.sendCharacterLogOff();
}

/** Tab close / unload: save first, then tear the connection down. */
export function closeSessionOnUnload(module: PlayerModuleFlush, connection: { disconnect(): void }): void {
  module.flushChatOptionsSave();
  connection.disconnect();
}

/**
 * main.ts's beforeunload: the pre-world reporter reads the screen FIRST
 * (PreworldReporter.pageUnloading), then the save + disconnect, then
 * `after`. The disconnect tears the world down, so a reporter that read the
 * screen later saw 'connecting' and counted every in-world tab close as a
 * pre-world walk-away.
 */
export function installUnloadSessionClose(
  win: { addEventListener(type: 'beforeunload', listener: () => void): void },
  o: { module: PlayerModuleFlush; connection: { disconnect(): void }; reporter?: { pageUnloading(): void } | null; after?: () => void },
): void {
  win.addEventListener('beforeunload', () => {
    try { o.reporter?.pageUnloading(); } catch { /* reporting must never block the save */ }
    closeSessionOnUnload(o.module, o.connection);
    o.after?.();
  });
}
