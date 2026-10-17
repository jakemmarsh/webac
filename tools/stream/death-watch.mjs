// Stream death watch (tools/stream/death-watch.mjs): replays deaths since the last one it reported (a stamp file
// beside the feed), then follows the feed and an optional supervisor run log. A Monitor expires every 30 min, and a
// death in the gap before the next one is armed was missed twice on 2026-10-17; the replay closes that gap.
// Usage: node tools/stream/death-watch.mjs [supervisor-run.out]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const feed = path.join(os.tmpdir(), 'acjs-agent/stream/feed.jsonl');
const stampFile = path.join(os.tmpdir(), 'acjs-agent/stream/death-watch.stamp');
const runOut = process.argv[2];
let stamp = Number(fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8') : Date.now());
const say = (s) => process.stdout.write(s + '\n');
const death = (r) => { if (r.type === 'death' && r.t > stamp) { stamp = r.t; fs.writeFileSync(stampFile, String(stamp)); say(`DEATH ${new Date(r.t).toISOString().slice(11, 19)}Z ${r.char}: ${r.text}`); } };
let pos = 0;
const scan = () => {
  const size = fs.statSync(feed).size; if (size < pos) pos = 0; if (size === pos) return;
  const fd = fs.openSync(feed, 'r'); const buf = Buffer.alloc(size - pos); fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd);
  const text = buf.toString('utf8'); const cut = text.lastIndexOf('\n'); if (cut < 0) return; pos += Buffer.byteLength(text.slice(0, cut + 1));
  for (const l of text.slice(0, cut).split('\n')) { try { death(JSON.parse(l)); } catch {} }
};
// Replay: only the tail of the 40+ MB feed (last 2 MB) is needed for deaths since the stamp.
pos = Math.max(0, fs.statSync(feed).size - 2_000_000); { const fd = fs.openSync(feed, 'r'); const b = Buffer.alloc(4096); fs.readSync(fd, b, 0, 4096, pos); const nl = b.indexOf(10); pos += nl + 1; fs.closeSync(fd); }
scan();
let runPos = runOut && fs.existsSync(runOut) ? fs.statSync(runOut).size : 0;
setInterval(() => {
  scan();
  if (runOut && fs.existsSync(runOut)) { const s = fs.statSync(runOut).size; if (s > runPos) { const fd = fs.openSync(runOut, 'r'); const b = Buffer.alloc(s - runPos); fs.readSync(fd, b, 0, b.length, runPos); fs.closeSync(fd); runPos = s;
    for (const l of b.toString('utf8').split('\n')) if (/segment \d+ (ended|report)|halted:|exit |Error: /.test(l)) say(l.slice(0, 200)); } }
}, 2000);
