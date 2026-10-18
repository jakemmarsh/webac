#!/usr/bin/env node
/**
 * Tells IndexNow search engines (Bing and the engines it shares with) which playwebac.com pages
 * changed, so they recrawl them within minutes instead of days. Run after a deploy that changed
 * the static pages; it reads the deployed sitemap and submits every URL in it.
 *
 *   node tools/site/indexnow.mjs            submit
 *   node tools/site/indexnow.mjs --dry-run  print what it would send
 */
import { SITE, INDEXNOW_KEY } from './facts.mjs';

const sitemap = await (await fetch(`${SITE}/sitemap.xml`)).text();
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const keyServed = (await (await fetch(`${SITE}/${INDEXNOW_KEY}.txt`)).text()).trim();
if (keyServed !== INDEXNOW_KEY) throw new Error(`${SITE}/${INDEXNOW_KEY}.txt doesn't serve the key yet: deploy the site first`);
const body = { host: new URL(SITE).host, key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList };
if (process.argv.includes('--dry-run')) { console.log(JSON.stringify(body, null, 2)); process.exit(0); }
const res = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
console.log(`IndexNow: HTTP ${res.status} for ${urlList.length} URLs`);
if (res.status >= 400) process.exit(1);
