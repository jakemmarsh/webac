/**
 * AGENT.hosted-mcp-connector, step 3 — the game side of pairing Claude
 * (agent/claudePairing.ts): the chat commands, the frames the tab sends, the
 * bridge's answers (ClientConnection.parsePairingReply, emitted as
 * 'agentPairing' by the connection), the per-account opt-in, and the lines the
 * player reads.
 */
import { describe, expect, it } from 'vitest';
import { UNPAIR_FRAME, pairFrame, pairingLine, parsePairingCommand, readRelayOptIn, readRevokedBefore, relayOptInKey, writeRelayOptIn, writeRevokedBefore } from '../packages/renderer/src/agent/claudePairing';
import { ClientConnection, parsePairingReply, type ConnectionEvent } from '../packages/network/src/index';

describe('pairing Claude from chat', () => {
  it('commands: pair takes the code as typed; unpair; claude asks for the status; everything else is not one', () => {
    expect(parsePairingCommand('/automation pair abc-234')).toEqual({ kind: 'pair', code: 'abc-234' });
    expect(parsePairingCommand('  @Automation PAIR  XYZ234 ')).toEqual({ kind: 'pair', code: 'XYZ234' });
    expect(parsePairingCommand('/automation pair')).toEqual({ kind: 'pair', code: '' });
    expect(parsePairingCommand('/automation unpair')).toEqual({ kind: 'unpair' });
    expect(parsePairingCommand('/automation claude')).toEqual({ kind: 'status' });
    expect(parsePairingCommand('/automation claude on')).toEqual({ kind: 'switch', on: true });
    expect(parsePairingCommand('/automation Claude OFF')).toEqual({ kind: 'switch', on: false });
    expect(parsePairingCommand('/automation claude maybe')).toBeNull();
    expect(parsePairingCommand('/automation')).toBeNull();
    expect(parsePairingCommand('/automation panel')).toBeNull();
    expect(parsePairingCommand('/automation pairs')).toBeNull();
    expect(parsePairingCommand('/vt start')).toBeNull();
    expect(pairFrame('ABC-234')).toBe('{"pair":"ABC-234"}');
    expect(UNPAIR_FRAME).toBe('{"unpair":true}');
  });

  it('the bridge\'s answers parse; other text is not one', () => {
    expect(parsePairingReply('{"paired":{"ok":true,"message":"is paired (Claude Code): approve it on the page that showed the code"}}')).toEqual({ kind: 'paired', ok: true, message: 'is paired (Claude Code): approve it on the page that showed the code' });
    expect(parsePairingReply('{"unpaired":{"ok":true,"message":"1 connection revoked"}}')).toEqual({ kind: 'unpaired', ok: true, message: '1 connection revoked' });
    expect(parsePairingReply('{"paired":{"ok":false}}')).toEqual({ kind: 'paired', ok: false, message: '' });
    expect(parsePairingReply('{"unpaired":{"ok":true,"message":"m","at":1760000000000}}')).toEqual({ kind: 'unpaired', ok: true, message: 'm', at: 1760000000000 });
    expect(parsePairingReply('{"agent":{"id":1}}')).toBeNull();
    expect(parsePairingReply('{"paired":')).toBeNull();
  });

  it('the connection emits the answer as agentPairing', () => {
    const conn = new ClientConnection('ws://127.0.0.1:1');
    const got: ConnectionEvent[] = [];
    conn.on((e) => got.push(e));
    (conn as unknown as { handleBridgeText(t: string): void }).handleBridgeText('{"paired":{"ok":true,"message":"x"}}');
    expect(got).toEqual([{ type: 'agentPairing', data: { kind: 'paired', ok: true, message: 'x' } }]);
  });

  it('the opt-in is kept per bridge and account; blocked storage just doesn\'t keep it', () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
    const key = relayOptInKey('wss://bridge.playwebac.com/?server=x', 'Jake');
    expect(key).toBe(relayOptInKey('wss://bridge.playwebac.com/?server=x', 'jake'));
    expect(key).not.toBe(relayOptInKey('wss://bridge.playwebac.com/?server=y', 'jake'));
    expect(readRelayOptIn(storage, key)).toBe(false);
    writeRelayOptIn(storage, key, true);
    expect(readRelayOptIn(storage, key)).toBe(true);
    writeRelayOptIn(storage, key, false);
    expect(readRelayOptIn(storage, key)).toBe(false);
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(() => writeRelayOptIn(blocked, key, true)).not.toThrow();
    expect(readRelayOptIn(blocked, key)).toBe(false);
    expect(readRelayOptIn(null, key)).toBe(false);
    // The bridge's unpair time is kept beside the opt-in, for the relay state.
    expect(readRevokedBefore(storage, key)).toBe(0);
    writeRevokedBefore(storage, key, 1760000000000.4);
    expect(readRevokedBefore(storage, key)).toBe(1760000000000);
    expect(readRevokedBefore(blocked, key)).toBe(0);
    expect(() => writeRevokedBefore(blocked, key, 1)).not.toThrow();
  });

  it('the lines the player reads', () => {
    expect(pairingLine({ kind: 'paired', ok: true, message: 'is paired (Claude Code): approve it on the page that showed the code' })).toBe('Claude is paired (Claude Code): approve it on the page that showed the code. /automation unpair stops it.');
    expect(pairingLine({ kind: 'paired', ok: false, message: 'this server has no Claude connector' })).toBe("Couldn't pair Claude: this server has no Claude connector.");
    expect(pairingLine({ kind: 'unpaired', ok: true, message: '1 connection revoked' })).toBe('Claude is disconnected: 1 connection revoked.');
    expect(pairingLine({ kind: 'status', on: false })).toMatch(/not connected to this tab\. Already paired Claude elsewhere\? \/automation claude on\..*\/automation pair/);
    expect(pairingLine({ kind: 'switch', on: true })).toMatch(/^Claude can play this character in this browser/);
    expect(pairingLine({ kind: 'switch', on: false })).toMatch(/^Claude is switched off in this browser/);
    expect(pairingLine({ kind: 'usage' })).toMatch(/\/automation pair ABC-123/);
  });
});
