/**
 * Exports the playwebac.com static pages' art from the end-of-retail DATs into deploy/web/site-src/art/:
 * every image the pages draw is the game's own texture, cropped or tiled, never redrawn.
 *
 *   npx tsx tools/site/export-site-art.ts      (from the repo root; needs dat/, ffmpeg, cwebp)
 *
 * The outputs are committed; tools/site/build-site.mjs copies them into deploy/web/site/s/ under
 * content-hashed names. Re-run this only when the art changes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../../packages/dat-parser/src/node/FileDatBytes.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { Texture } from '../../packages/dat-parser/src/file-types/Texture.js';
import { Palette } from '../../packages/dat-parser/src/file-types/Palette.js';

const REPO = process.cwd();
const OUT = path.join(REPO, 'deploy/web/site-src/art');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'site-art-'));
fs.mkdirSync(OUT, { recursive: true });
const portal = new DatDatabase(new FileDatBytes(path.join(REPO, 'dat/client_portal.dat')));

interface Img { w: number; h: number; d: Uint8Array }

function tex(id: number): Img {
  const data = portal.getFileData(id);
  if (!data) throw new Error(`texture 0x${id.toString(16)} not found`);
  const t = Texture.read(new DatReader(data));
  if (t.isJPEG) {
    const jpg = path.join(TMP, `${id.toString(16)}.jpg`);
    fs.writeFileSync(jpg, t.sourceData);
    const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', jpg])
      .toString().trim().split(',').map(Number);
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', jpg, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 << 20 });
    return { w, h, d: new Uint8Array(raw) };
  }
  const r = t.defaultPaletteId !== null
    ? t.toRGBAWithPalette(Palette.read(new DatReader(portal.getFileData(t.defaultPaletteId)!)).colors)
    : t.toRGBA();
  return { w: r.width, h: r.height, d: r.data };
}

function blank(w: number, h: number): Img { return { w, h, d: new Uint8Array(w * h * 4) }; }
/** Copies a rectangle of src onto dst unchanged (no blending: the pieces never overlap). */
function copy(dst: Img, src: Img, dx: number, dy: number, sx = 0, sy = 0, sw = src.w, sh = src.h) {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const si = ((sy + y) * src.w + sx + x) * 4, di = ((dy + y) * dst.w + dx + x) * 4;
    for (let k = 0; k < 4; k++) dst.d[di + k] = src.d[si + k];
  }
}
function crop(src: Img, x: number, y: number, w: number, h: number): Img { const o = blank(w, h); copy(o, src, 0, 0, x, y, w, h); return o; }
/** Retail Graphic::Draw tiles a piece from the box origin at native size; never stretches. */
function tile(dst: Img, src: Img, x: number, y: number, w: number, h: number) {
  for (let oy = 0; oy < h; oy += src.h) for (let ox = 0; ox < w; ox += src.w)
    copy(dst, src, x + ox, y + oy, 0, 0, Math.min(src.w, w - ox), Math.min(src.h, h - oy));
}
function writePng(name: string, img: Img): string {
  const png = new PNG({ width: img.w, height: img.h });
  Buffer.from(img.d.buffer, img.d.byteOffset, img.d.byteLength).copy(png.data);
  const file = path.join(TMP, name);
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}
/** Lossless WebP for UI pieces (hard edges, alpha); lossy for the painted backdrop. */
function webp(name: string, img: Img, quality?: number) {
  const src = writePng(name.replace(/\.webp$/, '.png'), img);
  const args = quality === undefined ? ['-quiet', '-lossless', '-z', '9', '-exact'] : ['-quiet', '-q', String(quality), '-m', '6'];
  execFileSync('cwebp', [...args, src, '-o', path.join(OUT, name)]);
}
function resizeWebp(name: string, srcFile: string, width: number, quality: number) {
  execFileSync('cwebp', ['-quiet', '-q', String(quality), '-m', '6', '-resize', String(width), '0', srcFile, '-o', path.join(OUT, name)]);
}

// Character-select backdrop 0x06007576 (800x600): Asheron, cropped right of the baked-in
// "World"/"Characters" labels and below the baked-in Asheron's Call wordmark.
const backdrop = tex(0x06007576);
const hero = crop(backdrop, 280, 140, 520, 460);
const heroPng = writePng('hero.png', hero);
resizeWebp('hero-520.webp', heroPng, 520, 80);
resizeWebp('hero-360.webp', heroPng, 360, 78);
// A plain patch of the backdrop's stone (below "Characters", left of Asheron) to tile behind pages.
webp('stone.webp', crop(backdrop, 0, 300, 240, 300), 72);

// Dialog plate (layout 0x21000042): navy fill 0x06005ddb, gold 9-slice 0x06005d39-3e.
webp('dialog-fill.webp', tex(0x06005ddb), 82);
{
  const [tl, tr, bl, br, eh, ev] = [0x06005d39, 0x06005d3a, 0x06005d3b, 0x06005d3c, 0x06005d3d, 0x06005d3e].map(tex);
  const W = 40, H = 40, frame = blank(W, H);
  tile(frame, crop(eh, 0, 0, eh.w, Math.ceil(eh.h / 2)), tl.w, 0, W - tl.w - tr.w, Math.ceil(eh.h / 2));
  tile(frame, crop(eh, 0, Math.ceil(eh.h / 2), eh.w, Math.floor(eh.h / 2)), bl.w, H - Math.floor(eh.h / 2), W - bl.w - br.w, Math.floor(eh.h / 2));
  tile(frame, crop(ev, 0, 0, Math.ceil(ev.w / 2), ev.h), 0, tl.h, Math.ceil(ev.w / 2), H - tl.h - bl.h);
  tile(frame, crop(ev, Math.ceil(ev.w / 2), 0, Math.floor(ev.w / 2), ev.h), W - Math.floor(ev.w / 2), tr.h, Math.floor(ev.w / 2), H - tr.h - br.h);
  copy(frame, tl, 0, 0); copy(frame, tr, W - tr.w, 0); copy(frame, bl, 0, H - bl.h); copy(frame, br, W - br.w, H - br.h);
  webp('dialog-frame.webp', frame);
}

// Ornate gold scroll corners 0x06004cc3-c6 (34px) with the hairline gold edge between them.
{
  const [tl, tr, bl, br] = [0x06004cc3, 0x06004cc4, 0x06004cc5, 0x06004cc6].map(tex);
  const C = tl.w, W = C * 2 + 4, frame = blank(W, W);
  // The edge between corners is the corner's own outermost run, repeated (as retail's frame tiles it).
  tile(frame, crop(tl, C - 1, 0, 1, C), C, 0, W - 2 * C, C);
  tile(frame, crop(bl, C - 1, 0, 1, C), C, W - C, W - 2 * C, C);
  tile(frame, crop(tl, 0, C - 1, C, 1), 0, C, C, W - 2 * C);
  tile(frame, crop(tr, 0, C - 1, C, 1), W - C, C, C, W - 2 * C);
  copy(frame, tl, 0, 0); copy(frame, tr, W - C, 0); copy(frame, bl, 0, W - C); copy(frame, br, W - C, W - C);
  webp('ornate-frame.webp', frame);
}

// Book page parchment 0x0600126f (layout 0x21000019).
webp('parchment.webp', tex(0x0600126f), 80);

// Pre-world plate button (layout 0x21000040 elem 0x100002d2): normal / hover / pressed, stacked
// into one sprite so hover never waits on a request.
{
  const states = [0x06004ca3, 0x06004ca4, 0x06004ca5].map(tex);
  const sprite = blank(states[0].w, states[0].h * states.length);
  states.forEach((s, i) => copy(sprite, s, 0, i * s.h));
  webp('plate-button.webp', sprite);
}

// Favicon: the portal icon (weenie portalholtburg IconDID 0x0600106B), not the trademark logo.
{
  const icon = tex(0x0600106b);
  webp('favicon.webp', icon);
  fs.copyFileSync(writePng('favicon.png', icon), path.join(OUT, 'favicon.png'));
}

fs.rmSync(TMP, { recursive: true, force: true });
for (const f of fs.readdirSync(OUT).sort()) console.log(f, fs.statSync(path.join(OUT, f)).size);
