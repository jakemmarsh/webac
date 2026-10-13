/**
 * Mag-Tools' Log Out on Death and Open Main Pack On Login (docs/plugin-specs/magtools.md §9.6,
 * §9.7), rebuilt from the spec (clean room).
 */
import type { MtOptions } from './options.js';

/** Your character died (our own death, not someone else's): log out when Log Out on Death is on (default off). */
export function mtLogOutOnDeath(options: MtOptions, myDeath: boolean): boolean {
  return myDeath && options.bool('Misc.LogOutOnDeath');
}

/** Login Complete: "use" your own character (opening the main pack) when Open Main Pack On Login is on (default on). */
export function mtOpenMainPackOnLogin(options: MtOptions): boolean {
  return options.bool('Misc.OpenMainPackOnLogin');
}
