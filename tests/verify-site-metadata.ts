// @vitest-environment happy-dom
/**
 * SITE.link-preview-metadata — playwebac.com's page metadata: a title,
 * a description and the Open Graph / Twitter tags that link previews
 * (Discord, Reddit, Slack, iMessage) read. The og:image must be a file the
 * web image actually serves: deploy/web/site/ is copied into Caddy's /srv.
 * SITE.seo-basics adds structured data, crawler-readable <noscript> text,
 * robots.txt, sitemap.xml and llms.txt.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const html = readFileSync(resolve(ROOT, 'packages/renderer/index.html'), 'utf8');
const doc = new DOMParser().parseFromString(html, 'text/html');
const meta = (attr: 'name' | 'property', key: string) =>
  doc.querySelector(`meta[${attr}="${key}"]`)?.getAttribute('content') ?? null;

/** JPEG frame size from the first SOFn marker. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < buf.length) {
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('no SOF marker');
}

describe('site metadata', () => {
  it('names the site and describes it', () => {
    expect(doc.title).toContain('webAC');
    expect(meta('name', 'description')).toMatch(/Asheron's Call/);
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://playwebac.com/');
  });

  it('has the Open Graph and Twitter tags a link preview reads', () => {
    for (const key of ['og:type', 'og:site_name', 'og:url', 'og:title', 'og:description', 'og:image', 'og:image:alt']) {
      expect(meta('property', key), key).toBeTruthy();
    }
    expect(meta('name', 'twitter:card')).toBe('summary_large_image');
  });

  it('points og:image at a shipped file of the declared size', () => {
    const url = new URL(meta('property', 'og:image')!);
    expect(url.origin).toBe('https://playwebac.com');
    const file = resolve(ROOT, 'deploy/web/site', url.pathname.slice(1));
    expect(statSync(file).size).toBeLessThan(5 * 1024 * 1024); // Open Graph consumers cap images at ~5–8 MB
    const { width, height } = jpegSize(readFileSync(file));
    expect(String(width)).toBe(meta('property', 'og:image:width'));
    expect(String(height)).toBe(meta('property', 'og:image:height'));
  });

  it('the web image serves deploy/web/site/ from the site root', () => {
    const lines = readFileSync(resolve(ROOT, 'deploy/web/Dockerfile'), 'utf8').split('\n');
    const caddyStage = lines.findIndex((l) => /^FROM .*caddy/.test(l));
    const copy = lines.findIndex((l) => l.trim() === 'COPY deploy/web/site/ /srv/');
    expect(caddyStage).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(caddyStage);
  });
});

describe('search and answer-engine basics', () => {
  const site = (f: string) => readFileSync(resolve(ROOT, 'deploy/web/site', f), 'utf8');

  it('carries valid schema.org JSON-LD for the web app', () => {
    const blocks = [...doc.querySelectorAll('script[type="application/ld+json"]')];
    expect(blocks).toHaveLength(1);
    const ld = JSON.parse(blocks[0].textContent ?? '');
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('WebApplication');
    expect(ld.url).toBe('https://playwebac.com/');
    expect(ld.isAccessibleForFree).toBe(true);
    expect(ld.image).toBe(meta('property', 'og:image'));
    expect(ld.sameAs).toContain('https://github.com/jakemmarsh/webac');
  });

  it('has readable <noscript> text naming the game, the servers and the source', () => {
    const ns = doc.querySelector('body > noscript');
    expect(ns).not.toBeNull();
    const text = ns!.innerHTML;
    expect(text).toMatch(/<h1>[^<]*Asheron's Call/);
    for (const word of ['ACE', 'Dark Majesty', 'AC1999', 'GDLE', 'https://github.com/jakemmarsh/webac']) expect(text).toContain(word);
    // The game canvas stays first in the body; the noscript text only shows without JavaScript.
    expect(doc.body.firstElementChild?.id).toBe('game-canvas');
  });

  it('robots.txt allows crawling and names the sitemap, which lists the home and about pages', () => {
    const robots = site('robots.txt');
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(robots).not.toMatch(/^Disallow: \/\s*$/m);
    const sitemapUrl = robots.match(/^Sitemap: (\S+)$/m)?.[1];
    expect(sitemapUrl).toBe('https://playwebac.com/sitemap.xml');
    const sitemap = new DOMParser().parseFromString(site('sitemap.xml'), 'application/xml');
    const locs = [...sitemap.getElementsByTagName('loc')].map((l) => l.textContent);
    expect(locs).toEqual([
      doc.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      about.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    ]);
  });

  it('llms.txt follows the llmstxt.org shape: H1 name, blockquote summary, link list', () => {
    const lines = site('llms.txt').split('\n');
    expect(lines[0]).toBe('# webAC');
    expect(lines.find((l) => l.startsWith('> '))).toMatch(/Asheron's Call client/);
    expect(lines).toContain('## Links');
    expect(lines.filter((l) => /^- \[[^\]]+\]\(https:\/\/[^)]+\)$/.test(l)).length).toBeGreaterThanOrEqual(3);
  });

  // SITE.about-page: a plain text page Google indexes (the home page renders a canvas once JS runs).
  const about = new DOMParser().parseFromString(site('about/index.html'), 'text/html');

  it('the about page is crawlable text with its own canonical URL and preview tags', () => {
    expect(about.title).toMatch(/webAC/);
    expect(about.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://playwebac.com/about/');
    expect(about.querySelector('meta[name="description"]')?.getAttribute('content')).toMatch(/Asheron's Call/);
    expect(about.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(meta('property', 'og:image'));
    const text = about.body.textContent ?? '';
    for (const term of ['ACE', 'Dark Majesty', 'AC1999', 'GDLE', 'Mac', 'AI coding assistant', 'not affiliated']) {
      expect(text).toContain(term);
    }
    expect(text.split(/\s+/).length).toBeGreaterThan(400);
    expect(about.querySelector('a[href="/"]')).not.toBeNull();
  });

  it('the about page FAQ JSON-LD matches its visible questions', () => {
    const ld = JSON.parse(about.querySelector('script[type="application/ld+json"]')?.textContent ?? '');
    expect(ld['@type']).toBe('FAQPage');
    const visible = [...about.querySelectorAll('h3')].map((h) => h.textContent);
    for (const q of ld.mainEntity) {
      expect(q.acceptedAnswer.text.length).toBeGreaterThan(40);
      expect(visible).toContain(q.name);
    }
  });

  it('the about page only references images the web image ships', () => {
    for (const img of about.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? '';
      expect(src.startsWith('/')).toBe(true);
      expect(statSync(resolve(ROOT, 'deploy/web/site', src.slice(1))).size).toBeGreaterThan(10_000);
    }
  });

  it('Caddy revalidates the about page like the home page', () => {
    expect(readFileSync(resolve(ROOT, 'deploy/web/Caddyfile'), 'utf8')).toMatch(/@html path [^\n]*\/about\//);
  });
});
