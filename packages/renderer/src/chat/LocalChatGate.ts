/**
 * The 1999 client's @chat off switch (BUG.ac1999-chat-toggle-local): a
 * client-only flag that hides local speech. The 1999 client.exe keeps it at
 * UI+0x5a0: CmdHandlers_DoChatToggle → UI_SetLocalChatSquelched @ 0x4d0470
 * sets it and prints the confirmation, sending nothing to the server;
 * UI_ShouldHearSpeaker @ 0x4d0360 (called by the HearSpeech 0x37 case and the
 * HearEmote worker 0x4cd610) then returns 0, hiding the line, for any speaker
 * id other than 0 (reference/ac1999 kb client-behavior/squelch-list.md).
 * Tells and channel chat are not gated. It lasts for the client session.
 *
 * Used only where eraClientRules().chatToggle is 'local'; end of retail's
 * @chat asks the server (Event_ModifyGlobalSquelch 0x5B) instead.
 */
export class LocalChatGate {
  private squelched = false;

  /** UI_IsLocalChatSquelched. */
  get isSquelched(): boolean {
    return this.squelched;
  }

  /** UI_SetLocalChatSquelched: set the flag; returns the line the 1999 client prints. */
  set(squelched: boolean): string {
    this.squelched = squelched;
    return squelched ? 'Local chat is now squelched.' : 'Local chat is no longer squelched.';
  }

  /** UI_ShouldHearSpeaker's @chat test: a local speech / emote line from `speakerGuid` is shown. */
  hears(speakerGuid: number): boolean {
    return speakerGuid === 0 || !this.squelched;
  }
}
