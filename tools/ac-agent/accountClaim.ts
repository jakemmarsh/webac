/**
 * One running profile per server account.
 *
 * A server account carries one session: a second login to it ends the first (ACE "account in use", the 1999 server
 * the same). Profile accounts come from eraAccount (eras.ts), and AC1999's 8-character limit keeps one letter of the
 * profile, so profiles rcA and rcB both got agentr99: starting rcB logged into rcA's account and took its character
 * over without a word (2026-11-02). Renaming the accounts would strand every character already on them, so the
 * names stay and `start` refuses instead: before spawning (client.ts startDaemon, against the live daemons) and in
 * the daemon itself (an exclusive claim file, so two starts at the same moment can't both pass), naming the profile
 * that holds the account and an account the new profile can use (distinctEraAccount; ac_start account=).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentEra, agentEra, distinctEraAccount } from './eras.ts';
import { type DaemonInfo, STATE_DIR, accountForProfile, listInfos, pidAlive } from './state.ts';

/** Who holds an account: a running profile and its daemon's pid. */
export interface AccountHolder {
  profile: string;
  pid: number;
}

export interface ClaimOptions {
  dir?: string;
  /** This daemon's pid (tests stand in another). */
  pid?: number;
  /** Is this pid alive (tests replace it). */
  alive?: (pid: number) => boolean;
  /** The live daemons (default: listInfos()). */
  infos?: DaemonInfo[];
}

/** Two eras on the same local server (the same UDP ports) share its accounts. */
function sameServer(a: AgentEra, b: AgentEra): boolean {
  return a.ports[0] === b.ports[0] && a.ports[1] === b.ports[1];
}

export function accountClaimPath(account: string, era: AgentEra, dir = STATE_DIR): string {
  return join(dir, `account-${era.ports[0]}-${account.toLowerCase().replace(/[^a-z0-9]/g, '')}.claim`);
}

function readClaim(path: string): AccountHolder | null {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as Partial<AccountHolder>;
    return typeof c.profile === 'string' && typeof c.pid === 'number' ? { profile: c.profile, pid: c.pid } : null;
  } catch {
    return null;
  }
}

/** The running profile other than `profile` that uses `account` on `era`'s server, or null. */
export function accountHolder(account: string, era: AgentEra, profile: string, opts: ClaimOptions = {}): AccountHolder | null {
  const alive = opts.alive ?? pidAlive;
  const claim = readClaim(accountClaimPath(account, era, opts.dir));
  if (claim && claim.profile !== profile && alive(claim.pid)) return claim;
  // Daemons from before claim files (and any whose claim was lost) still advertise their account.
  for (const info of opts.infos ?? listInfos()) {
    if (info.profile === profile || info.account.toLowerCase() !== account.toLowerCase()) continue;
    let theirs: AgentEra;
    try { theirs = agentEra(info.era); } catch { continue; }
    if (sameServer(theirs, era)) return { profile: info.profile, pid: info.pid };
  }
  return null;
}

/**
 * Take `account` on `era`'s server for `profile`: null when it is now this daemon's, else who holds it. A claim
 * whose daemon is gone, or that is this profile's own, is taken over.
 */
export function claimAccount(account: string, era: AgentEra, profile: string, opts: ClaimOptions = {}): AccountHolder | null {
  const dir = opts.dir ?? STATE_DIR;
  const pid = opts.pid ?? process.pid;
  const path = accountClaimPath(account, era, dir);
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ profile, pid, account, at: new Date().toISOString() }) + '\n';
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(path, body, { flag: 'wx' });
      // Exclusive create won; an older daemon without a claim file may still hold it.
      const other = accountHolder(account, era, profile, { ...opts, dir });
      if (other && other.pid !== pid) { releaseAccount(account, era, pid, dir); return other; }
      return null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = readClaim(path);
      if (held && held.profile !== profile && held.pid !== pid && (opts.alive ?? pidAlive)(held.pid)) return held;
      // Stale or our own: remove it and try the exclusive create once more.
      rmSync(path, { force: true });
    }
  }
  const held = readClaim(path);
  return held && held.pid !== pid ? held : null;
}

/** Let go of `account` if this pid holds it. */
export function releaseAccount(account: string, era: AgentEra, pid = process.pid, dir = STATE_DIR): void {
  const path = accountClaimPath(account, era, dir);
  if (readClaim(path)?.pid === pid) rmSync(path, { force: true });
}

/** The refusal: who has the account, and how to start this profile anyway (`base`: the profile its account is named from). */
export function accountClashMessage(profile: string, account: string, era: AgentEra, holder: AccountHolder, base = profile): string {
  const other = distinctEraAccount(accountForProfile(base), profile, era);
  return `profile "${profile}" would log in as account ${account}, which profile "${holder.profile}" is playing (pid ${holder.pid}); a second login would take over its character. Stop "${holder.profile}" first, or start "${profile}" on its own account: account=${other}`;
}
