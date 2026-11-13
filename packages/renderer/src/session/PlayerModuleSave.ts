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
 * go out BEFORE the connection is torn down (an older unload handler
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
 * main.ts's page-leave wiring. On `pagehide` (the page is really going: closed,
 * navigated away, or put in the back/forward cache): the reporters read the
 * screen FIRST (PreworldReporter.pageUnloading), then the save + disconnect,
 * then `after`. The disconnect tears the world down, so a reporter that read
 * the screen later saw 'connecting' and counted every in-world tab close as a
 * pre-world walk-away.
 *
 * BUG.beforeunload-silent-disconnect — this ran on `beforeunload` until
 * 2026-11-12. beforeunload is a request, not a departure: a "Leave site?"
 * prompt answered Stay, or a navigation that turned into a download or an
 * external protocol, keeps the page, and production saw the session closed
 * under a player in chargen (a deliberate close, so no resume: FINISH went out
 * on a dead socket and timed out) and the telemetry sample frozen at
 * chargen/skills for the rest of the page. beforeunload was chosen only to stop
 * zombie sockets (50fc1c8e2); pagehide covers that, and fires in every
 * browser where beforeunload does not (iOS Safari). The server still gets the
 * clean CharacterLogOff + Disconnect on a real unload.
 *
 * `pageshow` with `persisted` (back from the back/forward cache, the session
 * closed): the reporters are live again (`reporter.pageRestored`) and
 * `restored` runs (main.ts: PageHideClose.shown, the drop's resume).
 * `closing` runs before the disconnect, only when a session is connected.
 */
export interface PageLeaveTarget {
  addEventListener(type: 'pagehide' | 'pageshow', listener: (ev: { persisted?: boolean }) => void): void;
}

export function installUnloadSessionClose(
  win: PageLeaveTarget,
  o: {
    module: PlayerModuleFlush;
    connection: { disconnect(): void; readonly isConnected?: boolean };
    reporter?: { pageUnloading(): void; pageRestored?(): void } | null;
    after?: () => void;
    closing?: () => void;
    restored?: (persisted: boolean) => void;
  },
): void {
  win.addEventListener('pagehide', () => {
    try { o.reporter?.pageUnloading(); } catch { /* reporting must never block the save */ }
    if (o.connection.isConnected !== false) {
      try { o.closing?.(); } catch { /* never blocks the save */ }
    }
    closeSessionOnUnload(o.module, o.connection);
    o.after?.();
  });
  win.addEventListener('pageshow', (ev) => {
    const persisted = ev?.persisted === true;
    if (persisted) {
      try { o.reporter?.pageRestored?.(); } catch { /* reporting never blocks the resume */ }
    }
    o.restored?.(persisted);
  });
}
