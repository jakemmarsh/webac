/**
 * UX.chargen-resume (live check, 2026-10-29) — "did a session that was live
 * just end under the player?", asked of the whole session rather than of the
 * socket that happened to close last.
 *
 * The connection's 'disconnected' event carries `everOpened`: whether THAT
 * socket ever opened (ClientConnection.wsEverOpened / Connection1999.everOpened,
 * per socket on purpose: a never-opened socket after leaving for the launcher
 * must read as CantSocket, not as a dropped session). The connection can open
 * a socket of its own between the page's connects: the stale-session login
 * retry (CharacterError.Logon → detach, then a fresh socket 3 s later) and the
 * dormant autoReconnect. When such a socket fails, its 'disconnected' says
 * everOpened=false, and the page treated it as "nothing was live": no resume,
 * no ServerDied, and the CantSocket error before it raised the refusal dialog.
 *
 * The live check that found it: tools/probe-client-suspend.ts opened chargen
 * over the connecting screen (its char-select wait accepted the connecting
 * screen), the login was in its stale-session retry gap, the relay died, and
 * the retry's socket failed: CantSocket, then disconnected(everOpened=false).
 * That session never reached the character list, so not resuming it is right;
 * but the rule now says so explicitly: a session is live from its character
 * list until it ends or the page starts another connect, whichever socket
 * carries it, and a live session's end is a drop even if the socket that
 * reported it never opened.
 */

/** The slice of a 'disconnected' / 'error' event the decision reads. */
export interface SessionEndEvent {
  everOpened?: boolean;
  deliberate?: boolean;
  netErrorId?: string;
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

/**
 * A session ended under the player: not our own close, and either the
 * closing socket had opened or the session behind it had reached its
 * character list (`live`).
 */
export function sessionDropped(event: SessionEndEvent, live: boolean): boolean {
  return event.deliberate !== true && (event.everOpened === true || live);
}

/**
 * A socket the connection opened on its own for a live session could not
 * open (CantSocket): the 'disconnected' that follows ends the session (and
 * resumes it), so the error itself raises nothing. Never during the page's
 * own resume, whose failed attempts are counted where they are.
 */
export function liveSessionSocketFailed(event: SessionEndEvent, live: boolean, resuming: boolean): boolean {
  return live && !resuming && event.netErrorId === 'ID_NetError_CantSocket';
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
