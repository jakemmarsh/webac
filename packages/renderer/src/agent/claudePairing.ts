/**
 * AGENT.hosted-mcp-connector, step 3 — pairing Claude with this game, typed
 * in chat (docs/hosted-agent-connector.md §5). Claude's connect page shows a
 * one-time code; the player types it here while logged in, so the game
 * server's own login proves the account and no password is asked for or kept.
 *
 *   /automation pair ABC-123   bind the waiting Claude to this account; the tab answers Claude from now on
 *   /automation unpair         revoke every Claude grant for this account and stop answering
 *   /automation claude         say whether Claude can play this tab, who has control, the last calls
 *   /automation claude on|off  let an already-paired Claude play in this browser (a new browser or device), or stop
 *   /automation pause | resume Claude's calls are refused until resume (agent/claudeControl.ts)
 *
 * The tab's opt-in persists per bridge + account (browser storage), so a
 * reload or reconnect keeps answering the Claude the player approved.
 */
export type PairingCommand = { kind: 'pair'; code: string } | { kind: 'unpair' } | { kind: 'status' } | { kind: 'switch'; on: boolean } | { kind: 'pause' } | { kind: 'resume' };

export function parsePairingCommand(line: string): PairingCommand | null {
  const m = /^[/@]automation\s+(pair|unpair|claude|pause|resume)\b\s*(.*)$/i.exec(line.trim());
  if (!m) return null;
  const verb = m[1].toLowerCase();
  if (verb === 'unpair') return { kind: 'unpair' };
  if (verb === 'claude') {
    const arg = m[2].trim().toLowerCase();
    if (arg === 'on' || arg === 'off') return { kind: 'switch', on: arg === 'on' };
    return arg ? null : { kind: 'status' };
  }
  if (verb === 'pause' || verb === 'resume') return m[2].trim() ? null : { kind: verb };
  return { kind: 'pair', code: m[2].trim() };
}

/** The pairing frames the tab sends the bridge. */
export const pairFrame = (code: string): string => JSON.stringify({ pair: code });
export const UNPAIR_FRAME = JSON.stringify({ unpair: true });

/** Where this tab's opt-in is kept: one per bridge and account. */
export const relayOptInKey = (bridgeUrl: string, account: string): string => `acjs.claude-relay:${bridgeUrl}:${account.toLowerCase()}`;

/** When this tab last unpaired, on the bridge's clock (the bridge refuses grants made before it). */
export const relayRevokedKey = (optInKey: string): string => `${optInKey}:revoked-before`;
export function readRevokedBefore(storage: Pick<Storage, 'getItem'> | null, optInKey: string): number {
  try { const n = Number(storage?.getItem(relayRevokedKey(optInKey))); return Number.isFinite(n) && n > 0 ? n : 0; } catch { return 0; }
}
export function writeRevokedBefore(storage: Pick<Storage, 'setItem'> | null, optInKey: string, at: number): void {
  try { storage?.setItem(relayRevokedKey(optInKey), String(Math.round(at))); } catch { /* storage blocked: this session's bridge still revoked it */ }
}

export function readRelayOptIn(storage: Pick<Storage, 'getItem'> | null, key: string): boolean {
  try { return storage?.getItem(key) === 'on'; } catch { return false; }
}
export function writeRelayOptIn(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, key: string, on: boolean): void {
  try { if (on) storage?.setItem(key, 'on'); else storage?.removeItem(key); } catch { /* storage blocked: on for this session only */ }
}

/** The chat line for a command or the bridge's answer. */
export function pairingLine(e: { kind: 'paired' | 'unpaired'; ok: boolean; message: string } | { kind: 'status'; on: boolean } | { kind: 'switch'; on: boolean } | { kind: 'usage' }): string {
  if (e.kind === 'switch') return e.on ? 'Claude can play this character in this browser (a Claude you paired before keeps working). /automation claude off stops it.' : 'Claude is switched off in this browser. /automation claude on lets it play again; /automation unpair disconnects it everywhere.';
  if (e.kind === 'usage') return 'Type the code from Claude\'s connect page: /automation pair ABC-123';
  if (e.kind === 'status') return e.on ? 'Claude can play this character. /automation unpair stops it.' : 'Claude is not connected to this tab. Already paired Claude elsewhere? /automation claude on. New? Add the connector in Claude, then type the code it shows: /automation pair ABC-123';
  if (e.kind === 'unpaired') return e.ok ? `Claude is disconnected: ${e.message}.` : `Couldn't disconnect Claude: ${e.message}.`;
  return e.ok ? `Claude ${e.message}. /automation unpair stops it.` : `Couldn't pair Claude: ${e.message}.`;
}
