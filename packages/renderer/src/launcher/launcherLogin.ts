/**
 * ERA.switch-login — what a launcher ENTER logs in with, the same whether the
 * world is of this page's era (the login runs now) or of another era (the
 * login is stashed, the page reloads into that era's DATs, and the next page
 * resumes it: era/EraBoot.ts stashEraSwitch / takeEraSwitch).
 *
 * Both paths go through launcherLogin(), so nothing the launcher's own ENTER
 * sets (the socket URL, the World box name, the launcher world, the string
 * wire for the world's emulator) is lost or left era-shaped by the reload.
 */
import type { String16Wire } from '@ac/network';
import { eraProfile, string16WireFor, type EraProfile } from '../era/EraProfiles.js';
import type { EraSwitch } from '../era/EraBoot.js';
import { worldBoxName, type World } from './worldDirectory.js';
import { worldKeyOf } from './launcherStorage.js';

/** A launcher ENTER (LauncherScreen's LauncherChoice). */
export interface LauncherEnter {
  world: World;
  account: string;
  password: string;
  /** The WebSocket URL (bridge + ?server=<id>, the pinned bridge, or a custom bridge). */
  connectUrl: string;
}

/** What the page logs in with. */
export interface LauncherLogin {
  account: string;
  password: string;
  connectUrl: string;
  /** The char-select World box name (null: the server's own ServerName names it). */
  worldName: string | null;
  /** The launcher world (null: a switch stashed by an older build). */
  world: World | null;
  /** How this world's server reads String16 (GDL / GDLE end-of-retail worlds: Windows-1252). */
  wire: String16Wire;
}

/**
 * The era a launcher world needs. A custom bridge that never answered its
 * era probe (World.eraUnknown) stays in this page's era: reading it as end of
 * retail reloaded an AC1999 page into end of retail for a bridge the socket
 * then could not open either (ID_NetError_CantSocket, playwebac.com
 * 2026-10-13 16:11). A world naming an era this build does not know is
 * blocked at ENTER (worldEnterBlock); it falls back to this page's era here.
 */
export function launcherEraTarget(world: Pick<World, 'era' | 'kind' | 'eraUnknown'>, active: EraProfile): EraProfile {
  if (world.kind === 'custom' && world.eraUnknown) return active;
  return eraProfile(world.era) ?? active;
}

/** The login for an ENTER on a world of `era` (this page's era). */
export function launcherLogin(era: EraProfile, enter: LauncherEnter): LauncherLogin {
  return {
    account: enter.account,
    password: enter.password,
    connectUrl: enter.connectUrl,
    worldName: worldBoxName(enter.world),
    world: enter.world,
    wire: string16WireFor(era, enter.world.emu),
  };
}

/** The switch to stash for an ENTER on a world of `target` (another era). */
export function eraSwitchFor(enter: LauncherEnter, target: EraProfile, now: number): EraSwitch {
  return {
    era: target.id,
    worldKey: worldKeyOf(enter.world),
    worldName: worldBoxName(enter.world),
    connectUrl: enter.connectUrl,
    account: enter.account,
    password: enter.password,
    at: now,
    world: { ...enter.world },
  };
}

/**
 * The stashed switch this page resumes, or null: it must name the era this
 * page booted (a switch whose era could not load falls back to the launcher).
 */
export function resumableEraSwitch(pending: EraSwitch | null, booted: EraProfile): EraSwitch | null {
  return pending && pending.era === booted.id ? pending : null;
}

/** The login a resumed era switch logs in with: what the launcher's ENTER would have. */
export function eraSwitchLogin(era: EraProfile, sw: EraSwitch): LauncherLogin {
  if (sw.world) return launcherLogin(era, { world: sw.world, account: sw.account, password: sw.password, connectUrl: sw.connectUrl });
  return {
    account: sw.account, password: sw.password, connectUrl: sw.connectUrl, worldName: sw.worldName, world: null,
    wire: string16WireFor(era, null),
  };
}
