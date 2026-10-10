/**
 * The loop's pick order (routine prompt v4.8, Jake 2026-09-26): by VISIBILITY
 * TIER, then by AGE, never by id lineage. Filing stays unlimited: any finding,
 * however deep, gets filed. A follow-up gets its own tier on its own merits and
 * never inherits its parent's place in line. That is what let
 * CORE.17.k ("diagnostic text in chat") drift 15 levels down into slumlord
 * drag states while month-old movement bugs waited.
 *
 *   tier 1 — seen in the first minutes by every player, or breaks core play:
 *            pre-world flow + char-gen, always-visible HUD, movement, camera,
 *            core combat, chat, inventory basics, the world at spawn, a
 *            first-minute hitch.
 *   tier 2 — common play: vendors, trade, spells/components, social panels,
 *            containers, options, secondary movement/physics feel.
 *   tier 3 — rare or deep: housing/slumlord, salvage edge states, contracts,
 *            harness/infra, perf work with no player-visible symptom.
 *
 * `filed` is the YYYY-MM-DD the task first appeared (task-status.mjs add
 * stamps it). A task with no tier sorts as tier 2 and is reported so it gets one.
 * A task with no `filed` date sorts LAST within its tier: an unknown age must
 * never jump the queue ahead of every dated task (it used to default to
 * 0000-00-00 and so outranked month-old bugs, 2026-09-26 review).
 */

/**
 * The only statuses tasks.json may carry. "completed" was a second spelling
 * of "done" (75 tasks by 2026-09-26) that every status reader had to special-
 * case; `task-status.mjs migrate-status` folds it into "done" and `check`
 * rejects anything outside this set so a third spelling cannot creep back in.
 */
export const STATUSES = ['todo', 'in_progress', 'done', 'blocked'];
export const OPEN_STATUSES = new Set(['todo', 'in_progress']);
/** Legacy spellings `migrate-status` rewrites (old -> canonical). */
export const STATUS_MIGRATIONS = { completed: 'done' };

/** A task counts as untiered for `tier` null OR undefined (one test everywhere). */
export function isUntiered(t) { return t.tier == null; }

/**
 * A LOCAL claim (`set <id> in_progress --local` → claim {by:'local', at})
 * is Jake's machine working that task in parallel with the cloud loop.
 * While it is fresh the loop must neither take it over nor stand down for it,
 * so pickOrder hides it and the loop picks the next task. Once older than
 * this it surfaces again like any claim (the local session died → takeover).
 */
export const LOCAL_CLAIM_TTL_MS = 180 * 60 * 1000;

/** A fresh local claim: hidden from the cloud loop's pick order. */
export function isFreshLocalClaim(t, now = Date.now()) {
  if (t.status !== 'in_progress' || !t.claim || t.claim.by !== 'local') return false;
  const at = Date.parse(t.claim.at);
  return Number.isFinite(at) && now - at < LOCAL_CLAIM_TTL_MS;
}

/** Open tasks in pick order. `skip` = ids never to pick (Jake's local claims). */
export function pickOrder(tasks, { skip = [], now = Date.now() } = {}) {
  const skipSet = new Set(skip);
  return tasks
    .filter((t) => OPEN_STATUSES.has(t.status) && !skipSet.has(t.id) && !isFreshLocalClaim(t, now))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      // An in-progress claim is always first (takeover or exit per the overlap guard).
      const ip = (b.t.status === 'in_progress') - (a.t.status === 'in_progress');
      if (ip) return ip;
      const ta = isUntiered(a.t) ? 2 : a.t.tier, tb = isUntiered(b.t) ? 2 : b.t.tier;
      if (ta !== tb) return ta - tb;
      // No filed date = unknown age = last in its tier ('9' sorts after every digit).
      const fa = a.t.filed || '9999-99-99', fb = b.t.filed || '9999-99-99';
      if (fa !== fb) return fa < fb ? -1 : 1;
      return a.i - b.i; // stable: file order
    })
    .map(({ t }) => t);
}

/** Validate a tier argument (1, 2 or 3). */
export function parseTier(v) {
  const n = Number(v);
  if (![1, 2, 3].includes(n)) throw new Error(`tier must be 1, 2 or 3 (got ${v})`);
  return n;
}

/** Validate a status argument against STATUSES. */
export function parseStatus(v) {
  if (!STATUSES.includes(v)) throw new Error(`status must be one of ${STATUSES.join(', ')} (got ${v})`);
  return v;
}

/** Validate a `filed` date argument: a real calendar date as YYYY-MM-DD. */
export function parseFiled(v) {
  const s = String(v ?? '');
  if (!/^\d{4}-\d\d-\d\d$/.test(s) || Number.isNaN(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) {
    throw new Error(`filed must be a YYYY-MM-DD date (got ${v})`);
  }
  return s;
}

/** Validate a positive integer count (e.g. `next -n`). */
export function parseCount(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`-n must be a positive integer (got ${v})`);
  return n;
}

/** Tasks whose status is outside STATUSES, as {id, status}. */
export function unknownStatuses(tasks) {
  return tasks.filter((t) => !STATUSES.includes(t.status)).map((t) => ({ id: t.id, status: t.status }));
}

/**
 * Rewrite legacy status spellings in place (STATUS_MIGRATIONS). Returns the
 * per-spelling counts, e.g. { completed: 75 }. Touches nothing else.
 */
export function migrateStatuses(tasks) {
  const counts = {};
  for (const t of tasks) {
    const to = Object.hasOwn(STATUS_MIGRATIONS, t.status) ? STATUS_MIGRATIONS[t.status] : undefined;
    if (to) { counts[t.status] = (counts[t.status] ?? 0) + 1; t.status = to; }
  }
  return counts;
}
