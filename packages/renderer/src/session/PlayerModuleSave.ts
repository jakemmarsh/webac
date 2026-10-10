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
