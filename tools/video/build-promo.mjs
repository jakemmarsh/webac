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
 *   vo        a narration line's name (<audio>/vo/<name>.wav, from tools/video/tts.mjs); voAt = seconds
 *             into the clip it starts (default 0.15). A line may run on over the next clips, but never
 *             into the next line: the build stops and says how much room is missing.
 * The total length is the sum of (to - from) / speed. Prints chapter marks for clips with `chapter`.
 *
 * Sound (--audio <dir>, which holds sfx/ from extract-sfx.ts, vo/ and the music files):
 *   music     { file, from?: seconds into the track, gain?: dB, fadeOut?: s } — ducked under narration
 *   events    { '<take>': [[sfx, takeSeconds, gainDb?], …] } — the game's own sounds at the moments
 *             they happen in a take (a portal swirl, a spell going off); every clip that shows that
 *             moment plays it, retimed by the clip's speed. Find the moments with tools/video/luma.mjs.
 * --no-vo builds the same cut without narration. The mix is normalised to -14 LUFS (YouTube's level).
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
const audioDir = opt('audio') ? resolve(opt('audio')) : null;
const withVo = !args.includes('--no-vo');
const work = join(dirname(out), `.${out.split('/').pop()}-work`);
mkdirSync(work, { recursive: true });

const edl = (await import(pathToFileURL(edlPath).href)).default;
const { width: W, height: H, clips } = edl;
const here = dirname(fileURLToPath(import.meta.url));
const fontDir = resolve(here, '../site/fonts');

// Clip start times, and the narration's room, before anything slow runs.
// Every clip is a whole number of frames, so the sound laid against these times stays on its frames.
const FPS = 30;
const frames = (c) => Math.round(((c.to - c.from) / (c.speed ?? 1)) * FPS);
{ let at = 0; for (const c of clips) { c.start = at; c.dur = frames(c) / FPS; at += c.dur; } edl.total = at; }
const voCues = audioDir && withVo ? narration() : [];

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
  const dur = c.dur;
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
  // tpad holds the last frame so a clip whose source ends a hair early still fills its frame count.
  graph += `;[v1]fps=${FPS},tpad=stop_mode=clone:stop=3,format=yuv420p,setsar=1[v]`;
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', graph, '-map', '[v]', '-frames:v', String(frames(c)),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-r', String(FPS), seg], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`segment ${i} failed`);
  const got = Number(spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', seg]).stdout.toString());
  if (got !== frames(c)) throw new Error(`segment ${i} has ${got} frames, wanted ${frames(c)}`);
  segs.push(seg);
}
const list = join(work, 'segs.txt');
writeFileSync(list, segs.map((s) => `file '${s}'`).join('\n'));
const video = join(work, 'video.mp4');
let r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', video], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('concat failed');
const mix = audioDir ? buildMix(t) : null;
r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, ...(mix ? ['-i', mix, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k'] : []),
  '-c:v', 'copy', '-movflags', '+faststart', out], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('mux failed');
writeFileSync(out.replace(/\.mp4$/, '.srt'), (voCues.length ? narrationSrt() : srt).join('\n'));
console.log(`${out} — ${t.toFixed(1)} s, ${W}x${H}${mix ? `, sound${withVo ? ' + narration' : ''}` : ''} (+ .srt)`);
if (chapters.length) console.log(`chapters:\n${chapters.join('\n')}`);

// ── Sound: music bed (ducked under the voice) + the game's sound effects + narration ─────────
function durOf(f) {
  return Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString());
}
// With narration, the captions file is what's said (YouTube reads it as the transcript), one cue per
// sentence, timed by its share of the line's characters. Spoken numbers go back to digits.
function narrationSrt() {
  const text = JSON.parse(readFileSync(join(here, 'narration.json'), 'utf8'));
  const written = (x) => x.replace(/play web AC dot com/g, 'playwebac.com').replace(/twenty seventeen/g, '2017')
    .replace(/nineteen ninety-nine/g, '1999').replace(/thirteen/g, '13');
  const cues = [];
  for (const v of voCues) {
    const sentences = written(text[v.name]).split(/(?<=[.!?])\s+/); // not at the dot in playwebac.com
    const chars = sentences.reduce((n, x) => n + x.length, 0);
    let at = v.at;
    for (const x of sentences) {
      const d = v.len * (x.length / chars);
      cues.push(`${cues.length + 1}\n${ts(at)} --> ${ts(at + d)}\n${x.trim()}\n`);
      at += d;
    }
  }
  return cues;
}

// Narration lines, each checked for room before the next one (or the end).
function narration() {
  const vo = clips.filter((c) => c.vo).map((c) => {
    const file = join(audioDir, 'vo', `${c.vo}.wav`);
    if (!existsSync(file)) throw new Error(`missing narration ${file} (run tools/video/tts.mjs)`);
    return { file, at: c.start + (c.voAt ?? 0.15), len: durOf(file), name: c.vo, gain: edl.voGain ?? 4, kind: 'vo' };
  });
  const short = vo.map((v, i) => [v, (i + 1 < vo.length ? vo[i + 1].at - 0.2 : edl.total - 0.3) - (v.at + v.len)]).filter(([, room]) => room < 0);
  if (short.length) throw new Error(short.map(([v, room]) => `narration ${v.name} needs ${(-room).toFixed(2)} s more room`).join('\n'));
  return vo;
}
function buildMix(total) {
  const inputs = [], cues = []; // cues: { file, at, gain, kind }
  cues.push(...voCues);
  // Game sounds at the moments their takes show them.
  for (const c of clips) {
    for (const [name, at, gain = edl.sfxGain ?? -3] of edl.events?.[c.take] ?? []) {
      if (at < c.from || at >= c.to) continue;
      const file = ['wav', 'mp3'].map((x) => join(audioDir, 'sfx', `${name}.${x}`)).find(existsSync);
      if (!file) throw new Error(`missing sound ${name} in ${join(audioDir, 'sfx')}`);
      cues.push({ file, at: c.start + (at - c.from) / (c.speed ?? 1), gain, kind: 'sfx' });
    }
  }
  const graph = [];
  let n = 0;
  const add = (file, pre = []) => { inputs.push(...pre, '-i', file); return n++; };
  const labels = { vo: [], sfx: [] };
  for (const [i, q] of cues.entries()) {
    const k = add(q.file);
    graph.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${q.gain}dB,adelay=${Math.round(q.at * 1000)}:all=1[${q.kind}${i}]`);
    labels[q.kind].push(`[${q.kind}${i}]`);
  }
  const bus = (kind) => {
    const l = labels[kind];
    if (!l.length) { graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total}[${kind}]`); return; }
    graph.push(`${l.join('')}amix=inputs=${l.length}:normalize=0:duration=longest,apad,atrim=0:${total}[${kind}]`);
  };
  bus('vo'); bus('sfx');
  if (edl.music) {
    const m = edl.music;
    const k = add(join(audioDir, m.file), ['-ss', String(m.from ?? 0)]);
    const fade = m.fadeOut ?? 2;
    graph.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total},afade=t=in:d=0.3,afade=t=out:st=${(total - fade).toFixed(2)}:d=${fade},volume=${m.gain ?? -4}dB[mraw]`);
    // Duck the music ~10 dB under the voice, as narrated YouTube videos do.
    graph.push('[vo]asplit[vo1][key]', '[mraw][key]sidechaincompress=threshold=0.03:ratio=4:attack=25:release=500:makeup=1[music]');
  } else graph.push('anullsrc=r=48000:cl=stereo,atrim=0:' + total + '[music]', '[vo]anull[vo1]');
  // --stems also writes each bus (pre-normalisation) next to the mix, to check the balance by numbers.
  const stems = args.includes('--stems');
  if (stems) graph.push('[vo1]asplit[vo2][svo]', '[sfx]asplit[sfx2][ssfx]', '[music]asplit[music2][smusic]');
  graph.push(`${stems ? '[vo2][sfx2][music2]' : '[vo1][sfx][music]'}amix=inputs=3:normalize=0:duration=first[pre]`);
  graph.push(`[pre]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`);
  const file = join(work, 'mix.wav');
  const maps = ['-map', '[a]', '-t', total.toFixed(3), file];
  if (stems) for (const k of ['vo', 'sfx', 'music']) maps.push('-map', `[s${k}]`, '-t', total.toFixed(3), join(work, `stem-${k}.wav`));
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', graph.join(';'), ...maps], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('mix failed');
  // loudnorm's one-pass mode lands short mixes a dB or two low: measure, then trim the gain to -14
  // with a limiter holding the peaks.
  const meas = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const I = Number(/I:\s+(-?[\d.]+) LUFS\s+Threshold/.exec(meas.slice(meas.lastIndexOf('Summary')))?.[1]);
  if (!Number.isFinite(I)) throw new Error('loudness measure failed');
  const final = join(work, 'mix-14.wav');
  const r2 = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-af', `volume=${(-14 - I).toFixed(2)}dB,alimiter=limit=0.84:level=false`, final], { stdio: 'inherit' });
  if (r2.status !== 0) throw new Error('gain trim failed');
  return final;
}
