// @vitest-environment happy-dom
/**
 * SITE.seo-pages — tools/site/build-site.mjs, the generator of playwebac.com's static pages, run on
 * a fixture server feed into a temp directory: every page is complete for search engines and answer
 * engines, the servers page says honestly which worlds work in webAC, internal links resolve, and a
 * page's lastmod moves only when its meaning changes (not when a player count does).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error -- a plain .mjs tool without type declarations
import { buildSite, aboutCount, htmlToText } from '../tools/site/build-site.mjs';
// @ts-expect-error -- a plain .mjs tool without type declarations
import { PAGES } from '../tools/site/facts.mjs';

const ROOT = resolve(__dirname, '..');
const PAGE_PATHS: string[] = (PAGES as Array<{ path: string }>).map((p) => p.path);
const world = (o: Record<string, unknown>): Record<string, any> => ({
  id: String(o.name), emu: 'ACE', type: 'PvE', description: `${o.name} in its own words`, website: null, discord: 'https://discord.gg/x',
  online: true, lastSeen: '2026-10-17T20:00:00Z', population: null, compat: 'ok', compatNote: null, compatReason: null,
  registration: null, registrationUrl: null, era: null, compatWarning: null, perIpLimits: null, ...o,
});
const FEED = {
  mode: 'multi', updatedAt: '2026-10-17T20:00:00Z',
  servers: [
    world({ name: 'Coldeve', population: 698 }),
    world({ name: 'Conquest', population: 230, compat: 'incompatible', compatNote: 'Blocks webAC', compatReason: "Its VPN check refuses webAC players." }),
    world({ name: 'Reefcull', emu: 'GDL', population: 217, compat: 'beta', registration: 'Register on the Reefcull website first.', registrationUrl: 'http://reefcull.example/' }),
    world({ name: 'Levistras', population: 24 }),
    world({ name: 'Seedsow', emu: 'GDL', population: 33, compat: 'beta', era: 'classic-dereth-1-0' }),
    world({ name: 'Snowreap', emu: 'GDL', type: 'PvP', population: 19, compat: 'beta', era: 'classic-dereth-1-0' }),
    world({ name: 'AC1999', emu: 'AC1999', type: null, online: null, compat: 'beta', era: 'ac1999-retail' }),
    world({ name: 'Nexus', type: 'PvP', online: false }),
    world({ name: 'GDLE Test', emu: 'GDL', online: false }),
  ],
};

let out: string;
let lastmodFile: string;
const page = (p: string) => new DOMParser().parseFromString(readFileSync(join(out, p, 'index.html'), 'utf8'), 'text/html');
const ldGraph = (d: Document) => JSON.parse(d.querySelector('script[type="application/ld+json"]')!.textContent!)['@graph'] as Array<Record<string, any>>;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'site-pages-'));
  // The pages reference the screenshots and the link-preview image that already ship in deploy/web/site/.
  cpSync(join(ROOT, 'deploy/web/site/about'), join(out, 'about'), { recursive: true });
  cpSync(join(ROOT, 'deploy/web/site/og-image.jpg'), join(out, 'og-image.jpg'));
  lastmodFile = join(out, 'lastmod.json');
  await buildSite({ outDir: out, feed: FEED, today: '2026-10-17', lastmodFile });
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('every static page', () => {
  it.each(PAGE_PATHS)('%s has one h1, its own canonical URL, a title and description that fit a results page, and preview tags', (path: string) => {
    const d = page(path);
    expect(d.querySelectorAll('h1')).toHaveLength(1);
    expect(d.documentElement.lang).toBe('en');
    expect(d.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://playwebac.com${path}`);
    expect(d.title.length).toBeGreaterThan(20);
    expect(d.title.length).toBeLessThanOrEqual(65);
    const desc = d.querySelector('meta[name="description"]')!.getAttribute('content')!;
    expect(desc.length).toBeGreaterThan(70);
    expect(desc.length).toBeLessThanOrEqual(160);
    expect(d.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(`https://playwebac.com${path}`);
    expect(d.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe('https://playwebac.com/og-image.jpg');
    // The unofficial-fan-project line sits under the headline, not only in the footer.
    expect(d.querySelector('.hero .fan')?.textContent).toMatch(/unofficial/i);
  });

  it('titles and descriptions are unique across pages', () => {
    const titles = PAGES.map((p: { path: string }) => page(p.path).title);
    const descs = PAGES.map((p: { path: string }) => page(p.path).querySelector('meta[name="description"]')!.getAttribute('content'));
    expect(new Set(titles).size).toBe(PAGES.length);
    expect(new Set(descs).size).toBe(PAGES.length);
  });

  it.each(PAGE_PATHS)('%s carries a WebPage + breadcrumb graph whose FAQ questions are all visible on the page', (path: string) => {
    const d = page(path);
    const graph = ldGraph(d);
    const webPage = graph.find((n) => n['@type'] === 'WebPage')!;
    expect(webPage.url).toBe(`https://playwebac.com${path}`);
    expect(webPage.dateModified).toBe('2026-10-17');
    expect(graph.find((n) => n['@type'] === 'BreadcrumbList')!.itemListElement.at(-1).item).toBe(`https://playwebac.com${path}`);
    const faq = graph.find((n) => n['@type'] === 'FAQPage')!;
    const visible = [...d.querySelectorAll('h3')].map((h) => h.textContent);
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(3);
    for (const q of faq.mainEntity) {
      expect(visible).toContain(q.name);
      expect(q.acceptedAnswer.text).not.toMatch(/<[a-z]/i);
    }
    // The visible "last updated" date matches the structured one.
    expect(d.querySelector('time')?.getAttribute('datetime')?.slice(0, 10)).toBe(path === '/servers/' ? '2026-10-17' : webPage.dateModified);
  });

  it('every root-relative link and image resolves to a file the site ships (or the game at /)', () => {
    for (const p of PAGES) {
      const d = page(p.path);
      const refs = [...d.querySelectorAll('a[href^="/"], img[src^="/"], link[href^="/"]')].map((e) => e.getAttribute('href') ?? e.getAttribute('src')!);
      const srcsets = [...d.querySelectorAll('source[srcset], link[imagesrcset]')].flatMap((e) =>
        (e.getAttribute('srcset') ?? e.getAttribute('imagesrcset')!).split(',').map((c) => c.trim().split(' ')[0]));
      for (const ref of [...refs, ...srcsets]) {
        const path = ref.split(/[?#]/)[0];
        if (path === '/') continue;
        const file = join(out, path.endsWith('/') ? `${path}index.html` : path);
        expect(existsSync(file), `${p.path} → ${ref}`).toBe(true);
      }
    }
  });

  it('the inlined stylesheet only names hashed assets that exist', () => {
    const css = page('/eras/').querySelector('style')!.textContent!;
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(8);
    for (const u of urls) {
      expect(u).toMatch(/^\/s\/[\w-]+\.[0-9a-f]{8}\.(webp|woff2|png)$/);
      expect(existsSync(join(out, u))).toBe(true);
    }
  });
});

describe('/servers/', () => {
  it('says which worlds work in webAC instead of claiming they all do', () => {
    const d = page('/servers/');
    const row = (name: string) => d.querySelector(`tr#${name.toLowerCase()}`)!;
    expect(row('Conquest').querySelector('.works')!.textContent).toBe('Blocks webAC');
    expect(row('Conquest').querySelector('.play a')).toBeNull();
    expect(row('Reefcull').querySelector('.works')!.textContent).toBe('Register first (beta)');
    expect(row('Nexus').querySelector('.works')!.textContent).toBe('Offline now');
    expect(row('Coldeve').querySelector('.works')!.textContent).toBe('Yes');
    expect(row('Seedsow').querySelector('.works')!.textContent).toBe('Yes (beta)');
    expect(row('Coldeve').querySelector('.play a')!.getAttribute('href')).toBe('/?world=Coldeve');
    const answer = d.querySelector('.answer')!.textContent!;
    expect(answer).toContain('There are 8 public');
    expect(answer).toContain('works with 7 of them');
    expect(answer).toContain('Conquest block');
    expect(answer).not.toMatch(/play any of them/i);
  });

  it('labels each world with its era and software from the bridge feed, and leaves test worlds out', () => {
    const d = page('/servers/');
    expect(d.querySelector('tr#seedsow .chip')!.textContent).toBe('Dark Majesty (classic)');
    expect(d.querySelector('tr#ac1999 .chip')!.textContent).toBe('1999 launch');
    expect(d.querySelector('tr#coldeve .chip')!.textContent).toBe('End of retail');
    expect(d.querySelector('tr#reefcull')!.textContent).toContain('GDLE');
    expect(d.querySelector('tr#gdle-test')).toBeNull();
  });

  it('states rounded counts and lists every world as a GameServer for machines', () => {
    expect(aboutCount(698)).toBe(700);
    expect(aboutCount(24)).toBe(24);
    expect(aboutCount(null)).toBeNull();
    const d = page('/servers/');
    expect(d.querySelector('tr#coldeve [data-live="pop"]')!.textContent).toBe('700');
    const list = ldGraph(d).find((n) => n['@type'] === 'ItemList')!;
    expect(list.numberOfItems).toBe(8);
    const coldeve = list.itemListElement.find((i: any) => i.item.name === 'Coldeve').item;
    expect(coldeve).toMatchObject({ '@type': 'GameServer', serverStatus: 'https://schema.org/Online', playersOnline: 698 });
    expect(list.itemListElement.find((i: any) => i.item.name === 'Nexus').item.serverStatus).toBe('https://schema.org/OfflineTemporarily');
  });
});

describe('page facts', () => {
  it('the eras page describes the 1999 logout as it was (no bubbles), not as a trip to the sanctuary', () => {
    const text = page('/eras/').body.textContent!;
    expect(text).toContain('no purple bubbles when you log out');
    expect(text).not.toMatch(/returns you to your sanctuary/i);
    expect(text).toContain("end-of-retail interface");
  });

  it('llms.txt names every page, the blocked and register-first worlds, and the developer pointer', () => {
    const llms = readFileSync(join(out, 'llms.txt'), 'utf8');
    for (const p of PAGES) expect(llms).toContain(`https://playwebac.com${p.path}`);
    expect(llms).toContain('Conquest block its relay');
    expect(llms).toContain('Reefcull need registration');
    expect(llms).toContain('## For developers and AI coding agents');
    const full = readFileSync(join(out, 'llms-full.txt'), 'utf8');
    expect(full).toContain("# How to play Asheron's Call today");
    expect(full).not.toMatch(/<[a-z][^>]*>/);
  });

  it('htmlToText keeps headings, list items and table rows readable', () => {
    expect(htmlToText('<h2>A</h2><ul><li>one</li></ul><table><tr><th>x</th><td>y</td></tr></table>'))
      .toBe('## A\n\n- one\n\n| x | y |');
  });

  it('the sitemap lists the home page and every static page with its lastmod', () => {
    const xml = readFileSync(join(out, 'sitemap.xml'), 'utf8');
    for (const p of PAGES) expect(xml).toContain(`<loc>https://playwebac.com${p.path}</loc>\n    <lastmod>2026-10-17</lastmod>`);
    expect(xml).toContain('<loc>https://playwebac.com/</loc>');
  });
});

describe('lastmod', () => {
  it('a rebuild where only player counts moved keeps every date; a world changing what it accepts moves only that page', async () => {
    const moved = { ...FEED, updatedAt: '2026-10-19T20:00:00Z', servers: FEED.servers.map((s): Record<string, any> => ({ ...s, population: s.population == null ? null : s.population + 7 })) };
    await buildSite({ outDir: out, feed: moved, today: '2026-10-19', lastmodFile });
    const dates = JSON.parse(readFileSync(lastmodFile, 'utf8'));
    for (const p of PAGES) expect(dates[p.path].date, p.path).toBe('2026-10-17');

    const reopened = { ...moved, servers: moved.servers.map((s) => (s.name === 'Conquest' ? { ...s, compat: 'ok', compatNote: null, compatReason: null } : s)) };
    await buildSite({ outDir: out, feed: reopened, today: '2026-10-20', lastmodFile });
    const after = JSON.parse(readFileSync(lastmodFile, 'utf8'));
    expect(after['/servers/'].date).toBe('2026-10-20');
    expect(after['/mac-linux/'].date).toBe('2026-10-17');
    writeFileSync(lastmodFile, JSON.stringify(dates));
  });
});
