#!/usr/bin/env node
/**
 * Render the promo narration (tools/video/narration.json) with Kokoro, an open-source TTS model that
 * runs locally: no account, and nobody's own voice on the channel.
 *
 *   npm i --prefix ~/.cache/webac/tts kokoro-js@1.2.1        # once, outside the repo (pulls onnxruntime)
 *   node tools/video/tts.mjs --out <audio>/vo [--voice af_heart] [--speed 1.1] [--only long-04,long-05]
 *
 * Write the domain as "play web AC dot com" (espeak reads "playwebac" as one word and "A" as "uh").
 * Check a word with the phonemizer before rendering if unsure. The first run downloads the model
 * (~330 MB, fp32) from Hugging Face into the package's cache.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const out = resolve(opt('out', 'vo'));
const only = opt('only')?.split(',');
const prefix = opt('prefix', join(homedir(), '.cache/webac/tts'));
const require = createRequire(join(prefix, 'package.json'));
const { KokoroTTS } = await import(pathToFileURL(require.resolve('kokoro-js')).href);
const lines = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'narration.json'), 'utf8'));
mkdirSync(out, { recursive: true });
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });
for (const [name, text] of Object.entries(lines)) {
  if (only && !only.includes(name)) continue;
  const a = await tts.generate(text, { voice: opt('voice', 'af_heart'), speed: Number(opt('speed', '1.1')) });
  await a.save(join(out, `${name}.wav`));
  console.log(`${name}  ${(a.audio.length / a.sampling_rate).toFixed(2)} s`);
}
