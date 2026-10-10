#!/usr/bin/env node
/**
 * Canonical tasks.json status setter — see docs/remote-agent-ops.md §4.
 *
 * Enforces the merge-tractability invariants so a status flip is a minimal,
 * few-line diff instead of a whole-file reformat (the incident that turned
 * 8 status flips into a 31,855-line conflict):
 *   - 1-space indent (matches Python json.dumps(d, indent=1))
 *   - ASCII-escaped: every non-ASCII char as \uXXXX (ensure_ascii=True)
 *   - NO trailing newline after the final `}`
 *   - never reorder tasks; only the targeted task's fields change
 *
 * Both humans and the scheduled agent should use this instead of hand-editing
 * a task's status/notes/files.
 *
 * Usage:
 *   node tools/task-status.mjs set <id> <status> [--notes "..."] [--append-notes "..."] [--files a.ts,b.ts] [--tier N] [--filed YYYY-MM-DD] [--local]
 *     --local (with in_progress): a claim by Jake's local session — the cloud loop's `next` skips it for 3 h
 *   node tools/task-status.mjs get <id>
 *   node tools/task-status.mjs check         # verify the file is canonical AND every status is known (no write)
 *   node tools/task-status.mjs migrate-status  # rewrite legacy "completed" -> "done" (prints the count)
 *   node tools/task-status.mjs next [--skip a,b] [-n 5]  # pick order: tier, then age (task-order-lib.mjs)
 *   node tools/task-status.mjs add <id> --title "..." --tier 1|2|3 [--group G] [--severity S] [--size s]
 *       [--status todo] [--description "..."] [--defect-type d] [--our-cite "file:line"]
 *       [--ace-cite "file:line"] [--files a.ts,b.ts] [--notes "..."]
 *     Appends a brand-new task (never reorders/edits existing entries) — for
 *     filing adversarially-verified discovery-pass findings. Refuses to
 *     clobber an existing id.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  STATUSES, isUntiered, migrateStatuses, parseCount, parseFiled, parseStatus, parseTier, pickOrder, unknownStatuses,
} from './task-order-lib.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// TASKS_FILE overrides the target (tests/verify-task-status-cli.ts drives the
// real CLI against a fixture; same convention as tools/hooks/context-inject.sh).
const TASKS = process.env.TASKS_FILE ? resolve(process.env.TASKS_FILE) : resolve(REPO, 'tasks.json');

/**
 * Serialize exactly like Python `json.dumps(obj, indent=1, ensure_ascii=True)`:
 * 1-space indent, ": "/",\n" separators (JSON.stringify defaults with indent),
 * every non-ASCII code unit escaped to \uXXXX, and NO trailing newline.
 * JSON.stringify preserves object key insertion order and array order, so with
 * an already-canonical file a single field change is a minimal diff.
 */
function canonical(obj) {
  const json = JSON.stringify(obj, null, 1);
  // Escape every non-ASCII code unit to \uXXXX (ensure_ascii=True parity).
  return json.replace(/[^\x00-\x7f]/g, (c) =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function load() {
  return JSON.parse(readFileSync(TASKS, 'utf8'));
}
function save(obj) {
  writeFileSync(TASKS, canonical(obj)); // deliberately no trailing newline
}
function findTask(doc, id) {
  const t = doc.tasks.find((x) => x.id === id);
  if (!t) { console.error(`task-status: task not found: ${id}`); process.exit(2); }
  return t;
}
function orDie(parse, v) {
  try { return parse(v); } catch (e) { console.error(`task-status: ${e.message}`); process.exit(2); }
}
const tierOrDie = (v) => orDie(parseTier, v);
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--notes') flags.notes = args[++i];
    else if (args[i] === '--append-notes') flags.appendNotes = args[++i];
    else if (args[i] === '--files') flags.files = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (args[i] === '--tier') flags.tier = tierOrDie(args[++i]);
    else if (args[i] === '--filed') flags.filed = orDie(parseFiled, args[++i]);
    else if (args[i] === '--local') flags.local = true;
    else { console.error(`task-status: unknown flag ${args[i]}`); process.exit(2); }
  }
  return flags;
}
function parseAddFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--title') flags.title = args[++i];
    else if (a === '--group') flags.group = args[++i];
    else if (a === '--severity') flags.severity = args[++i];
    else if (a === '--size') flags.size = args[++i];
    else if (a === '--status') flags.status = orDie(parseStatus, args[++i]);
    else if (a === '--description') flags.description = args[++i];
    else if (a === '--defect-type') flags.defectType = args[++i];
    else if (a === '--our-cite') flags.ourCite = args[++i];
    else if (a === '--ace-cite') flags.aceCite = args[++i];
    else if (a === '--files') flags.files = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--notes') flags.notes = args[++i];
    else if (a === '--tier') flags.tier = tierOrDie(args[++i]);
    else if (a === '--filed') flags.filed = orDie(parseFiled, args[++i]);
    else { console.error(`task-status: unknown flag ${a}`); process.exit(2); }
  }
  return flags;
}

const [cmd, id, status, ...rest] = process.argv.slice(2);

if (cmd === 'check') {
  const raw = readFileSync(TASKS, 'utf8');
  const doc = JSON.parse(raw);
  let ok = true;
  const bad = unknownStatuses(doc.tasks);
  if (bad.length) {
    ok = false;
    const shown = bad.slice(0, 10).map((b) => `${b.id}=${JSON.stringify(b.status)}`).join(', ');
    console.error(`task-status: ${bad.length} task(s) have a status outside {${STATUSES.join(', ')}}: ${shown}${bad.length > 10 ? ', ...' : ''}` +
      ' (legacy "completed": run `node tools/task-status.mjs migrate-status`)');
  }
  const round = canonical(doc);
  if (raw !== round) {
    ok = false;
    const a = raw.split('\n'), b = round.split('\n');
    let diff = Math.abs(a.length - b.length);
    for (let i = 0, n = Math.min(a.length, b.length); i < n; i++) if (a[i] !== b[i]) diff++;
    console.error(`task-status: DRIFT - ~${diff} line(s) differ from canonical form`);
  }
  if (!ok) process.exit(1);
  console.log('task-status: canonical OK (round-trip identical, all statuses known)');
} else if (cmd === 'migrate-status') {
  // Fold legacy status spellings into the canonical set ("completed" -> "done").
  // Only the status field of the affected tasks changes; order/format kept.
  const doc = load();
  const counts = migrateStatuses(doc.tasks);
  const total = Object.values(counts).reduce((x, y) => x + y, 0);
  if (total) save(doc);
  const detail = Object.entries(counts).map(([k, v]) => `${v} "${k}"`).join(', ');
  console.log(`task-status: migrate-status rewrote ${total} task(s)${total ? ` (${detail} -> "done")` : ''}`);
  const bad = unknownStatuses(doc.tasks);
  if (bad.length) {
    console.error(`task-status: ${bad.length} task(s) still have an unknown status (fix by hand): ${bad.map((b) => `${b.id}=${JSON.stringify(b.status)}`).join(', ')}`);
    process.exit(1);
  }
} else if (cmd === 'normalize') {
  // Rewrite the file in canonical form without changing any field (adopts the
  // format / repairs drift from hand-edits). Asserts semantics are preserved.
  const before = load();
  save(before);
  const after = load();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    console.error('task-status: normalize changed semantics — aborting'); process.exit(1);
  }
  console.log('task-status: normalized (semantics unchanged)');
} else if (cmd === 'get') {
  const t = findTask(load(), id);
  console.log(JSON.stringify({ id: t.id, status: t.status, title: t.title }, null, 2));
} else if (cmd === 'set') {
  if (!id || !status) { console.error('usage: set <id> <status> [--notes ..] [--append-notes ..] [--files a,b]'); process.exit(2); }
  orDie(parseStatus, status);
  const flags = parseFlags(rest);
  const doc = load();
  const t = findTask(doc, id);
  t.status = status;
  if (flags.notes !== undefined) t.notes = flags.notes;
  if (flags.appendNotes !== undefined) t.notes = (t.notes ? t.notes + ' ' : '') + flags.appendNotes;
  if (flags.files !== undefined) t.files = flags.files;
  if (flags.tier !== undefined) t.tier = flags.tier;
  if (flags.filed !== undefined) t.filed = flags.filed;
  // A local (Jake's machine) claim is stamped so the cloud loop's pick order
  // skips it while fresh (task-order-lib isFreshLocalClaim); any other status
  // change — or a cloud re-claim — clears the stamp.
  if (status === 'in_progress' && flags.local) t.claim = { by: 'local', at: new Date().toISOString() };
  else delete t.claim;
  save(doc);
  console.log(`task-status: ${id} -> ${status}${flags.local ? ' (local claim)' : ''}`);
} else if (cmd === 'add') {
  if (!id) { console.error('usage: add <id> --title "..." --tier 1|2|3 [--group G] [--severity S] [--size s] [--status todo] [--description "..."] [--defect-type d] [--our-cite ..] [--ace-cite ..] [--files a,b] [--notes ..]'); process.exit(2); }
  const flags = parseAddFlags([status, ...rest].filter((x) => x !== undefined));
  if (!flags.title) { console.error('task-status: add requires --title'); process.exit(2); }
  // Every filing is tiered on its own merits (tools/task-order-lib.mjs):
  // a follow-up never inherits its parent's place in line.
  if (flags.tier === undefined) { console.error('task-status: add requires --tier 1|2|3 (see tools/task-order-lib.mjs)'); process.exit(2); }
  const doc = load();
  if (doc.tasks.some((x) => x.id === id)) { console.error(`task-status: id already exists: ${id}`); process.exit(2); }
  const research = {};
  if (flags.ourCite) research.our = flags.ourCite;
  if (flags.aceCite) research.ace = flags.aceCite;
  const task = {
    id,
    title: flags.title,
    size: flags.size || 'small',
    status: flags.status || 'todo',
    group: flags.group || 'BUG',
    severity: flags.severity || 'medium',
    panel: '',
    defect_type: flags.defectType || '',
    depends: [],
    description: flags.description || '',
    research,
    files: flags.files || [],
    visual_qa: [],
    notes: flags.notes || '',
    tier: flags.tier,
    filed: flags.filed || new Date().toISOString().slice(0, 10),
  };
  doc.tasks.push(task);
  save(doc);
  console.log(`task-status: added ${id}`);
} else if (cmd === 'next') {
  const args = [id, status, ...rest].filter((x) => x !== undefined);
  let skip = [], n = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip') skip = args[++i].split(',').map((x) => x.trim()).filter(Boolean);
    else if (args[i] === '-n') n = orDie(parseCount, args[++i]);
    else { console.error(`task-status: unknown flag ${args[i]}`); process.exit(2); }
  }
  const doc = load();
  const order = pickOrder(doc.tasks, { skip });
  for (const t of order.slice(0, n)) {
    console.log(`${t.status === 'in_progress' ? '*' : ' '} T${t.tier ?? '?'} ${t.filed ?? '????-??-??'} ${t.id} — ${String(t.title).slice(0, 100)}`);
  }
  const untiered = order.filter(isUntiered).map((t) => t.id);
  if (untiered.length) console.log(`task-status: ${untiered.length} open task(s) have no tier (sorted as 2): ${untiered.join(', ')} — set one with: set <id> <status> --tier N`);
} else {
  console.error('usage: task-status.mjs <set|get|add|next|check|normalize|migrate-status> ...\n' +
    '  set <id> <status> [--notes ..] [--append-notes ..] [--files a,b] [--local]\n' +
    '  get <id>\n' +
    '  next [--skip a,b] [-n 5]   open tasks in pick order (tier, then age)\n' +
    '  add <id> --title "..." --tier 1|2|3 [--group G] [--severity S] [--size s] [--status todo]\n' +
    '           [--description ..] [--defect-type d] [--our-cite ..] [--ace-cite ..]\n' +
    '           [--files a,b] [--notes ..]\n' +
    `  check       verify tasks.json is canonical and every status is one of ${STATUSES.join('|')}\n` +
    '  migrate-status  rewrite legacy "completed" statuses to "done" (prints the count)\n' +
    '  normalize   rewrite in canonical form (semantics asserted unchanged)');
  process.exit(2);
}
