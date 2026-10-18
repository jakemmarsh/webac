#!/usr/bin/env node
/**
 * Find the moments in a take where the picture's brightness jumps: a spell going off, the portal
 * swirl starting (a drop) and ending (a jump). The times go into an edit list's `events`, so the
 * game's sounds land on the frame they belong to.
 *
 *   node tools/video/luma.mjs <take.mp4> <fromSeconds> <lengthSeconds> [threshold=12]
 */
import { spawnSync } from 'node:child_process';
const [f, ss, t, thr = '12'] = process.argv.slice(2);
const w = 64, h = 36;
const raw = spawnSync('ffmpeg', ['-v', 'error', '-ss', ss, '-t', t, '-i', f, '-vf', `fps=30,scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1e9 }).stdout;
const n = raw.length / (w * h), L = [];
for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < w * h; j++) s += raw[i * w * h + j]; L.push(s / (w * h)); }
const jumps = [];
for (let i = 1; i < n; i++) if (Math.abs(L[i] - L[i - 1]) > Number(thr)) jumps.push(`${(Number(ss) + i / 30).toFixed(2)}(${L[i] > L[i - 1] ? '+' : ''}${(L[i] - L[i - 1]).toFixed(0)})`);
console.log('jumps:', jumps.join(' '));
console.log('luma every 0.5 s:', L.filter((_, i) => i % 15 === 0).map((v, i) => `${(Number(ss) + i / 2).toFixed(1)}:${v.toFixed(0)}`).join(' '));
