#!/usr/bin/env node
/**
 * Build a promo video (YouTube long-form or Short) from recorded takes and an edit list.
 *
 *   node tools/video/build-promo.mjs --edl tools/video/short.mjs --footage <dir> --out <file.mp4>
 *
 * Takes come from `tools/live-drive.ts record` (silent H.264 at 30 fps). The edit list (an ES module
 * whose default export is { width, height, clips, cards? }) names each clip's take, in/out seconds,
 * speed, an optional caption and, for a landscape take in a vertical video, how to fit it. ffmpeg here
 * has no drawtext/libass, so every caption and title card is HTML rendered to a transparent PNG with
 * Playwright and overlaid; that also gives real typography (the site's own fonts).
 *
 * Clip fields:
 *   take      file name in --footage (e.g. 'vcombat3.mp4')
 *   from, to  seconds in the take
 *   speed     playback rate (default 1)
 *   crop      [x, y, w, h] in take pixels before fitting (e.g. to drop the admin vitals bar)
 *   fit       'cover' (fill, crop the overflow; default) or 'box' (whole frame on a blurred fill)
 *   caption   { text, sub?, at?: 'top'|'middle'|'bottom', style?: 'hook'|'plain'|'card' }
 *   card      true: a full-frame title card over the clip (caption.style = 'card')
 * The total length is the sum of (to - from) / speed. Prints chapter marks for clips with `chapter`.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const edlPath = resolve(opt('edl'));
const footage = resolve(opt('footage', '.'));
const out = resolve(opt('out', 'promo.mp4'));
const work = join(dirname(out), `.${out.split('/').pop()}-work`);
mkdirSync(work, { recursive: true });

const edl = (await import(pathToFileURL(edlPath).href)).default;
const { width: W, height: H, clips } = edl;
const here = dirname(fileURLToPath(import.meta.url));
const fontDir = resolve(here, '../site/fonts');

// ── Captions: HTML → transparent PNG ────────────────────────────────────────
// Fonts as data URIs: a setContent page can't load file:// fonts.
const font = (f) => `url(data:font/woff2;base64,${readFileSync(join(fontDir, f)).toString('base64')})`;
const css = `
@font-face { font-family: Uncial; src: ${font('uncial-antiqua-400.woff2')}; }
@font-face { font-family: Alegreya; font-weight: 700; src: ${font('alegreya-sans-700.woff2')}; }
html, body { margin: 0; width: ${W}px; height: ${H}px; background: transparent; overflow: hidden; }
.wrap { position: absolute; left: 0; right: 0; display: flex; flex-direction: column; align-items: center; gap: ${Math.round(W * 0.012)}px; padding: 0 ${Math.round(W * 0.06)}px; text-align: center; }
.top { top: ${Math.round(H * (H > W ? 0.13 : 0.07))}px; } .middle { top: 50%; transform: translateY(-50%); } .bottom { bottom: ${Math.round(H * (H > W ? 0.26 : 0.08))}px; }
.t { font-family: 'Arial Black', 'Arial', sans-serif; font-weight: 900; color: #fff; line-height: 1.08; letter-spacing: -0.01em;
     font-size: ${Math.round(H > W ? W * 0.095 : H * 0.068)}px; -webkit-text-stroke: ${Math.round((H > W ? W : H) * 0.009)}px #000; paint-order: stroke fill;
     text-shadow: 0 ${Math.round(H * 0.004)}px ${Math.round(H * 0.012)}px rgba(0,0,0,.65); }
.t em { font-style: normal; color: #ffd76a; }
.s { font-family: Alegreya, sans-serif; font-weight: 700; color: #fff; font-size: ${Math.round((H > W ? W : H) * 0.045)}px; line-height: 1.2;
     background: rgba(10, 14, 32, .78); border: 2px solid #c9a24a; border-radius: 10px; padding: .25em .7em; }
.plain .t { font-size: ${Math.round((H > W ? W : H) * 0.06)}px; }
.card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${Math.round(H * 0.025)}px;
        background: radial-gradient(ellipse at center, rgba(8,12,34,.5), rgba(4,6,18,.82)); text-align: center; padding: 0 6%; }
.card .k { font-family: Alegreya, sans-serif; font-weight: 700; color: #c9a24a; letter-spacing: .2em; text-transform: uppercase; font-size: ${Math.round((H > W ? W : H) * 0.04)}px; }
.card .h { font-family: Uncial, serif; color: #f3e6c4; font-size: ${Math.round((H > W ? W : H) * 0.11)}px; line-height: 1.05; text-shadow: 0 4px 24px rgba(0,0,0,.8); }
.card .u { font-family: Alegreya, sans-serif; font-weight: 700; color: #fff; font-size: ${Math.round((H > W ? W : H) * 0.05)}px; }
`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/\n/g, '<br>');
function captionHtml(c) {
  if (c.style === 'card') {
    return `<div class="card">${c.kicker ? `<div class="k">${esc(c.kicker)}</div>` : ''}<div class="h">${esc(c.text)}</div>${c.sub ? `<div class="u">${esc(c.sub)}</div>` : ''}</div>`;
  }
  return `<div class="wrap ${c.at ?? 'top'} ${c.style ?? 'hook'}"><div class="t">${esc(c.text)}</div>${c.sub ? `<div class="s">${esc(c.sub)}</div>` : ''}</div>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const capPngs = [];
for (const [i, c] of clips.entries()) {
  if (!c.caption) { capPngs.push(null); continue; }
  const f = join(work, `cap-${String(i).padStart(2, '0')}.png`);
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${captionHtml(c.caption)}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: f, omitBackground: true });
  capPngs.push(f);
}
await browser.close();

// ── Clips: trim, speed, fit, caption → one segment each ─────────────────────
const segs = [];
let t = 0;
const chapters = [];
const srt = []; // every caption as a subtitle cue: upload it as the video's captions (search reads them)
const ts = (x) => { const ms = Math.round(x * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
for (const [i, c] of clips.entries()) {
  const src = join(footage, c.take);
  if (!existsSync(src)) throw new Error(`missing take ${src}`);
  const speed = c.speed ?? 1;
  const dur = (c.to - c.from) / speed;
  if (c.caption) {
    const words = [c.caption.kicker, c.caption.text, c.caption.sub].filter(Boolean).join(' — ').replace(/\*/g, '').replace(/\n/g, ' ');
    srt.push(`${srt.length + 1}\n${ts(t)} --> ${ts(t + dur)}\n${words}\n`);
  }
  if (c.chapter) chapters.push(`${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')} ${c.chapter}`);
  t += dur;
  const crop = c.crop ? `crop=${c.crop[2]}:${c.crop[3]}:${c.crop[0]}:${c.crop[1]},` : '';
  const base = `[0:v]trim=start=${c.from}:end=${c.to},setpts=(PTS-STARTPTS)/${speed},${crop}`;
  let fit;
  if ((c.fit ?? 'cover') === 'box') {
    fit = `${base}split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=28,eq=brightness=-0.12[bg];` +
          `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]`;
  } else {
    fit = `${base}scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}[v0]`;
  }
  const seg = join(work, `seg-${String(i).padStart(2, '0')}.mp4`);
  const inputs = ['-i', src];
  let graph = fit;
  if (capPngs[i]) {
    inputs.push('-loop', '1', '-i', capPngs[i]);
    // Captions pop in over the first 0.15 s, as Shorts captions do.
    graph += `;[1:v]format=rgba,fade=t=in:st=0:d=0.15:alpha=1[cap];[v0][cap]overlay=0:0:shortest=1[v1]`;
  } else graph += ';[v0]null[v1]';
  graph += `;[v1]fps=30,format=yuv420p,setsar=1[v]`;
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', graph, '-map', '[v]', '-t', dur.toFixed(3),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-r', '30', seg], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`segment ${i} failed`);
  segs.push(seg);
}
const list = join(work, 'segs.txt');
writeFileSync(list, segs.map((s) => `file '${s}'`).join('\n'));
const audio = edl.music ? ['-i', resolve(edl.music), '-map', '0:v', '-map', '1:a', '-shortest', '-c:a', 'aac', '-b:a', '192k'] : [];
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...audio, '-c:v', 'copy', '-movflags', '+faststart', out], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('concat failed');
writeFileSync(out.replace(/\.mp4$/, '.srt'), srt.join('\n'));
console.log(`${out} — ${t.toFixed(1)} s, ${W}x${H} (+ .srt)`);
if (chapters.length) console.log(`chapters:\n${chapters.join('\n')}`);
