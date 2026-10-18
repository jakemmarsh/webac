/**
 * The one set of facts every playwebac.com static page, its JSON-LD, llms.txt and llms-full.txt
 * quote, so no two places disagree. Each fact names where it was checked.
 */
export const SITE = 'https://playwebac.com';
export const SOURCE_URL = 'https://github.com/jakemmarsh/webac';
export const ISSUES_URL = 'https://github.com/jakemmarsh/webac/issues';
export const BRIDGE_SERVERS_URL = 'https://bridge.playwebac.com/servers';
/** IndexNow (Bing, Yandex, Seznam…): a public key, served as /<key>.txt to prove the site is ours. */
export const INDEXNOW_KEY = 'a02d73e4d5856bde6e063e189f2f0584';

export const FACTS = {
  /** Wikipedia, Asheron's Call: released 2 November 1999; servers closed 31 January 2017. */
  released: '2 November 1999',
  releasedIso: '1999-11-02',
  shutdown: '31 January 2017',
  /** progress.md 2026-10-12: 21 s to the world for an existing character on the streamed set. */
  timeToWorld: 'usually under a minute',
  /** End-of-retail DATs: portal 926.9 MB + cell 348.1 + highres 133.2 + local 1.0 = 1,409,286,144 bytes. */
  datSize: '1.4 GB',
  /** CLAUDE.md, "Per-run browser profiles": the OPFS DAT cache can reach about 2.4 GB. */
  cacheSize: 'up to about 2.4 GB',
  browsers: 'a current Chrome, Edge, Firefox or Safari on a desktop or laptop',
  needs: 'WebGL 2 and a mouse',
  /** BRIDGE_AUTOMATION_ACCOUNTS=* since 2026-10-11; the Virindi Views-style bar GA 2026-10-14; Splitpea AC1999 only. */
  addons: 'No Decal, but webAC has its own VTank-style automation window and a Virindi Views-style plugin bar, plus Splitpea on AC1999',
  /** serverCompat.ts: every GDL/GDLE world, the classic worlds and AC1999 are "beta". */
  betaNote: 'GDLE, classic and 1999 worlds are in beta',
  license: 'AGPL-3.0',
  licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
  disclaimer: "Asheron's Call is a trademark of its owners. webAC is an unofficial fan project, not affiliated with, endorsed by or sponsored by Warner Bros. Games, Turbine or Standing Stone Games.",
};

/** The site's pages, in nav order. `path` is canonical (trailing slash); `file` is under deploy/web/site/. */
export const PAGES = [
  { id: 'how-to-play', path: '/how-to-play-asherons-call/', nav: 'How to play' },
  { id: 'servers', path: '/servers/', nav: 'Servers' },
  { id: 'mac-linux', path: '/mac-linux/', nav: 'Mac & Linux' },
  { id: 'eras', path: '/eras/', nav: 'Eras' },
  { id: 'about', path: '/about/', nav: 'About' },
];

/** Bridge `era` values (serverCompat.ts) → the label players use. null = end of retail. */
export function eraLabel(era) {
  if (!era) return 'End of retail';
  if (era.startsWith('ac1999')) return '1999 launch';
  return 'Dark Majesty (classic)';
}
export function eraKey(era) {
  if (!era) return 'eor';
  if (era.startsWith('ac1999')) return '1999';
  return 'classic';
}
/** Servers.xml writes GDLE as "GDL". */
export function softwareLabel(emu) {
  if (emu === 'GDL') return 'GDLE';
  return emu || '';
}

/** What a world means for a webAC player, from the bridge's compat + registration + online fields. */
export function worksLabel(s) {
  if (s.compat === 'incompatible') return { key: 'blocked', text: 'Blocks webAC', detail: s.compatReason || '' };
  if (s.online === false) return { key: 'offline', text: 'Offline now', detail: '' };
  if (s.registration) return { key: 'register', text: s.compat === 'beta' ? 'Register first (beta)' : 'Register first', detail: s.registration };
  if (s.compat === 'beta') return { key: 'beta', text: 'Yes (beta)', detail: '' };
  return { key: 'yes', text: 'Yes', detail: '' };
}
