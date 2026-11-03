/**
 * One running profile per server account (tools/ac-agent/accountClaim.ts, client.ts startAccount).
 *
 * 2026-11-02, AC1999: eraAccount keeps 6 characters of accountForProfile within the 1999 server's 8, so every profile
 * not starting with "agent" is agent<first letter>99. Profiles rcA and rcB both became agentr99, and starting rcB
 * logged into rcA's account and took its character over without a word. The account names stay (every one on the
 * local 1999 server keeps its profile's character); `start` now refuses the clash, naming the holder and an account
 * of the new profile's own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_ERAS, distinctEraAccount, eraAccount } from '../tools/ac-agent/eras.ts';
import { accountForProfile, type DaemonInfo } from '../tools/ac-agent/state.ts';
import { accountClaimPath, accountHolder, claimAccount, releaseAccount } from '../tools/ac-agent/accountClaim.ts';
import { startAccount } from '../tools/ac-agent/client.ts';

const AC1999 = AGENT_ERAS['ac1999-retail'];
const LIVE = 4242, DEAD = 4243;
const alive = (pid: number) => pid === LIVE || pid === process.pid;
const daemon = (profile: string, account: string, era = 'ac1999-retail', pid = LIVE): DaemonInfo => ({
  profile, era, pid, port: 1, account, character: 'x', url: '', bridgePid: 0, startedAt: '', logFile: '',
});

describe('agent accounts per profile', () => {
  it('keeps every existing account name (the local 1999 server\'s agent accounts, 2026-11-02)', () => {
    // Profile → its account today; the characters on them stay reachable.
    const today: Record<string, string> = {
      claude: 'agentc99', a: 'agenta99', app: 'agenta99', d: 'agentd99', e: 'agente99', fn: 'agentf99', ga: 'agentg99',
      hubera: 'agenth99', inv1999: 'agenti99', k: 'agentk99', lr: 'agentl99', rrange: 'agentr99', snap: 'agents99',
      vt: 'agentv99', wol: 'agentw99', yak: 'agenty99', zed: 'agentz99',
    };
    for (const [p, acct] of Object.entries(today)) expect(eraAccount(accountForProfile(p), AC1999), p).toBe(acct);
    // The clash itself: two profiles, one account.
    expect(eraAccount(accountForProfile('rcA'), AC1999)).toBe('agentr99');
    expect(eraAccount(accountForProfile('rcB'), AC1999)).toBe('agentr99');
    expect(eraAccount(accountForProfile('claude'), AGENT_ERAS.eor)).toBe('agentclaude');
  });

  it('offers each profile an account of its own within the era\'s limit, never one eraAccount gives', () => {
    const a = distinctEraAccount(accountForProfile('rcA'), 'rcA', AC1999);
    const b = distinctEraAccount(accountForProfile('rcB'), 'rcB', AC1999);
    expect(a).not.toBe(b);
    expect(a).toBe(distinctEraAccount(accountForProfile('rcA'), 'rcA', AC1999)); // stable
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const p = `p${i.toString(36)}`;
      const acct = distinctEraAccount(accountForProfile(p), p, AC1999);
      expect(acct).toMatch(/^[a-z0-9]{1,8}$/);
      expect(acct.endsWith('99')).toBe(true);
      expect(acct).not.toMatch(/^agent.99$/);
      seen.add(acct);
    }
    expect(seen.size).toBeGreaterThan(1990);
    for (const era of Object.values(AGENT_ERAS)) {
      const acct = distinctEraAccount(accountForProfile('rcA'), 'rcA', era);
      expect(acct.length).toBeLessThanOrEqual(era.maxAccountLength ?? 20);
      expect(acct).toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe('start refuses an account another running profile plays', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'acjs-acct-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rcB while rcA plays agentr99: refused, naming rcA and an account rcB can use', () => {
    const infos = [daemon('rcA', 'agentr99')];
    let msg = '';
    try { startAccount('rcB', 'rcB', 'ac1999-retail', undefined, { dir, infos, alive }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/^profile "rcB" would log in as account agentr99, which profile "rcA" is playing \(pid 4242\)/);
    const offered = /account=([a-z0-9]+)$/.exec(msg)?.[1];
    expect(offered).toBe(distinctEraAccount('agentrcb', 'rcB', AC1999));
    // With the offered account it starts.
    expect(startAccount('rcB', 'rcB', 'ac1999-retail', offered, { dir, infos, alive })).toBe(offered);
  });

  it('the same profile, another era\'s server, or a stopped daemon is no clash', () => {
    expect(startAccount('rcA', 'rcA', 'ac1999-retail', undefined, { dir, infos: [daemon('rcA', 'agentr99')], alive })).toBe('agentr99');
    // End of retail's ACE is another server: its agentr99 (if any) is another account.
    expect(startAccount('rcB', 'rcB', 'ac1999-retail', undefined, { dir, infos: [daemon('rcA', 'agentr99', 'eor')], alive })).toBe('agentr99');
    // A claim left by a daemon that died.
    expect(claimAccount('agentr99', AC1999, 'rcA', { dir, pid: DEAD, alive, infos: [] })).toBeNull();
    expect(startAccount('rcB', 'rcB', 'ac1999-retail', undefined, { dir, infos: [], alive })).toBe('agentr99');
  });

  it('the daemon\'s exclusive claim: a second profile at the same moment is refused; a dead or released claim is taken', () => {
    expect(claimAccount('agentr99', AC1999, 'rcA', { dir, pid: LIVE, alive, infos: [] })).toBeNull();
    expect(claimAccount('agentr99', AC1999, 'rcB', { dir, pid: process.pid, alive, infos: [] })).toEqual({ profile: 'rcA', pid: LIVE });
    // startDaemon's check sees the claim before rcA's daemon has advertised itself.
    expect(accountHolder('agentr99', AC1999, 'rcB', { dir, alive, infos: [] })).toEqual({ profile: 'rcA', pid: LIVE });
    releaseAccount('agentr99', AC1999, LIVE, dir);
    expect(existsSync(accountClaimPath('agentr99', AC1999, dir))).toBe(false);
    expect(claimAccount('agentr99', AC1999, 'rcB', { dir, pid: process.pid, alive, infos: [] })).toBeNull();
    // Someone else's release leaves the claim alone.
    releaseAccount('agentr99', AC1999, LIVE, dir);
    expect(accountHolder('agentr99', AC1999, 'rcA', { dir, alive, infos: [] })).toEqual({ profile: 'rcB', pid: process.pid });
    // An older daemon with no claim file still counts: the claim is given back.
    expect(claimAccount('agentz99', AC1999, 'zed2', { dir, pid: process.pid, alive, infos: [daemon('zed', 'agentz99')] })).toEqual({ profile: 'zed', pid: LIVE });
    expect(existsSync(accountClaimPath('agentz99', AC1999, dir))).toBe(false);
  });

  it('an account the server would not take is refused before anything starts', () => {
    expect(() => startAccount('x', 'x', 'ac1999-retail', 'Bad!', { dir, infos: [] })).toThrow(/lower-case letters and digits, at most 8/);
    expect(() => startAccount('x', 'x', 'ac1999-retail', 'agentlong99', { dir, infos: [] })).toThrow(/at most 8/);
  });
});
