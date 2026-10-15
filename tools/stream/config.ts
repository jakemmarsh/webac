/**
 * The stream's cast and limits (tools/stream/cast.json): who plays, on which model, in what voice, how long each
 * segment runs and what a day may cost. parseStreamConfig validates and fills defaults; unknown keys are refused so
 * a typo can't silently drop a limit.
 */

export interface AttachConfig {
  /** Chrome DevTools endpoint the human logged the character in on, e.g. http://127.0.0.1:9222 ("chrome" = the agent Chrome). */
  endpoint: string;
  /**
   * Log the character out (to character select) when the stream stops. Attached tabs are the human's own login, so
   * the daemon's `stop` only lets go of them; the supervisor logs them out first unless this is false.
   */
  logoutOnStop: boolean;
}

export interface CharacterConfig {
  /** ac-agent profile (its own daemon, account, logs). */
  profile: string;
  /** In-game name. */
  character: string;
  /** Claude Code model for this player (`claude --model`). */
  model: string;
  /** The character's voice and temperament, appended to the shared brief. */
  personality: string;
  /** Extra notes for this character's first segment (e.g. "you lead the first plan"). */
  startNotes: string;
  /** A standing goal from the stream's plan (Jake's call), in every segment's opening; '' for none. */
  goal: string;
  /** Play a character the human logged in on a public server instead of a local daemon login. */
  attach: AttachConfig | null;
  /** Local daemon options (ignored when attached). */
  era: string | null;
  headless: boolean;
  /** `claude --effort` for this player (low … max); null = the account's default. */
  effort: string | null;
}

export interface StreamConfig {
  /** The claude CLI (v2.1+). */
  claudeBin: string;
  /** Brief file (relative to the repo root): the shared rules every player gets. */
  brief: string;
  segment: {
    /** Play time per segment, before the wrap-up message. */
    minutes: number;
    /** How long a player has to wrap up after being told to, before its session is ended. */
    wrapUpMinutes: number;
    /** A player whose turn ends early is told to keep playing this many times per segment, then the segment ends. */
    maxNudges: number;
    /** Pause before the next segment after a normal end. */
    restartPauseSeconds: number;
    /** A segment shorter than this is a crash/quick quit: the pause doubles each time (up to maxBackoffSeconds). */
    quickExitMinutes: number;
    maxBackoffSeconds: number;
    /** Consecutive quick exits before the character is halted (and logged out). */
    maxQuickExits: number;
    /** `claude --max-budget-usd` per segment (null = none). */
    budgetUsd: number | null;
    /**
     * Compact the player's conversation when its context reaches this many tokens (CLAUDE_CODE_AUTO_COMPACT_WINDOW,
     * 100000–1000000; null = the model's default). Every model call re-reads the whole context, so a segment's cost
     * grows with the square of its length: in the 12-minute rehearsal the context grew from ~40k to 90–160k tokens.
     */
    autoCompactTokens: number | null;
  };
  /** Per supervisor run, per character. */
  maxSegments: number;
  /** Per local calendar day, per character, counted from the segment log (survives restarts of the supervisor). */
  daily: { maxSegments: number; maxMinutes: number; maxUsd: number | null };
  /** Seconds between status reads (the daemon's read-only /vitals) per character. */
  statusEverySeconds: number;
  /**
   * Minutes a character may stay stuck (no vital regenerating, every server action refused: tools/stream/stuck.ts)
   * before the supervisor logs it out and back in; 0 turns the safety net off.
   */
  stuckMinutes: number;
  /** Seconds the players get to say goodbye when the stream stops, before their sessions end. */
  stopGraceSeconds: number;
  /** Permission rules for each player session (`--allowedTools` / `--disallowedTools`), and its permission mode. */
  allowedTools: string[];
  disallowedTools: string[];
  /** `claude --tools`: the only built-in tools the player has. */
  tools: string[];
  permissionMode: string;
  /** Appended to every `claude` command line. */
  extraArgs: string[];
  characters: CharacterConfig[];
}

/**
 * A player runs in its own directory (tools/stream/player.ts), where `./ac` is the agent CLI for its profile and
 * `./world-query` the read-only world-DB query: the rules match those commands exactly.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  'Bash(./ac:*)',
  'Bash(./world-query:*)',
  'Bash(date)',
  'Bash(date:*)',
  'Read',
];

/** The supervisor starts and stops the daemons; a player that ran these would log itself out or start a second login. (`./ac` refuses them too.) */
export const DEFAULT_DISALLOWED_TOOLS = [
  'Bash(./ac start:*)',
  'Bash(./ac stop:*)',
];

/** The rehearsal's context grew past 160k tokens in 12 minutes; compacting at the smallest window keeps a turn's re-read bounded. */
export const DEFAULT_AUTO_COMPACT_TOKENS = 100_000;
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const fail = (path: string, why: string): never => { throw new Error(`cast config: ${path} ${why}`); };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function only(o: Record<string, unknown>, path: string, keys: string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k) && !k.startsWith('//')) fail(`${path}.${k}`, `is not a setting (have: ${keys.join(', ')})`);
}
function str(o: Record<string, unknown>, k: string, path: string, dflt?: string): string {
  const v = o[k] ?? dflt;
  if (typeof v !== 'string' || (dflt === undefined && !v.trim())) return fail(`${path}.${k}`, 'must be a non-empty string');
  return v;
}
function num(o: Record<string, unknown>, k: string, path: string, dflt: number, min = 0): number {
  const v = o[k] ?? dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) return fail(`${path}.${k}`, `must be a number ≥ ${min}`);
  return v;
}
function numOrNull(o: Record<string, unknown>, k: string, path: string, dflt: number | null): number | null {
  if (o[k] === null) return null;
  if (o[k] === undefined) return dflt;
  return num(o, k, path, 0);
}
function strs(o: Record<string, unknown>, k: string, path: string, dflt: string[]): string[] {
  const v = o[k] ?? dflt;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return fail(`${path}.${k}`, 'must be a list of strings');
  return v as string[];
}

/** Personality may be one string or a list of lines (easier to keep in JSON). */
function text(o: Record<string, unknown>, k: string, path: string): string {
  const v = o[k];
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join('\n');
  return fail(`${path}.${k}`, 'must be a string or a list of strings');
}

function compactWindow(s: Record<string, unknown>): number | null {
  const v = numOrNull(s, 'autoCompactTokens', 'segment', DEFAULT_AUTO_COMPACT_TOKENS);
  if (v !== null && (v < 100_000 || v > 1_000_000)) fail('segment.autoCompactTokens', 'must be 100000–1000000 (Claude Code\'s auto-compact window) or null');
  return v;
}

export function parseStreamConfig(raw: unknown): StreamConfig {
  if (!isObj(raw)) return fail('', 'must be a JSON object');
  only(raw, 'config', ['claudeBin', 'brief', 'segment', 'maxSegments', 'daily', 'statusEverySeconds', 'stuckMinutes', 'stopGraceSeconds', 'allowedTools', 'disallowedTools', 'tools', 'permissionMode', 'extraArgs', 'characters']);
  const seg = raw.segment ?? {};
  if (!isObj(seg)) fail('segment', 'must be an object');
  const s = seg as Record<string, unknown>;
  only(s, 'segment', ['minutes', 'wrapUpMinutes', 'maxNudges', 'restartPauseSeconds', 'quickExitMinutes', 'maxBackoffSeconds', 'maxQuickExits', 'budgetUsd', 'autoCompactTokens']);
  const daily = raw.daily ?? {};
  if (!isObj(daily)) fail('daily', 'must be an object');
  const d = daily as Record<string, unknown>;
  only(d, 'daily', ['maxSegments', 'maxMinutes', 'maxUsd']);
  if (!Array.isArray(raw.characters) || !raw.characters.length) fail('characters', 'must list at least one character');
  const characters = (raw.characters as unknown[]).map((c, i): CharacterConfig => {
    const p = `characters[${i}]`;
    if (!isObj(c)) return fail(p, 'must be an object');
    only(c, p, ['profile', 'character', 'model', 'personality', 'startNotes', 'goal', 'attach', 'era', 'headless', 'effort']);
    const profile = str(c, 'profile', p);
    if (!/^[a-z0-9_-]+$/i.test(profile)) fail(`${p}.profile`, 'must be letters, digits, - or _');
    let attach: AttachConfig | null = null;
    if (c.attach !== undefined && c.attach !== null) {
      if (!isObj(c.attach)) return fail(`${p}.attach`, 'must be { endpoint, logoutOnStop? }');
      only(c.attach, `${p}.attach`, ['endpoint', 'logoutOnStop']);
      attach = { endpoint: str(c.attach, 'endpoint', `${p}.attach`), logoutOnStop: c.attach.logoutOnStop !== false };
    }
    if (c.era !== undefined && c.era !== null && typeof c.era !== 'string') fail(`${p}.era`, 'must be an era id or null');
    if (c.effort !== undefined && c.effort !== null && !(EFFORT_LEVELS as readonly unknown[]).includes(c.effort)) fail(`${p}.effort`, `must be one of ${EFFORT_LEVELS.join(', ')} or null`);
    return {
      profile, character: str(c, 'character', p), model: str(c, 'model', p, 'claude-opus-5-5'),
      personality: text(c, 'personality', p), startNotes: text(c, 'startNotes', p), goal: text(c, 'goal', p), attach,
      era: (c.era as string | null | undefined) ?? null, headless: c.headless === true,
      effort: (c.effort as string | null | undefined) ?? null,
    };
  });
  const profiles = characters.map((c) => c.profile);
  if (new Set(profiles).size !== profiles.length) fail('characters', 'must use distinct profiles (each is its own login)');
  const names = characters.map((c) => c.character.toLowerCase());
  if (new Set(names).size !== names.length) fail('characters', 'must be distinct characters');
  return {
    claudeBin: str(raw, 'claudeBin', 'config', 'claude'),
    brief: str(raw, 'brief', 'config', 'tools/stream/brief.md'),
    segment: {
      minutes: num(s, 'minutes', 'segment', 75, 1),
      wrapUpMinutes: num(s, 'wrapUpMinutes', 'segment', 5, 0),
      maxNudges: num(s, 'maxNudges', 'segment', 2, 0),
      restartPauseSeconds: num(s, 'restartPauseSeconds', 'segment', 20, 0),
      quickExitMinutes: num(s, 'quickExitMinutes', 'segment', 3, 0),
      maxBackoffSeconds: num(s, 'maxBackoffSeconds', 'segment', 600, 0),
      maxQuickExits: num(s, 'maxQuickExits', 'segment', 4, 1),
      budgetUsd: numOrNull(s, 'budgetUsd', 'segment', null),
      autoCompactTokens: compactWindow(s),
    },
    maxSegments: num(raw, 'maxSegments', 'config', 8, 1),
    daily: { maxSegments: num(d, 'maxSegments', 'daily', 16, 1), maxMinutes: num(d, 'maxMinutes', 'daily', 720, 1), maxUsd: numOrNull(d, 'maxUsd', 'daily', null) },
    statusEverySeconds: num(raw, 'statusEverySeconds', 'config', 15, 2),
    stuckMinutes: num(raw, 'stuckMinutes', 'config', 5, 0),
    stopGraceSeconds: num(raw, 'stopGraceSeconds', 'config', 120, 0),
    allowedTools: strs(raw, 'allowedTools', 'config', DEFAULT_ALLOWED_TOOLS),
    disallowedTools: strs(raw, 'disallowedTools', 'config', DEFAULT_DISALLOWED_TOOLS),
    tools: strs(raw, 'tools', 'config', ['Bash', 'Read']),
    permissionMode: str(raw, 'permissionMode', 'config', 'dontAsk'),
    extraArgs: strs(raw, 'extraArgs', 'config', []),
    characters,
  };
}
