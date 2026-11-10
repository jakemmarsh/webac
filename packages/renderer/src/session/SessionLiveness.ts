/**
 * UX.chargen-resume (live check, 2026-10-29) — "did a session just end under
 * the player?", and whether this session already had its character list.
 *
 * The connection's 'disconnected' event carries `everOpened`: whether THAT
 * socket ever opened (ClientConnection.wsEverOpened / Connection1999.everOpened,
 * per socket on purpose: a never-opened socket after leaving for the launcher
 * must read as CantSocket, not as a dropped session). A session drops when its
 * socket had opened and the close was not our own.
 *
 * The live check that found it: tools/probe-client-suspend.ts opened chargen
 * over the connecting screen, the login was in its stale-session retry gap
 * (CharacterError.Logon: the connection detaches and opens a fresh socket 3 s
 * later), the relay died, and the retry's socket failed: CantSocket, then
 * disconnected(everOpened=false). That session never reached the character
 * list, so not resuming it is right.
 *
 * A never-opened socket cannot end a session that had its list: the stale-
 * session retry is the only socket a connection opens on its own (the network
 * layer has no other reconnect; docs/reconnect.md), it is scheduled only
 * before a list (ClientConnection.sessionPastLogin) and a list cancels it.
 * Until 2026-11-10 a `live` term covered that case for the network layer's
 * dormant auto-reconnect, now deleted.
 */

/** The slice of a 'disconnected' / 'error' event the decision reads. */
export interface SessionEndEvent {
  everOpened?: boolean;
  deliberate?: boolean;
}

export class SessionLiveness {
  private live = false;

  /** The page starts a connect (page load, relaunch, resume, launcher, a login retry it schedules). */
  noteConnectAttempt(): void { this.live = false; }

  /** The character list arrived: this session is live. */
  noteCharacterList(): void { this.live = true; }

  /** The session's end was reported ('disconnected'). */
  noteEnded(): void { this.live = false; }

  /** A character list arrived since the page's last connect, and the session has not ended. */
  get isLive(): boolean { return this.live; }
}

/** A session ended under the player: its socket had opened, and the close was not our own. */
export function sessionDropped(event: SessionEndEvent): boolean {
  return event.deliberate !== true && event.everOpened === true;
}

/**
 * UX.chargen-resume (AC1999 live check, 2026-10-29) — what a character list
 * does, given whether one already arrived in this session (`live`) and the
 * screen it lands on.
 *
 * The AC1999 server sends the list twice per login on purpose
 * (reference/ac1999 Server/Source/Client.cpp, after the 0xF65A news: "re-sent
 * char list as a sequence probe so a lost news tail is detectable"; the
 * recorded session fixture has both). The second copy arrived 11 ms after the
 * resume had reopened chargen and replaced it with character select. The same
 * copy re-rolled the URL-login empty-account chargen and could offer a draft twice.
 *  - 'first': the session's first list: the whole char-select arrival (draft decision included).
 *  - 'keep_chargen': a repeat while chargen is on screen: keep the list data, change nothing on screen.
 *  - 'repeat': a repeat elsewhere (ACE's list after a logoff or a delete, 1999's after a create):
 *    character select as before, but the draft decision (made on the first list) does not run again.
 */
export type CharacterListRole = 'first' | 'keep_chargen' | 'repeat';

export function characterListRole(live: boolean, screen: string | null | undefined): CharacterListRole {
  if (!live) return 'first';
  return screen === 'character-create' ? 'keep_chargen' : 'repeat';
}
