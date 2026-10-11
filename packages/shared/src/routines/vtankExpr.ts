/**
 * VirindiTank meta expression language: parser + evaluator.
 *
 * VTank metas run "expressions" in the Expr condition, the DoExpr / ChatExpr
 * actions and SetOpt. UtilityBelt (UB) patches VTank's engine and adds many
 * functions and some syntax ($var, {index}, backtick strings, list callbacks);
 * community metas rely on both, so this implements the union.
 *
 * Written from the documented behaviour (metaf's reference §8 "VirindiTank
 * functions" and §9 "UtilityBelt functions") and from how 108 community metas
 * (~2,000 distinct expressions) use the language. No code was copied. Where
 * the reference is silent the choice below says "Inferred:" and why.
 *
 * Syntax (Inferred from corpus usage unless noted):
 * - Function call: `name[arg, arg]`. Names are case-insensitive. An empty
 *   argument (`vtsetsetting[Recharge-Norm-Hitp,]`) is the empty string.
 * - Bare words are string literals: `getvar[myvar]`, `wobjectfindininventorybyname[Amber Barley]`.
 *   Spaces inside a bare word are kept and leading spaces dropped (metas write
 *   `+ \ minutes` for a leading space). Trailing spaces are kept when an
 *   operator follows (`\/ub follow +getgvar[leader]` sends "/ub follow X")
 *   and dropped before `] , ) } ;` or the end (`[Amber Barley ]` is the item).
 *   `\x` escapes any character. Characters that end a bare word:
 *   `[ ] ( ) , ; + * / % ^ # = < > & | { } : $`, `!=` and the backtick. `-`,
 *   `.`, `'` and a lone `!` inside a word are literal (`Light-Infused`,
 *   `Zongo's Stout`, `echo[Snarl Found!,15]`). A word may start with digits
 *   (`4 Corners timer`) and, where a value is expected, with `/` (`/ub ...`).
 * - A bare word that is a number (`12`, `1.5`, `0x1F`) is a number; `true` /
 *   `false` (any case) are 1 / 0 (Inferred: the language has no boolean type;
 *   comparisons yield 1 / 0, matching `getobjectinternaltype` having no bool).
 * - `` `text` `` is a literal string, no escapes (UB). `'text'` at the start of
 *   an operand is also a quoted string (Inferred: metas compare
 *   `wobjectgetstringprop[..]=='Insatiable Vault'`, which only works if the
 *   quotes delimit).
 * - `$name` reads a meta variable (UB shorthand for getvar[name]); `$1` / `$2`
 *   are the item / accumulator inside listfilter, listmap, listreduce, listsort.
 * - `x{i}` indexes a list, dict or string; `x{a:b}` slices (end exclusive,
 *   either end optional, negative counts from the end) (UB; corpus
 *   `$currentLum{$idx}`, `$foundCoords{0:14}`).
 * - Operators, loosest first: `;` (sequence, value of the last), `||`, `&&`,
 *   `|`, `&` (bitwise on integers; corpus `getquestktprogress[x]&0x2`),
 *   `== != #` (`#` = left matches regex right), `< > <= >=`, `+ -`
 *   (`+` concatenates when either side is a string), `* / %`, `^` (power,
 *   right-associative), unary `- !`, postfix `{}`.
 * - Leniency: an unclosed call at end of input is closed, and stray `]` after
 *   a complete expression are ignored. Several community metas ship such
 *   expressions (`..+\ Seconds]`, `..byname[Keg of Amber Ape]`) and evidently
 *   ran; pass `{ strict: true }` to reject them.
 *
 * Values: number | string | list | dict | world object | coordinates |
 * stopwatch | null ("none"). Lists, dicts and stopwatches are references
 * (listadd mutates the list stored in a variable, as metas rely on).
 */

// ─── Values ──────────────────────────────────────────────────────────────

export interface ExprList { kind: 'list'; items: ExprValue[] }
export interface ExprDict { kind: 'dict'; map: Map<string, ExprValue> }
/** A world object reference. `id` is the live key; the rest is a snapshot from when it was found. */
export interface ExprWorldObject { kind: 'wobject'; id: number; name: string; objectClass: number; templateType: number }
/**
 * Map coordinates as VTank shows them: north/south and east/west in map units
 * (positive = N / E), and z = metres / 240 (so `coordinatetostring` reads
 * `78.39N, 40.80W, 0.24Z`). Distances come back in metres (units × 240).
 */
export interface ExprCoords { kind: 'coords'; ns: number; ew: number; z: number }
export interface ExprStopwatch { kind: 'stopwatch'; startedAt: number | null; accumulatedMs: number }
/** A Meta View control reference (uigetcontrol[window, control]; uisetlabel takes it). */
export interface ExprViewControl { kind: 'viewcontrol'; view: string; control: string }

export type ExprValue = number | string | ExprList | ExprDict | ExprWorldObject | ExprCoords | ExprStopwatch | ExprViewControl | null;

export type VarScope = 'var' | 'gvar' | 'pvar';

/** What the host knows about one object (world or inventory). */
export interface HostObject {
  id: number;
  name: string;
  /** Decal ObjectClass (5 Monster, 10 Container, 14 Portal, 24 Player, 26 Door, 37 NPC, …). */
  objectClass: number;
  /** Weenie class id (VTank's "template type"). */
  templateType?: number;
  /** Physics position; absent for things inside a pack. */
  coords?: ExprCoords | null;
  /** Id of the container holding it, when inside one. */
  containerId?: number;
  stack?: number;
  isDoorOpen?: boolean;
  /** Degrees, 0 = north, 90 = east. */
  heading?: number;
  /** AC ItemType bits (wobjectgetinternaltype). */
  itemType?: number;
  /** Where it is worn or wielded now (EquipMask bits); absent or 0 when it isn't. */
  equipMask?: number;
}

export interface HostFellowship {
  name?: string;
  members: Array<{ id: number; name: string }>;
  leaderId?: number;
  open?: boolean;
  locked?: boolean;
}

export interface HostQuest {
  /** Times solved (kill-task progress / flag bits for bit-field quests). */
  solves: number;
  /** Solves required / maximum. */
  maxSolves: number;
  /** True when the quest can be done now (never done, or its timer has run out). */
  ready: boolean;
}

/** Character / object property tables (AC property ids, as Decal numbers them). */
export type PropKind = 'int' | 'double' | 'bool' | 'quad' | 'string';

/**
 * Everything game-side the language needs. Only the variable store, the
 * clock and echo are required; every other method is optional, and a function
 * whose method is missing throws `ExprError('unsupported function NAME')`.
 */
export interface ExprHost {
  // Variables. 'var' lives for the meta run, 'gvar' is global and persistent,
  // 'pvar' is per character and persistent. `undefined` = not set.
  getVar(scope: VarScope, name: string): ExprValue | undefined;
  setVar(scope: VarScope, name: string, value: ExprValue): void;
  /** Returns whether the variable existed. */
  clearVar(scope: VarScope, name: string): boolean;
  clearAllVars(scope: VarScope): void;
  /** Wall clock in ms (stopwatches, getunixtime). */
  now(): number;
  /** Print to the local chat window only (echo[msg,color]). */
  echo(text: string, color?: number): void;

  /** Send text as if typed into the chat box (chatbox[], ChatExpr): commands or speech. */
  chatbox?(text: string): void;
  /** Put text into the chat box without sending it. */
  chatboxPaste?(text: string): void;
  /** Uniform [0,1); defaults to Math.random. */
  random?(): number;

  // Settings.
  vtGetSetting?(name: string): ExprValue;
  vtSetSetting?(name: string, value: string): boolean;
  ubGetOption?(name: string): ExprValue;
  ubSetOption?(name: string, value: ExprValue): boolean;
  getMetaState?(): string;
  setMetaState?(state: string): void;

  // The player.
  player?(): HostObject;
  playerCoords?(): ExprCoords;
  playerLandcell?(): number;
  charProp?(kind: PropKind, id: number): number | string | undefined;
  /** vital 1 = health, 2 = stamina, 3 = mana. */
  vital?(vital: number): { base: number; current: number; buffedMax: number } | null;
  /** training: 0 unusable, 1 untrained, 2 trained, 3 specialized. */
  skill?(skillId: number): { base: number; buffed: number; training: number } | null;
  /** attribute 1 Strength … 6 Self. */
  attribute?(attr: number): { base: number; buffed: number } | null;
  /** Burden as a percentage of capacity. */
  burden?(): number;
  /** Vitae as a percentage (100 = none). */
  vitae?(): number;
  isPortaling?(): boolean;
  /** UB busy state: 0 idle, 1 stacking, 2 splitting, … */
  busyState?(): number;
  combatState?(): string;
  setCombatState?(state: string): boolean;
  worldName?(): string;

  // World and inventory.
  /** Objects outside the player's inventory the client knows about. */
  objects?(): HostObject[];
  /** The player's inventory (packs and everything in them). */
  inventory?(): HostObject[];
  /** Fast id lookup; falls back to scanning player/objects/inventory. */
  objectById?(id: number): HostObject | null;
  selectionId?(): number | null;
  openContainerId?(): number | null;
  objectProp?(id: number, kind: PropKind, key: number): number | string | undefined;
  objectHealth?(id: number): number;
  objectHasData?(id: number): boolean;
  requestObjectData?(id: number): void;
  objectLastIdTime?(id: number): number;
  objectSpellIds?(id: number, activeOnly: boolean): number[];

  // Actions. Each returns whether it was attempted.
  select?(id: number): boolean;
  useItem?(id: number): boolean;
  applyItem?(useId: number, targetId: number): boolean;
  giveItem?(itemId: number, targetId: number): boolean;
  giveProfile?(lootProfile: string, targetId: number): boolean;
  setMotion?(motion: string, on: boolean): void;
  getMotion?(motion: string): boolean;
  clearMotion?(): void;
  equipAnyWand?(): boolean;
  castSpell?(spellId: number, targetId?: number): boolean;

  // Spells.
  spellKnown?(spellId: number): boolean;
  canCastSpell?(spellId: number, kind: 'hunt' | 'buff'): boolean;
  spellName?(spellId: number): string;
  knownSpells?(): number[];
  /** Seconds until the player's own enchantment from this spell expires (0 if absent). */
  spellExpiration?(spellId: number): number;
  spellExpirationByName?(name: string): number;
  componentName?(componentId: number): string;

  // Social.
  fellowship?(): HostFellowship | null;
  quest?(name: string): HostQuest | null;
  isRefreshingQuests?(): boolean;

  // Time: Dereth PortalYearTicks (seconds since Morningthaw 1, 10 P.Y.).
  gameTicks?(): number;

  // UI / scheduling.
  statusHud?(key: string, value: string, color?: number): void;
  /** Meta Views: is there a control by this name in this open view (uigetcontrol)? */
  viewControl?(view: string, control: string): boolean;
  /** Meta Views: set a control's text label (uisetlabel; buttons). Returns whether it was set. */
  setViewLabel?(view: string, control: string, text: string): boolean;
  /** Run `fn` after `ms` (delayexec). */
  schedule?(ms: number, fn: () => void): void;

  // UtilityBelt additions (docs/vtank-parity-gaps.md §5).
  /** Every variable set in a scope, for /vt dumpmetavars. */
  listVars?(scope: VarScope): Array<[string, ExprValue]>;
  /** Drop an item you carry on the ground (actiontrydrop). */
  dropItem?(id: number): boolean;
  /**
   * Move an item into a container (yours or a pack) at a slot: the whole item,
   * or `amount` split off it; `joinStack` lets it join a stack of the same
   * thing already there (actiontrymove / actiontrysplit).
   */
  moveItem?(id: number, containerId: number, slot: number, amount: number | null, joinStack: boolean): boolean;
  /** Have you opened this corpse (hascorpsebeenopenedbyme / getcorpsesunopenedbyme)? */
  corpseOpenedByMe?(id: number): boolean;
  /** Seconds left on a shared item cooldown (its CooldownId), 0 when none. */
  cooldownRemaining?(cooldownId: number): number;
  /** A container's capacity (you, or a pack): item slots and pack slots; null when it isn't a container. */
  containerCapacity?(id: number): { items: number; containers: number } | null;
  /** An object's current health / stamina / mana (vital 1 / 2 / 3) when the client knows it. */
  objectVital?(id: number, vital: number): number | null;
  /** XP and luminance earned since the meter started or was reset, and over how long (xp* / lum*). */
  xpMeter?(): { xp: number; lum: number; seconds: number };
  xpReset?(): void;
  /** The meta (profile) loaded, and whether the macro is on (vtgetmeta / vtmacroenabled). */
  metaName?(): string;
  macroEnabled?(): boolean;
  /** Meta Views: is a view open, is it shown, and show or hide one of its controls. */
  viewExists?(view: string): boolean;
  viewVisible?(view: string): boolean;
  setViewVisible?(view: string, control: string, visible: boolean): boolean;
  /** Your account's characters, in login-screen order (getcharacterindex / setnextlogin). */
  characterNames?(): string[];
  /** Log in as this character the next time you are at character select; null clears it. */
  setNextLogin?(name: string | null): boolean;
  /** Wall-clock time in ms since 1970 (getdatetime*; defaults to Date.now). */
  wallClock?(): number;
}

export class ExprError extends Error {
  constructor(message: string, readonly pos: number = -1) {
    super(pos >= 0 ? `${message} (at ${pos})` : message);
    this.name = 'ExprError';
  }
}

// ─── AST ─────────────────────────────────────────────────────────────────

export type BinaryOp = '||' | '&&' | '|' | '&' | '==' | '!=' | '#' | '<' | '>' | '<=' | '>=' | '+' | '-' | '*' | '/' | '%' | '^';

export type ExprNode =
  | { type: 'num'; value: number; pos: number }
  | { type: 'str'; value: string; pos: number }
  | { type: 'var'; name: string; pos: number }
  | { type: 'call'; name: string; args: ExprNode[]; pos: number }
  | { type: 'unary'; op: '-' | '!'; arg: ExprNode; pos: number }
  | { type: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode; pos: number }
  | { type: 'index'; target: ExprNode; index: ExprNode; pos: number }
  | { type: 'slice'; target: ExprNode; start: ExprNode | null; end: ExprNode | null; pos: number }
  | { type: 'seq'; items: ExprNode[]; pos: number };

// ─── Parser ──────────────────────────────────────────────────────────────

const WORD_END = new Set('[](),;+*/%^#=!<>&|{}:$`');
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER = /^(?:0[xX][0-9A-Fa-f]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/;

export interface ParseOptions { strict?: boolean }

class Parser {
  i = 0;
  constructor(readonly s: string, readonly strict: boolean) {}

  fail(msg: string, pos = this.i): never { throw new ExprError(msg, pos); }
  ws(): void { while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++; }
  peek(n = 0): string { return this.s[this.i + n] ?? ''; }
  eof(): boolean { return this.i >= this.s.length; }

  parseAll(): ExprNode {
    this.ws();
    if (this.eof()) return { type: 'str', value: '', pos: 0 };
    const node = this.seq();
    this.ws();
    if (!this.strict) while (this.peek() === ']') { this.i++; this.ws(); }
    if (!this.eof()) this.fail(`unexpected '${this.peek()}'`);
    return node;
  }

  seq(): ExprNode {
    const pos = this.i;
    const items = [this.binary(0)];
    for (;;) {
      this.ws();
      if (this.peek() !== ';') break;
      this.i++;
      this.ws();
      if (this.eof() || this.peek() === ')' || this.peek() === ']') break; // trailing ';'
      items.push(this.binary(0));
    }
    return items.length === 1 ? items[0]! : { type: 'seq', items, pos };
  }

  /** Binary operator at the cursor for precedence level `lvl`, or null. */
  op(lvl: number): BinaryOp | null {
    const c = this.peek(), d = this.peek(1);
    switch (lvl) {
      case 0: return c === '|' && d === '|' ? '||' : null;
      case 1: return c === '&' && d === '&' ? '&&' : null;
      case 2: return c === '|' && d !== '|' ? '|' : null;
      case 3: return c === '&' && d !== '&' ? '&' : null;
      case 4: return c === '=' && d === '=' ? '==' : c === '!' && d === '=' ? '!=' : c === '#' ? '#' : null;
      case 5: return c === '<' ? (d === '=' ? '<=' : '<') : c === '>' ? (d === '=' ? '>=' : '>') : null;
      case 6: return c === '+' || c === '-' ? c : null;
      case 7: return c === '*' || c === '/' || c === '%' ? c : null;
      default: return null;
    }
  }

  binary(lvl: number): ExprNode {
    if (lvl > 7) return this.power();
    let left = this.binary(lvl + 1);
    for (;;) {
      this.ws();
      const op = this.op(lvl);
      if (!op) return left;
      const pos = this.i;
      this.i += op.length;
      const right = this.binary(lvl + 1);
      left = { type: 'binary', op, left, right, pos };
    }
  }

  power(): ExprNode {
    const base = this.unary();
    this.ws();
    if (this.peek() !== '^') return base;
    const pos = this.i++;
    return { type: 'binary', op: '^', left: base, right: this.power(), pos };
  }

  unary(): ExprNode {
    this.ws();
    const c = this.peek();
    if ((c === '-' || c === '!') && this.peek(1) !== '=') {
      const pos = this.i++;
      return { type: 'unary', op: c, arg: this.unary(), pos };
    }
    return this.postfix(this.primary());
  }

  postfix(node: ExprNode): ExprNode {
    for (;;) {
      if (this.peek() !== '{') return node;
      const pos = this.i++;
      this.ws();
      let start: ExprNode | null = null;
      if (this.peek() !== ':') start = this.seq();
      this.ws();
      if (this.peek() === ':') {
        this.i++;
        this.ws();
        const end = this.peek() === '}' ? null : this.seq();
        this.ws();
        this.expect('}');
        node = { type: 'slice', target: node, start, end, pos };
      } else {
        this.expect('}');
        node = { type: 'index', target: node, index: start!, pos };
      }
    }
  }

  expect(ch: string): void {
    this.ws();
    if (this.peek() !== ch) this.fail(this.eof() ? `expected '${ch}' before end of expression` : `expected '${ch}', found '${this.peek()}'`);
    this.i++;
  }

  primary(): ExprNode {
    this.ws();
    const pos = this.i;
    const c = this.peek();
    if (this.eof()) this.fail('expected a value before end of expression');
    if (c === '(') {
      this.i++;
      const inner = this.seq();
      this.expect(')');
      return inner;
    }
    if (c === '`' || c === "'") {
      const close = this.s.indexOf(c, this.i + 1);
      if (close < 0) this.fail(`unterminated ${c === '`' ? 'backtick' : 'quoted'} string`, pos);
      this.i = close + 1;
      return { type: 'str', value: this.s.slice(pos + 1, close), pos };
    }
    if (c === '$') {
      this.i++;
      const m = /^[A-Za-z0-9_]+/.exec(this.s.slice(this.i));
      if (!m) this.fail("expected a variable name after '$'", pos);
      this.i += m[0].length;
      return { type: 'var', name: m[0], pos };
    }
    const num = NUMBER.exec(this.s.slice(this.i));
    // A number followed by letters (`5th`, `4 Corners timer`) is the start of a bare word.
    if (num && !/^[ \t]*[A-Za-z_\\]|^\./.test(this.s.slice(this.i + num[0].length, this.i + num[0].length + 64))) {
      this.i += num[0].length;
      return { type: 'num', value: num[0].length > 2 && /^0x/i.test(num[0]) ? parseInt(num[0], 16) : Number(num[0]), pos };
    }
    // `/` can't be an operator where a value is expected: let it start a word (`/ub ...`).
    if (WORD_END.has(c) && c !== '/') this.fail(`unexpected '${c}'`);
    return this.word(pos);
  }

  word(pos: number): ExprNode {
    let out = '';
    let keep = 0; // length of `out` up to the last char that must be kept (non-space or escaped)
    let escaped = false;
    if (this.peek() === '/') { out = '/'; keep = 1; this.i++; }
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === '\\') {
        if (this.i + 1 >= this.s.length) this.fail('dangling escape at end of expression');
        out += this.s[this.i + 1];
        keep = out.length;
        escaped = true;
        this.i += 2;
        continue;
      }
      // `!` inside a word is literal unless it starts `!=` (`echo[Snarl Found!,15]`).
      if (WORD_END.has(ch) && !(ch === '!' && this.peek(1) !== '=')) break;
      out += ch;
      if (!/\s/.test(ch)) keep = out.length;
      this.i++;
    }
    // Trailing spaces are kept when an operator follows (`\/ub follow +getgvar[leader]`
    // must send "/ub follow Name") and dropped before `]`, `,`, `)`, `}`, `;` or the end.
    this.ws();
    const closer = this.eof() || ']),};'.includes(this.peek());
    const text = closer ? out.slice(0, keep) : out;
    const bare = out.slice(0, keep);
    if (!escaped && IDENT.test(bare) && this.peek() === '[') return this.call(bare, pos);
    if (!escaped && /^(true|false)$/i.test(bare)) return { type: 'num', value: bare.toLowerCase() === 'true' ? 1 : 0, pos };
    if (!escaped && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(bare)) {
      return { type: 'num', value: Number(bare), pos };
    }
    return { type: 'str', value: text, pos };
  }

  call(name: string, pos: number): ExprNode {
    this.i++; // '['
    const args: ExprNode[] = [];
    this.ws();
    if (this.peek() === ']') { this.i++; return { type: 'call', name: name.toLowerCase(), args, pos }; }
    for (;;) {
      this.ws();
      if (this.peek() === ',' || this.peek() === ']') args.push({ type: 'str', value: '', pos: this.i });
      else if (this.eof() && !this.strict) break;
      else args.push(this.seq());
      this.ws();
      if (this.peek() === ',') { this.i++; continue; }
      if (this.peek() === ']') { this.i++; break; }
      if (this.eof() && !this.strict) break; // unclosed call at end of input
      this.fail(this.eof() ? `expected ']' to close ${name}[ before end of expression` : `expected ',' or ']' in ${name}[, found '${this.peek()}'`);
    }
    return { type: 'call', name: name.toLowerCase(), args, pos };
  }
}

export function parseExpr(src: string, opts: ParseOptions = {}): ExprNode {
  return new Parser(src, opts.strict === true).parseAll();
}

const parseCache = new Map<string, ExprNode>();
function parseCached(src: string): ExprNode {
  let node = parseCache.get(src);
  if (!node) {
    node = parseExpr(src);
    if (parseCache.size > 500) parseCache.clear();
    parseCache.set(src, node);
  }
  return node;
}

// ─── Value helpers ───────────────────────────────────────────────────────

const isObj = (v: ExprValue): v is Exclude<ExprValue, number | string | null> => typeof v === 'object' && v !== null;

/**
 * VTank truthiness. Numbers: non-zero. Strings: non-empty and not "0" /
 * "false" (Inferred: VTank options come back as "True"/"False" strings).
 * Lists/dicts: non-empty. World objects, coordinates, stopwatches: true.
 * None: false.
 */
export function truthy(v: ExprValue): boolean {
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  if (v.kind === 'list') return v.items.length > 0;
  if (v.kind === 'dict') return v.map.size > 0;
  return true;
}

const b = (x: boolean): number => (x ? 1 : 0);

/** Number → text the way .NET's double.ToString() ("G15") prints it. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 'NaN' : n > 0 ? 'Infinity' : '-Infinity';
  return String(Number(n.toPrecision(15)));
}

export function coordsToString(c: ExprCoords): string {
  return `${Math.abs(c.ns).toFixed(2)}${c.ns >= 0 ? 'N' : 'S'}, ${Math.abs(c.ew).toFixed(2)}${c.ew >= 0 ? 'E' : 'W'}, ${c.z.toFixed(2)}Z`;
}

/** Text form of any value (string concatenation, tostring, echo). */
export function exprToString(v: ExprValue): string {
  if (v === null) return '';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'string') return v;
  switch (v.kind) {
    case 'list': return `[${v.items.map(exprToString).join(',')}]`;
    case 'dict': return `{${[...v.map].map(([k, x]) => `${k}:${exprToString(x)}`).join(',')}}`;
    case 'wobject': return v.name;
    case 'coords': return coordsToString(v);
    case 'stopwatch': return `stopwatch[${v.startedAt === null ? 'stopped' : 'running'}]`;
    case 'viewcontrol': return `${v.view}.${v.control}`;
  }
}

const NUM_STR = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/;
function strToNum(s: string): number | null {
  if (NUM_STR.test(s)) return Number(s);
  if (/^\s*0[xX][0-9A-Fa-f]+\s*$/.test(s)) return parseInt(s.trim(), 16);
  if (/^\s*true\s*$/i.test(s)) return 1;
  if (/^\s*false\s*$/i.test(s)) return 0;
  return null;
}

function equal(a: ExprValue, c: ExprValue): boolean {
  if (typeof a === 'number' && typeof c === 'number') return a === c;
  if (typeof a === 'string' && typeof c === 'string') return a === c;
  if (typeof a === 'number' && typeof c === 'string') { const n = strToNum(c); return n !== null && n === a; }
  if (typeof a === 'string' && typeof c === 'number') { const n = strToNum(a); return n !== null && n === c; }
  if (a === null || c === null) return a === c;
  if (isObj(a) && isObj(c)) {
    if (a.kind === 'wobject' && c.kind === 'wobject') return a.id === c.id;
    if (a.kind === 'coords' && c.kind === 'coords') return a.ns === c.ns && a.ew === c.ew && a.z === c.z;
    if (a.kind === 'viewcontrol' && c.kind === 'viewcontrol') return a.view === c.view && a.control === c.control;
    return a === c;
  }
  return false;
}

const regexCache = new Map<string, RegExp>();
/** .NET-flavoured pattern → JS RegExp (a leading `(?i)` becomes the i flag). */
export function toRegExp(pattern: string, pos = -1): RegExp {
  let re = regexCache.get(pattern);
  if (re) return re;
  let src = pattern, flags = '';
  const m = /^\(\?([imsx]+)\)/.exec(src);
  if (m) { src = src.slice(m[0].length); flags = [...new Set(m[1]!.replace('x', ''))].join(''); }
  try { re = new RegExp(src, flags); } catch (e) { throw new ExprError(`bad regex '${pattern}': ${(e as Error).message}`, pos); }
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(pattern, re);
  return re;
}

/** C#'s Math.Round(double): midpoints go to the even neighbour. */
function bankersRound(n: number): number {
  const f = Math.floor(n), d = n - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Subset of .NET numeric format strings for cstrf: F N G D X P E and custom 0/#. */
export function formatDotNet(n: number, fmt: string): string {
  const m = /^([FfNnGgDdXxPpEe])(\d*)$/.exec(fmt.trim());
  const group = (s: string) => { const [i, f] = s.split('.'); const g = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ','); return f !== undefined ? `${g}.${f}` : g; };
  if (m) {
    const p = m[2] === '' ? null : Number(m[2]);
    switch (m[1]!.toUpperCase()) {
      case 'F': return n.toFixed(p ?? 2);
      case 'N': return group(n.toFixed(p ?? 2));
      case 'G': return p ? String(Number(n.toPrecision(p))) : formatNumber(n);
      case 'D': { const t = String(Math.abs(Math.trunc(n))).padStart(p ?? 0, '0'); return n < 0 ? `-${t}` : t; }
      case 'X': { const t = (Math.trunc(n) >>> 0).toString(16).padStart(p ?? 0, '0'); return m[1] === 'X' ? t.toUpperCase() : t; }
      case 'P': return `${group((n * 100).toFixed(p ?? 2))} %`;
      case 'E': { const [mant, exp] = n.toExponential(p ?? 6).split('e'); const e = Number(exp); return `${mant}${m[1]}${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(3, '0')}`; }
    }
  }
  const c = /^([#0,]*)(?:\.([#0]+))?$/.exec(fmt.trim());
  if (c && fmt.trim() !== '') {
    const dec = c[2] ?? '';
    const minDec = dec.replace(/#/g, '').length;
    let s = n.toFixed(dec.length);
    if (dec.length > minDec) s = s.replace(new RegExp(`0{0,${dec.length - minDec}}$`), '').replace(/\.$/, '');
    const intMin = (c[1] ?? '').replace(/[#,]/g, '').length;
    const [ip, fp] = s.replace('-', '').split('.');
    let out = ip!.padStart(intMin, '0');
    if (intMin === 0 && out === '0' && fp) out = '';
    if ((c[1] ?? '').includes(',')) out = group(out);
    return `${n < 0 ? '-' : ''}${out}${fp ? `.${fp}` : ''}`;
  }
  return formatNumber(n);
}

// ─── .NET date formatting (getdatetimelocal / getdatetimeutc) ────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** .NET's standard date formats under InvariantCulture, as custom patterns. */
const DATE_STANDARD: Record<string, string> = {
  d: 'MM/dd/yyyy', D: 'dddd, dd MMMM yyyy', f: 'dddd, dd MMMM yyyy HH:mm', F: 'dddd, dd MMMM yyyy HH:mm:ss',
  g: 'MM/dd/yyyy HH:mm', G: 'MM/dd/yyyy HH:mm:ss', m: 'MMMM dd', M: 'MMMM dd', o: "yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffffK", O: "yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffffK",
  r: "ddd, dd MMM yyyy HH':'mm':'ss 'GMT'", R: "ddd, dd MMM yyyy HH':'mm':'ss 'GMT'", s: "yyyy'-'MM'-'dd'T'HH':'mm':'ss",
  t: 'HH:mm', T: 'HH:mm:ss', u: "yyyy'-'MM'-'dd HH':'mm':'ss'Z'", U: 'dddd, dd MMMM yyyy HH:mm:ss', y: 'yyyy MMMM', Y: 'yyyy MMMM',
};

/**
 * A date as .NET's DateTime.ToString(format, InvariantCulture) writes it:
 * the standard one-letter formats and the custom specifiers (d dd ddd dddd,
 * M MM MMM MMMM, y yy yyyy, h hh H HH, m mm, s ss, f… F…, t tt, z zz zzz, K,
 * quoted text, `\x` and `%x`). `utc` reads the date's UTC fields.
 */
export function formatDotNetDate(date: Date, format: string, utc: boolean): string {
  const fmt = format.length === 1 ? DATE_STANDARD[format] ?? (() => { throw new Error(`Input string was not in a correct format: '${format}'`); })() : format;
  const u = utc || format === 'r' || format === 'R' || format === 'u';
  const Y = u ? date.getUTCFullYear() : date.getFullYear();
  const Mo = u ? date.getUTCMonth() : date.getMonth();
  const D = u ? date.getUTCDate() : date.getDate();
  const W = u ? date.getUTCDay() : date.getDay();
  const H = u ? date.getUTCHours() : date.getHours();
  const Mi = u ? date.getUTCMinutes() : date.getMinutes();
  const S = u ? date.getUTCSeconds() : date.getSeconds();
  const ms = u ? date.getUTCMilliseconds() : date.getMilliseconds();
  const off = u ? 0 : -date.getTimezoneOffset();
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const offset = (full: number) => {
    const sign = off < 0 ? '-' : '+', h = Math.floor(Math.abs(off) / 60), m = Math.abs(off) % 60;
    return full === 1 ? `${sign}${h}` : full === 2 ? `${sign}${pad(h, 2)}` : `${sign}${pad(h, 2)}:${pad(m, 2)}`;
  };
  let out = '';
  for (let i = 0; i < fmt.length;) {
    const ch = fmt[i]!;
    if (ch === "'" || ch === '"') {
      const close = fmt.indexOf(ch, i + 1);
      out += fmt.slice(i + 1, close < 0 ? fmt.length : close);
      i = close < 0 ? fmt.length : close + 1;
      continue;
    }
    if (ch === '\\') { out += fmt[i + 1] ?? ''; i += 2; continue; }
    if (ch === '%' && i + 1 < fmt.length) { i++; continue; }
    let n = 1;
    while (fmt[i + n] === ch) n++;
    i += n;
    switch (ch) {
      case 'd': out += n === 1 ? D : n === 2 ? pad(D, 2) : n === 3 ? DAY_NAMES[W]!.slice(0, 3) : DAY_NAMES[W]; break;
      case 'M': out += n === 1 ? Mo + 1 : n === 2 ? pad(Mo + 1, 2) : n === 3 ? MONTH_NAMES[Mo]!.slice(0, 3) : MONTH_NAMES[Mo]; break;
      case 'y': out += n === 1 ? Y % 100 : n === 2 ? pad(Y % 100, 2) : pad(Y, n); break;
      case 'h': out += n === 1 ? (H % 12 || 12) : pad(H % 12 || 12, 2); break;
      case 'H': out += n === 1 ? H : pad(H, 2); break;
      case 'm': out += n === 1 ? Mi : pad(Mi, 2); break;
      case 's': out += n === 1 ? S : pad(S, 2); break;
      case 'f': case 'F': {
        let frac = pad(ms, 3).padEnd(Math.max(3, n), '0').slice(0, n);
        if (ch === 'F') frac = frac.replace(/0+$/, '');
        out += frac;
        if (ch === 'F' && frac === '' && out.endsWith('.')) out = out.slice(0, -1);
        break;
      }
      case 't': out += n === 1 ? (H < 12 ? 'A' : 'P') : H < 12 ? 'AM' : 'PM'; break;
      case 'z': out += offset(Math.min(n, 3)); break;
      case 'K': out += u ? 'Z' : offset(3); break;
      case 'g': out += 'A.D.'; break;
      default: out += ch.repeat(n);
    }
  }
  return out;
}

/**
 * UtilityBelt's XP meter (xpreset / xpmeter / xptotal / xpavg / lumtotal /
 * lumavg / xpduration): experience and luminance gained since it started or
 * was reset. Total experience only grows; available luminance drops when it
 * is spent, so only rises between samples count. Each read samples; the host
 * may also sample on its own tick.
 */
export class XpMeter {
  private last: { xp: number; lum: number } | null = null;
  private startedAt: number | null = null;
  xp = 0;
  lum = 0;
  constructor(private readonly read: () => { xp: number; lum: number } | null, private readonly now: () => number) {}
  sample(): void {
    const r = this.read();
    if (!r) return;
    if (this.startedAt === null) this.startedAt = this.now();
    if (this.last) {
      if (r.xp >= this.last.xp) this.xp += r.xp - this.last.xp;
      if (r.lum >= this.last.lum) this.lum += r.lum - this.last.lum;
    }
    this.last = r;
  }
  reset(): void { this.xp = 0; this.lum = 0; this.last = null; this.startedAt = null; this.sample(); }
  seconds(): number { return this.startedAt === null ? 0 : Math.max(0, (this.now() - this.startedAt) / 1000); }
  reading(): { xp: number; lum: number; seconds: number } { this.sample(); return { xp: this.xp, lum: this.lum, seconds: this.seconds() }; }
}

/** UtilityBelt's xpmeter[] line: "1,234 XP, 60s, 74,040 XP/hr" (with "and … LUM" parts when luminance was earned). */
export function xpMeterText(m: { xp: number; lum: number; seconds: number }): string {
  const n0 = (v: number) => formatDotNet(Math.round(v), 'N0');
  const perHour = (v: number) => (m.seconds > 0 ? (v * 3600) / m.seconds : 0);
  let s = `${n0(m.xp)} XP`;
  if (m.lum) s += ` and ${n0(m.lum)} LUM`;
  s += `, ${n0(m.seconds)}s, ${n0(perHour(m.xp))} XP/hr`;
  if (m.lum) s += ` and ${n0(perHour(m.lum))} LUM/hr`;
  return s;
}

// ─── Dereth calendar (ACE DerethDateTime constants) ──────────────────────

const DAY_TICKS = 7620;
const HOUR_TICKS = DAY_TICKS / 16;
/** Darktide of Morningthaw 2, 10 P.Y. (ACE dayOneTicks = 210 + 8 hours). */
const DAY_ONE_TICKS = 210 + HOUR_TICKS * 8;
/** Morningthaw 1, 11 P.Y. at Darktide. */
const YEAR_ONE_TICKS = DAY_ONE_TICKS + DAY_TICKS * 359;
export const DERETH_HOUR_NAMES = [
  'Darktide', 'Darktide-and-Half', 'Foredawn', 'Foredawn-and-Half', 'Dawnsong', 'Dawnsong-and-Half',
  'Morntide', 'Morntide-and-Half', 'Midsong', 'Midsong-and-Half', 'Warmtide', 'Warmtide-and-Half',
  'Evensong', 'Evensong-and-Half', 'Gloaming', 'Gloaming-and-Half',
];
export const DERETH_MONTH_NAMES = [
  'Morningthaw', 'Solclaim', 'Seedsow', 'Leafdawning', 'Verdantine', 'Thistledown',
  'Harvestgain', 'Leafcull', 'Frostfell', 'Snowreap', 'Coldeve', 'Wintersebb',
];
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Hour 1..16 (Darktide = 1), day 1..30, month 1..12 (Morningthaw = 1), year P.Y. */
export function derethTime(ticks: number): { year: number; month: number; day: number; hour: number; secondsIntoDay: number } {
  const intoDay = mod(ticks - DAY_ONE_TICKS, DAY_TICKS);
  const days = Math.floor((ticks - YEAR_ONE_TICKS) / DAY_TICKS);
  const dayOfYear = mod(days, 360);
  return {
    year: 11 + Math.floor(days / 360),
    month: Math.floor(dayOfYear / 30) + 1,
    day: (dayOfYear % 30) + 1,
    hour: Math.floor(intoDay / HOUR_TICKS) + 1,
    secondsIntoDay: intoDay,
  };
}
// Day = Dawnsong (5) through Warmtide-and-Half (12), per ACE TimeOfDay.
const DAY_START = HOUR_TICKS * 4, NIGHT_START = HOUR_TICKS * 12;
function minutesUntil(ticks: number, target: number): number {
  return mod(target - derethTime(ticks).secondsIntoDay, DAY_TICKS) / 60;
}

// ─── Evaluator ───────────────────────────────────────────────────────────

interface Ctx { host: ExprHost; pos: number; name: string }
type Fn = (a: ExprValue[], c: Ctx) => ExprValue;
interface FnDef { min: number; max: number; fn: Fn }

const err = (c: Ctx, msg: string): never => { throw new ExprError(`${c.name}: ${msg}`, c.pos); };

function need<K extends keyof ExprHost>(c: Ctx, key: K): NonNullable<ExprHost[K]> {
  const m = c.host[key];
  if (typeof m !== 'function') throw new ExprError(`unsupported function ${c.name}`, c.pos);
  return (m as (...a: unknown[]) => unknown).bind(c.host) as NonNullable<ExprHost[K]>;
}

function num(v: ExprValue, c: Ctx, what = 'a number'): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = strToNum(v); if (n !== null) return n; }
  return err(c, `expected ${what}, got ${describe(v)}`);
}
const int = (v: ExprValue, c: Ctx) => Math.trunc(num(v, c, 'an integer'));
const str = (v: ExprValue) => exprToString(v);
function describe(v: ExprValue): string {
  if (v === null) return 'none';
  if (typeof v === 'number') return `number ${formatNumber(v)}`;
  if (typeof v === 'string') return `string '${v}'`;
  return v.kind;
}
function list(v: ExprValue, c: Ctx): ExprList {
  if (isObj(v) && v.kind === 'list') return v;
  return err(c, `expected a list, got ${describe(v)}`);
}
function dict(v: ExprValue, c: Ctx): ExprDict {
  if (isObj(v) && v.kind === 'dict') return v;
  return err(c, `expected a dictionary, got ${describe(v)}`);
}
function coords(v: ExprValue, c: Ctx): ExprCoords {
  if (isObj(v) && v.kind === 'coords') return v;
  return err(c, `expected coordinates, got ${describe(v)}`);
}
function stopwatch(v: ExprValue, c: Ctx): ExprStopwatch {
  if (isObj(v) && v.kind === 'stopwatch') return v;
  return err(c, `expected a stopwatch, got ${describe(v)}`);
}
/** World-object argument: an object value or a raw id. */
function woId(v: ExprValue, c: Ctx): number {
  if (isObj(v) && v.kind === 'wobject') return v.id;
  if (typeof v === 'number' && v !== 0) return v;
  return err(c, `expected a world object, got ${describe(v)}`);
}
const noObj = (v: ExprValue): boolean => v === null || v === 0 || v === '';
export function wobject(o: HostObject): ExprWorldObject {
  return { kind: 'wobject', id: o.id, name: o.name, objectClass: o.objectClass, templateType: o.templateType ?? 0 };
}
const mkList = (items: ExprValue[]): ExprList => ({ kind: 'list', items });

function allObjects(c: Ctx): HostObject[] {
  const h = c.host;
  if (!h.objects && !h.inventory) throw new ExprError(`unsupported function ${c.name}`, c.pos);
  return [...(h.objects?.() ?? []), ...(h.inventory?.() ?? [])];
}
const landscape = (c: Ctx) => need(c, 'objects')();
const inventory = (c: Ctx) => need(c, 'inventory')();
function lookup(c: Ctx, id: number): HostObject | null {
  const h = c.host;
  if (h.objectById) return h.objectById(id);
  const p = h.player?.();
  if (p && p.id === id) return p;
  if (!h.objects && !h.inventory && !h.player) throw new ExprError(`unsupported function ${c.name}`, c.pos);
  return (h.objects?.() ?? []).find((o) => o.id === id) ?? (h.inventory?.() ?? []).find((o) => o.id === id) ?? null;
}
function liveObject(v: ExprValue, c: Ctx): HostObject {
  const o = lookup(c, woId(v, c));
  return o ?? err(c, `object ${woId(v, c)} is not valid`);
}
function playerCoords(c: Ctx): ExprCoords {
  if (c.host.playerCoords) return c.host.playerCoords();
  const p = need(c, 'player')();
  return p.coords ?? err(c, 'player position unknown');
}
function dist3(a: ExprCoords, d: ExprCoords): number {
  return Math.hypot(a.ns - d.ns, a.ew - d.ew, a.z - d.z) * 240;
}
function nearest(c: Ctx, pred: (o: HostObject) => boolean): ExprValue {
  const me = playerCoords(c);
  const myId = c.host.player?.().id;
  let best: HostObject | null = null, bestD = Infinity;
  for (const o of landscape(c)) {
    if (!o.coords || o.id === myId || !pred(o)) continue;
    const d = dist3(me, o.coords);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best ? wobject(best) : null;
}
const firstOf = (objs: HostObject[], pred: (o: HostObject) => boolean): ExprValue => {
  const o = objs.find(pred);
  return o ? wobject(o) : null;
};
const allOf = (objs: HostObject[], pred: (o: HostObject) => boolean): ExprList => mkList(objs.filter(pred).map(wobject));
const countOf = (objs: HostObject[], pred: (o: HostObject) => boolean): number =>
  objs.filter(pred).reduce((s, o) => s + (o.stack ?? 1), 0);

function getV(c: Ctx, scope: VarScope, name: string): ExprValue {
  const v = c.host.getVar(scope, name);
  return v === undefined ? 0 : v; // VTank: an unset variable reads as 0
}

/** Run `src` with $1 (and $2) bound, restoring their previous values afterwards. */
function withSlots<T>(c: Ctx, slots: ExprValue[], src: string, run: (eval1: () => ExprValue) => T): T {
  const h = c.host;
  const names = slots.map((_, i) => String(i + 1));
  const saved = names.map((n) => h.getVar('var', n));
  const node = parseCached(src);
  try {
    return run(() => evalExpr(node, h));
  } finally {
    names.forEach((n, i) => (saved[i] === undefined ? h.clearVar('var', n) : h.setVar('var', n, saved[i]!)));
  }
}
function setSlots(c: Ctx, vals: ExprValue[]): void { vals.forEach((v, i) => c.host.setVar('var', String(i + 1), v)); }

function listIndex(l: ExprList, i: number, c: Ctx): number {
  const k = i < 0 ? l.items.length + i : i;
  if (k < 0 || k >= l.items.length) err(c, `index ${i} out of range (count ${l.items.length})`);
  return k;
}

function varFns(scope: VarScope, suffix: string): Record<string, FnDef> {
  return {
    [`test${suffix}`]: { min: 1, max: 1, fn: (a, c) => b(c.host.getVar(scope, str(a[0]!)) !== undefined) },
    [`get${suffix}`]: { min: 1, max: 1, fn: (a, c) => getV(c, scope, str(a[0]!)) },
    [`set${suffix}`]: { min: 2, max: 2, fn: (a, c) => { c.host.setVar(scope, str(a[0]!), a[1]!); return a[1]!; } },
    [`clear${suffix}`]: { min: 1, max: 1, fn: (a, c) => b(c.host.clearVar(scope, str(a[0]!))) },
    [`touch${suffix}`]: {
      min: 1, max: 1,
      fn: (a, c) => {
        const n = str(a[0]!);
        if (c.host.getVar(scope, n) !== undefined) return 1;
        c.host.setVar(scope, n, 0);
        return 0;
      },
    },
    [`clearall${suffix}s`]: { min: 0, max: 0, fn: (_a, c) => { c.host.clearAllVars(scope); return 1; } },
  };
}

const charProp = (kind: PropKind) => (a: ExprValue[], c: Ctx): ExprValue => need(c, 'charProp')(kind, int(a[0]!, c)) ?? (kind === 'string' ? '' : 0);
const objProp = (kind: PropKind) => (a: ExprValue[], c: Ctx): ExprValue =>
  need(c, 'objectProp')(woId(a[0]!, c), kind, int(a[1]!, c)) ?? (kind === 'string' ? '' : 0);

/** delayexec's pending runs per host: the id each returned, which clearexec cancels. */
const delayed = new WeakMap<ExprHost, { next: number; live: Set<number> }>();
function delayedOf(h: ExprHost): { next: number; live: Set<number> } {
  let d = delayed.get(h);
  if (!d) { d = { next: 1, live: new Set() }; delayed.set(h, d); }
  return d;
}

/** EquipMask bits that hold a weapon, in the order getequippedweapontype reads them. */
const WEAPON_SLOTS: Array<[number, string]> = [
  [0x00400000, 'Missile'], // MissileWeapon
  [0x01000000, 'Wand'], // Held (wands, staffs, orbs)
  [0x00100000, 'Melee'], // MeleeWeapon
  [0x02000000, 'Melee'], // TwoHanded (two-handed swords and spears)
];

/** Free item or pack slots in a container (you when none is given); -1 when it isn't a container. */
function freeSlots(a: ExprValue[], c: Ctx, packs: boolean): number {
  const cap = need(c, 'containerCapacity');
  const id = a.length && !noObj(a[0]!) ? woId(a[0]!, c) : need(c, 'player')().id;
  const size = cap(id);
  if (!size) return -1;
  // A pack takes a pack slot; so does a focus (Decal ObjectClass 38: it needs a pack slot).
  const isPack = (o: HostObject) => o.objectClass === 10 || o.objectClass === 38;
  const used = inventory(c).filter((o) => o.containerId === id && !o.equipMask && isPack(o) === packs).length;
  return Math.max(0, (packs ? size.containers : size.items) - used);
}

function dateText(c: Ctx, a: ExprValue[], utc: boolean): string {
  const when = new Date(c.host.wallClock?.() ?? Date.now());
  try { return formatDotNetDate(when, a.length ? str(a[0]!) : 'hh:mm:ss tt', utc); } catch (e) { c.host.echo((e as Error).message); return ''; }
}

/** Your account's characters as UB numbers them: by name, A to Z. */
function roster(c: Ctx): string[] {
  return [...need(c, 'characterNames')()].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
}

/** setnextlogin's argument: a name, or a number counted on from your character (wrapping round the list). */
function nextLoginName(c: Ctx, v: ExprValue): string | null {
  const names = roster(c);
  if (!names.length) return null;
  const n = typeof v === 'number' ? v : strToNum(str(v));
  if (n === null) {
    const want = str(v).trim().toLowerCase();
    return names.find((x) => x.toLowerCase() === want) ?? null;
  }
  const me = names.findIndex((x) => x.toLowerCase() === (c.host.player?.().name ?? '').toLowerCase());
  return names[mod((me < 0 ? 0 : me) + Math.trunc(n), names.length)]!;
}

function fellow(c: Ctx): HostFellowship | null { return need(c, 'fellowship')(); }
function myId(c: Ctx): number | undefined { return c.host.player?.().id; }
function questOf(a: ExprValue[], c: Ctx): HostQuest | null { return need(c, 'quest')(str(a[0]!)); }
function ticks(c: Ctx): number { return need(c, 'gameTicks')(); }

const F: Record<string, FnDef> = {
  // Variables
  ...varFns('var', 'var'),
  ...varFns('gvar', 'gvar'),
  ...varFns('pvar', 'pvar'),

  // Character
  getcharintprop: { min: 1, max: 1, fn: charProp('int') },
  getchardoubleprop: { min: 1, max: 1, fn: charProp('double') },
  getcharboolprop: { min: 1, max: 1, fn: charProp('bool') },
  getcharquadprop: { min: 1, max: 1, fn: charProp('quad') },
  getcharstringprop: { min: 1, max: 1, fn: charProp('string') },
  getcharvital_base: { min: 1, max: 1, fn: (a, c) => need(c, 'vital')(int(a[0]!, c))?.base ?? 0 },
  getcharvital_current: { min: 1, max: 1, fn: (a, c) => need(c, 'vital')(int(a[0]!, c))?.current ?? 0 },
  getcharvital_buffedmax: { min: 1, max: 1, fn: (a, c) => need(c, 'vital')(int(a[0]!, c))?.buffedMax ?? 0 },
  getcharskill_base: { min: 1, max: 1, fn: (a, c) => need(c, 'skill')(int(a[0]!, c))?.base ?? 0 },
  getcharskill_buffed: { min: 1, max: 1, fn: (a, c) => need(c, 'skill')(int(a[0]!, c))?.buffed ?? 0 },
  getcharskill_traininglevel: { min: 1, max: 1, fn: (a, c) => need(c, 'skill')(int(a[0]!, c))?.training ?? 0 },
  getcharattribute_base: { min: 1, max: 1, fn: (a, c) => need(c, 'attribute')(int(a[0]!, c))?.base ?? 0 },
  getcharattribute_buffed: { min: 1, max: 1, fn: (a, c) => need(c, 'attribute')(int(a[0]!, c))?.buffed ?? 0 },
  getcharburden: { min: 0, max: 0, fn: (_a, c) => need(c, 'burden')() },
  vitae: { min: 0, max: 0, fn: (_a, c) => need(c, 'vitae')() },
  getplayerlandcell: { min: 0, max: 0, fn: (_a, c) => need(c, 'playerLandcell')() },
  getplayerlandblock: { min: 0, max: 0, fn: (_a, c) => (need(c, 'playerLandcell')() & 0xffff0000) >>> 0 },
  getplayercoordinates: { min: 0, max: 0, fn: (_a, c) => ({ ...playerCoords(c) }) },
  wobjectgetplayer: { min: 0, max: 0, fn: (_a, c) => wobject(need(c, 'player')()) },
  isportaling: { min: 0, max: 0, fn: (_a, c) => b(need(c, 'isPortaling')()) },
  getbusystate: { min: 0, max: 0, fn: (_a, c) => need(c, 'busyState')() },
  getcombatstate: { min: 0, max: 0, fn: (_a, c) => need(c, 'combatState')() },
  setcombatstate: { min: 1, max: 1, fn: (a, c) => b(need(c, 'setCombatState')(str(a[0]!))) },
  getworldname: { min: 0, max: 0, fn: (_a, c) => need(c, 'worldName')() },

  // Casting
  getisspellknown: { min: 1, max: 1, fn: (a, c) => b(need(c, 'spellKnown')(int(a[0]!, c))) },
  getcancastspell_hunt: { min: 1, max: 1, fn: (a, c) => b(need(c, 'canCastSpell')(int(a[0]!, c), 'hunt')) },
  getcancastspell_buff: { min: 1, max: 1, fn: (a, c) => b(need(c, 'canCastSpell')(int(a[0]!, c), 'buff')) },
  actiontryequipanywand: { min: 0, max: 0, fn: (_a, c) => b(need(c, 'equipAnyWand')()) },
  actiontrycastbyid: { min: 1, max: 1, fn: (a, c) => b(need(c, 'castSpell')(int(a[0]!, c))) },
  actiontrycastbyidontarget: { min: 2, max: 2, fn: (a, c) => { const f = need(c, 'castSpell'); return noObj(a[1]!) ? 0 : b(f(int(a[0]!, c), woId(a[1]!, c))); } },
  spellname: { min: 1, max: 1, fn: (a, c) => need(c, 'spellName')(int(a[0]!, c)) },
  componentname: { min: 1, max: 1, fn: (a, c) => need(c, 'componentName')(int(a[0]!, c)) },
  getknownspells: { min: 0, max: 0, fn: (_a, c) => mkList(need(c, 'knownSpells')()) },
  getspellexpiration: { min: 1, max: 1, fn: (a, c) => need(c, 'spellExpiration')(int(a[0]!, c)) },
  getspellexpirationbyname: { min: 1, max: 1, fn: (a, c) => need(c, 'spellExpirationByName')(str(a[0]!)) },

  // Inventory
  wobjectfindininventorybytemplatetype: { min: 1, max: 1, fn: (a, c) => { const t = int(a[0]!, c); return firstOf(inventory(c), (o) => o.templateType === t); } },
  wobjectfindininventorybyname: { min: 1, max: 1, fn: (a, c) => { const n = str(a[0]!); return firstOf(inventory(c), (o) => o.name === n); } },
  wobjectfindininventorybynamerx: { min: 1, max: 1, fn: (a, c) => { const r = toRegExp(str(a[0]!), c.pos); return firstOf(inventory(c), (o) => r.test(o.name)); } },
  getitemcountininventorybyname: { min: 1, max: 1, fn: (a, c) => { const n = str(a[0]!); return countOf(inventory(c), (o) => o.name === n); } },
  getitemcountininventorybynamerx: { min: 1, max: 1, fn: (a, c) => { const r = toRegExp(str(a[0]!), c.pos); return countOf(inventory(c), (o) => r.test(o.name)); } },
  getinventorycountbytemplatetype: { min: 1, max: 1, fn: (a, c) => { const t = int(a[0]!, c); return countOf(inventory(c), (o) => o.templateType === t); } },
  getcontaineritemcount: {
    min: 0, max: 1,
    fn: (a, c) => { const id = a.length ? woId(a[0]!, c) : need(c, 'player')().id; return inventory(c).filter((o) => o.containerId === id).length; },
  },

  // Location
  coordinategetns: { min: 1, max: 1, fn: (a, c) => coords(a[0]!, c).ns },
  coordinategetwe: { min: 1, max: 1, fn: (a, c) => coords(a[0]!, c).ew },
  coordinategetz: { min: 1, max: 1, fn: (a, c) => coords(a[0]!, c).z },
  coordinatetostring: { min: 1, max: 1, fn: (a, c) => coordsToString(coords(a[0]!, c)) },
  coordinateparse: { min: 1, max: 1, fn: (a) => parseCoords(str(a[0]!)) },
  coordinatedistancewithz: { min: 2, max: 2, fn: (a, c) => dist3(coords(a[0]!, c), coords(a[1]!, c)) },
  coordinatedistanceflat: { min: 2, max: 2, fn: (a, c) => { const p = coords(a[0]!, c), q = coords(a[1]!, c); return Math.hypot(p.ns - q.ns, p.ew - q.ew) * 240; } },
  wobjectgetphysicscoordinates: { min: 1, max: 1, fn: (a, c) => { const o = liveObject(a[0]!, c); return o.coords ? { ...o.coords } : null; } },
  getheadingto: {
    min: 1, max: 1,
    fn: (a, c) => {
      const t = liveObject(a[0]!, c).coords ?? err(c, 'object has no position');
      const me = playerCoords(c);
      return mod(Math.atan2(t.ew - me.ew, t.ns - me.ns) * 180 / Math.PI, 360);
    },
  },
  getheading: { min: 1, max: 1, fn: (a, c) => liveObject(a[0]!, c).heading ?? err(c, 'heading unknown') },

  // Objects
  wobjectgetselection: { min: 0, max: 0, fn: (_a, c) => { const id = need(c, 'selectionId')(); const o = id ? lookup(c, id) : null; return o ? wobject(o) : null; } },
  wobjectgetopencontainer: { min: 0, max: 0, fn: (_a, c) => { const id = need(c, 'openContainerId')(); const o = id ? lookup(c, id) : null; return o ? wobject(o) : null; } },
  wobjectgetname: { min: 1, max: 1, fn: (a, c) => { const v = a[0]!; const o = lookup(c, woId(v, c)); return o?.name ?? (isObj(v) && v.kind === 'wobject' ? v.name : ''); } },
  wobjectgetobjectclass: { min: 1, max: 1, fn: (a, c) => { const v = a[0]!; const o = lookup(c, woId(v, c)); return o?.objectClass ?? (isObj(v) && v.kind === 'wobject' ? v.objectClass : 0); } },
  wobjectgettemplatetype: { min: 1, max: 1, fn: (a, c) => { const v = a[0]!; const o = lookup(c, woId(v, c)); return o?.templateType ?? (isObj(v) && v.kind === 'wobject' ? v.templateType : 0); } },
  wobjectgetid: { min: 1, max: 1, fn: (a, c) => woId(a[0]!, c) },
  wobjectisvalid: {
    min: 1, max: 1,
    fn: (a, c) => { const v = a[0]!; if (!(isObj(v) && v.kind === 'wobject')) return 0; return b(lookup(c, v.id) !== null); },
  },
  wobjectfindbyid: { min: 1, max: 1, fn: (a, c) => { const o = lookup(c, int(a[0]!, c)); return o ? wobject(o) : null; } },
  wobjectgetisdooropen: { min: 1, max: 1, fn: (a, c) => b(liveObject(a[0]!, c).isDoorOpen === true) },
  wobjectfindnearestmonster: { min: 0, max: 0, fn: (_a, c) => nearest(c, (o) => o.objectClass === 5) },
  wobjectfindnearestdoor: { min: 0, max: 0, fn: (_a, c) => nearest(c, (o) => o.objectClass === 26) },
  wobjectfindnearestbyobjectclass: { min: 1, max: 1, fn: (a, c) => { const k = int(a[0]!, c); return nearest(c, (o) => o.objectClass === k); } },
  wobjectfindnearestbytemplatetype: { min: 1, max: 1, fn: (a, c) => { const t = int(a[0]!, c); return nearest(c, (o) => o.templateType === t); } },
  wobjectfindnearestbynameandobjectclass: {
    min: 2, max: 2,
    fn: (a, c) => { const k = int(a[0]!, c); const r = toRegExp(str(a[1]!), c.pos); return nearest(c, (o) => o.objectClass === k && r.test(o.name)); },
  },
  wobjectgetintprop: { min: 2, max: 2, fn: objProp('int') },
  wobjectgetdoubleprop: { min: 2, max: 2, fn: objProp('double') },
  wobjectgetboolprop: { min: 2, max: 2, fn: objProp('bool') },
  wobjectgetstringprop: { min: 2, max: 2, fn: objProp('string') },
  wobjectgethealth: { min: 1, max: 1, fn: (a, c) => need(c, 'objectHealth')(woId(a[0]!, c)) },
  wobjecthasdata: { min: 1, max: 1, fn: (a, c) => b(need(c, 'objectHasData')(woId(a[0]!, c))) },
  wobjectrequestdata: { min: 1, max: 1, fn: (a, c) => { need(c, 'requestObjectData')(woId(a[0]!, c)); return 1; } },
  wobjectlastidtime: { min: 1, max: 1, fn: (a, c) => need(c, 'objectLastIdTime')(woId(a[0]!, c)) },
  wobjectgetspellids: { min: 1, max: 1, fn: (a, c) => mkList(need(c, 'objectSpellIds')(woId(a[0]!, c), false)) },
  wobjectgetactivespellids: { min: 1, max: 1, fn: (a, c) => mkList(need(c, 'objectSpellIds')(woId(a[0]!, c), true)) },
  wobjectfindall: { min: 0, max: 0, fn: (_a, c) => allOf(allObjects(c), () => true) },
  wobjectfindallinventory: { min: 0, max: 0, fn: (_a, c) => allOf(inventory(c), () => true) },
  wobjectfindalllandscape: { min: 0, max: 0, fn: (_a, c) => allOf(landscape(c), () => true) },
  wobjectfindallbyobjectclass: { min: 1, max: 1, fn: (a, c) => { const k = int(a[0]!, c); return allOf(allObjects(c), (o) => o.objectClass === k); } },
  wobjectfindallinventorybyobjectclass: { min: 1, max: 1, fn: (a, c) => { const k = int(a[0]!, c); return allOf(inventory(c), (o) => o.objectClass === k); } },
  wobjectfindalllandscapebyobjectclass: { min: 1, max: 1, fn: (a, c) => { const k = int(a[0]!, c); return allOf(landscape(c), (o) => o.objectClass === k); } },
  wobjectfindallbytemplatetype: { min: 1, max: 1, fn: (a, c) => { const t = int(a[0]!, c); return allOf(allObjects(c), (o) => o.templateType === t); } },
  wobjectfindallinventorybytemplatetype: { min: 1, max: 1, fn: (a, c) => { const t = int(a[0]!, c); return allOf(inventory(c), (o) => o.templateType === t); } },
  wobjectfindalllandscapebytemplatetype: { min: 1, max: 1, fn: (a, c) => { const t = int(a[0]!, c); return allOf(landscape(c), (o) => o.templateType === t); } },
  wobjectfindallbynamerx: { min: 1, max: 1, fn: (a, c) => { const r = toRegExp(str(a[0]!), c.pos); return allOf(allObjects(c), (o) => r.test(o.name)); } },
  wobjectfindallinventorybynamerx: { min: 1, max: 1, fn: (a, c) => { const r = toRegExp(str(a[0]!), c.pos); return allOf(inventory(c), (o) => r.test(o.name)); } },
  wobjectfindalllandscapebynamerx: { min: 1, max: 1, fn: (a, c) => { const r = toRegExp(str(a[0]!), c.pos); return allOf(landscape(c), (o) => r.test(o.name)); } },
  wobjectfindallbycontainer: { min: 1, max: 1, fn: (a, c) => { const id = woId(a[0]!, c); return allOf(allObjects(c), (o) => o.containerId === id); } },
  getobjectinternaltype: { min: 1, max: 1, fn: (a) => internalType(a[0]!) },
  // UtilityBelt: an object's AC ItemType (0 when the client doesn't know the object).
  wobjectgetinternaltype: { min: 1, max: 1, fn: (a, c) => (noObj(a[0]!) ? 0 : lookup(c, woId(a[0]!, c))?.itemType ?? 0) },
  // UB: an object's current health / stamina / mana, 0 while the client hasn't been told it.
  wobjectgethealthvalue: { min: 1, max: 1, fn: (a, c) => need(c, 'objectVital')(woId(a[0]!, c), 1) ?? 0 },
  wobjectgetstaminavalue: { min: 1, max: 1, fn: (a, c) => need(c, 'objectVital')(woId(a[0]!, c), 2) ?? 0 },
  wobjectgetmanavalue: { min: 1, max: 1, fn: (a, c) => need(c, 'objectVital')(woId(a[0]!, c), 3) ?? 0 },
  // UB: free item / pack slots in a container (yours by default); -1 when it isn't a container.
  getfreeitemslots: { min: 0, max: 1, fn: (a, c) => freeSlots(a, c, false) },
  getfreecontainerslots: { min: 0, max: 1, fn: (a, c) => freeSlots(a, c, true) },
  // UB: "Missile", "Wand", "Melee" or "None", by the slot your weapon is wielded in.
  getequippedweapontype: {
    min: 0, max: 0,
    fn: (_a, c) => {
      const worn = inventory(c).filter((o) => o.equipMask);
      for (const [bit, name] of WEAPON_SLOTS) if (worn.some((o) => ((o.equipMask ?? 0) & bit) !== 0)) return name;
      return 'None';
    },
  },
  // UB: seconds left on a shared item cooldown, by its cooldown id (0 when it isn't running).
  getcooldownexpiration: { min: 1, max: 1, fn: (a, c) => need(c, 'cooldownRemaining')(int(a[0]!, c)) },
  // UB: corpses you can see that you haven't opened (their ids), and whether you opened one.
  getcorpsesunopenedbyme: {
    min: 0, max: 0,
    fn: (_a, c) => { const opened = need(c, 'corpseOpenedByMe'); return mkList(landscape(c).filter((o) => o.objectClass === 27 && !opened(o.id)).map((o) => o.id)); },
  },
  hascorpsebeenopenedbyme: { min: 1, max: 1, fn: (a, c) => { const opened = need(c, 'corpseOpenedByMe'); return noObj(a[0]!) ? 0 : b(opened(woId(a[0]!, c))); } },

  // Actions. A "try" with no object (none / unset variable) is a failed attempt (0), not an error.
  actiontryselect: { min: 1, max: 1, fn: (a, c) => { const f = need(c, 'select'); return noObj(a[0]!) ? 0 : b(f(woId(a[0]!, c))); } },
  actiontryuseitem: { min: 1, max: 1, fn: (a, c) => { const f = need(c, 'useItem'); return noObj(a[0]!) ? 0 : b(f(woId(a[0]!, c))); } },
  actiontryapplyitem: { min: 2, max: 2, fn: (a, c) => { const f = need(c, 'applyItem'); return noObj(a[0]!) || noObj(a[1]!) ? 0 : b(f(woId(a[0]!, c), woId(a[1]!, c))); } },
  actiontrygiveitem: { min: 2, max: 2, fn: (a, c) => { const f = need(c, 'giveItem'); return noObj(a[0]!) || noObj(a[1]!) ? 0 : b(f(woId(a[0]!, c), woId(a[1]!, c))); } },
  actiontrygiveprofile: { min: 2, max: 2, fn: (a, c) => { const f = need(c, 'giveProfile'); return noObj(a[1]!) ? 0 : b(f(str(a[0]!), woId(a[1]!, c))); } },
  setmotion: { min: 2, max: 2, fn: (a, c) => { need(c, 'setMotion')(str(a[0]!), truthy(a[1]!)); return 1; } },
  getmotion: { min: 1, max: 1, fn: (a, c) => b(need(c, 'getMotion')(str(a[0]!))) },
  clearmotion: { min: 0, max: 0, fn: (_a, c) => { need(c, 'clearMotion')(); return 1; } },
  // UB: drop an item on the ground; move one into a container (slot, and whether it may join a stack there: yes unless 0).
  actiontrydrop: { min: 1, max: 1, fn: (a, c) => { const f = need(c, 'dropItem'); return noObj(a[0]!) ? 0 : b(f(woId(a[0]!, c))); } },
  actiontrymove: {
    min: 2, max: 4,
    fn: (a, c) => {
      const f = need(c, 'moveItem');
      if (noObj(a[0]!) || noObj(a[1]!)) return 0;
      return b(f(woId(a[0]!, c), woId(a[1]!, c), a.length > 2 ? int(a[2]!, c) : 0, null, a.length < 4 || truthy(a[3]!)));
    },
  },
  // UB: split newStackSize off a stack into a container (you by default) at a slot, joining a stack there only when merge is set.
  // Nothing while you are busy (0); otherwise 1 whatever the server then does.
  actiontrysplit: {
    min: 2, max: 5,
    fn: (a, c) => {
      const f = need(c, 'moveItem');
      if (noObj(a[0]!)) return 0;
      const item = woId(a[0]!, c);
      const amount = int(a[1]!, c);
      const dest = a.length > 2 && !noObj(a[2]!) ? woId(a[2]!, c) : need(c, 'player')().id;
      if ((c.host.busyState?.() ?? 0) !== 0) return 0;
      c.host.select?.(item);
      f(item, dest, a.length > 3 ? int(a[3]!, c) : 0, amount, a.length > 4 && truthy(a[4]!));
      return 1;
    },
  },

  // UI
  chatbox: { min: 1, max: 1, fn: (a, c) => { const t = str(a[0]!); need(c, 'chatbox')(t); return t; } },
  chatboxpaste: { min: 1, max: 1, fn: (a, c) => { const t = str(a[0]!); need(c, 'chatboxPaste')(t); return t; } },
  echo: { min: 1, max: 2, fn: (a, c) => { const t = str(a[0]!); c.host.echo(t, a.length > 1 ? int(a[1]!, c) : undefined); return t; } },
  statushud: { min: 2, max: 2, fn: (a, c) => { need(c, 'statusHud')(str(a[0]!), str(a[1]!)); return 1; } },
  statushudcolored: { min: 3, max: 3, fn: (a, c) => { need(c, 'statusHud')(str(a[0]!), str(a[1]!), int(a[2]!, c)); return 1; } },
  // Meta Views (wiki Meta_Expressions): a control reference, none when that open view has no such control.
  uigetcontrol: { min: 2, max: 2, fn: (a, c) => { const view = str(a[0]!), control = str(a[1]!); return need(c, 'viewControl')(view, control) ? { kind: 'viewcontrol', view, control } : null; } },
  // "Sets the text label of a Meta View control. Works on Buttons." 1 when it was set.
  uisetlabel: { min: 2, max: 2, fn: (a, c) => {
    const v = a[0]!;
    if (!isObj(v) || v.kind !== 'viewcontrol') return err(c, 'expects a view control (uigetcontrol[window, control])');
    return b(need(c, 'setViewLabel')(v.view, v.control, str(a[1]!)));
  } },

  // UB's view functions: show or hide a control (the visible argument comes back), is a view shown, is it open.
  uisetvisible: { min: 2, max: 2, fn: (a, c) => {
    const v = a[0]!;
    if (!isObj(v) || v.kind !== 'viewcontrol') return err(c, 'expects a view control (uigetcontrol[window, control])');
    need(c, 'setViewVisible')(v.view, v.control, truthy(a[1]!));
    return a[1]!;
  } },
  uiviewvisible: { min: 1, max: 1, fn: (a, c) => b(need(c, 'viewVisible')(str(a[0]!))) },
  uiviewexists: { min: 1, max: 1, fn: (a, c) => b(need(c, 'viewExists')(str(a[0]!))) },

  // UB's XP meter.
  xpreset: { min: 0, max: 0, fn: (_a, c) => { need(c, 'xpReset')(); return 1; } },
  xpmeter: { min: 0, max: 0, fn: (_a, c) => xpMeterText(need(c, 'xpMeter')()) },
  xpduration: { min: 0, max: 0, fn: (_a, c) => need(c, 'xpMeter')().seconds },
  xptotal: { min: 0, max: 0, fn: (_a, c) => need(c, 'xpMeter')().xp },
  xpavg: { min: 0, max: 0, fn: (_a, c) => { const m = need(c, 'xpMeter')(); return m.seconds > 0 ? (m.xp * 3600) / m.seconds : 0; } },
  lumtotal: { min: 0, max: 0, fn: (_a, c) => need(c, 'xpMeter')().lum },
  lumavg: { min: 0, max: 0, fn: (_a, c) => { const m = need(c, 'xpMeter')(); return m.seconds > 0 ? (m.lum * 3600) / m.seconds : 0; } },

  // UB's login switching: the character you log in as after this one logs out.
  // getcharacterindex: a name's place among your characters, A to Z (yours when empty), -1 when not on the account.
  getcharacterindex: {
    min: 1, max: 1,
    fn: (a, c) => {
      const want = (str(a[0]!).trim() || (c.host.player?.().name ?? '')).toLowerCase();
      return roster(c).findIndex((n) => n.toLowerCase() === want);
    },
  },
  setnextlogin: { min: 1, max: 1, fn: (a, c) => { const set = need(c, 'setNextLogin'); const name = nextLoginName(c, a[0]!); return name ? b(set(name)) : 0; } },
  clearnextlogin: { min: 0, max: 0, fn: (_a, c) => b(need(c, 'setNextLogin')(null)) },

  // Logic
  iif: { min: 3, max: 3, fn: (a) => (truthy(a[0]!) ? a[1]! : a[2]!) },
  istrue: { min: 1, max: 1, fn: (a) => b(truthy(a[0]!)) },
  isfalse: { min: 1, max: 1, fn: (a) => b(!truthy(a[0]!)) },
  ifthen: {
    min: 2, max: 3,
    fn: (a, c) => {
      const src = truthy(a[0]!) ? a[1]! : a.length > 2 ? a[2]! : null;
      return src === null ? 0 : runExpr(str(src), c.host);
    },
  },
  exec: { min: 1, max: 1, fn: (a, c) => runExpr(str(a[0]!), c.host) },
  // UB: delayexec answers an id that clearexec[id] cancels (1 when it was still waiting).
  delayexec: {
    min: 2, max: 2,
    fn: (a, c) => {
      const src = str(a[1]!);
      parseCached(src);
      const schedule = need(c, 'schedule');
      const d = delayedOf(c.host);
      const id = d.next++;
      d.live.add(id);
      schedule(Math.max(0, num(a[0]!, c)), () => { if (d.live.delete(id)) runExpr(src, c.host); });
      return id;
    },
  },
  clearexec: { min: 1, max: 1, fn: (a, c) => b(delayedOf(c.host).live.delete(int(a[0]!, c))) },

  // Numbers
  randint: { min: 2, max: 2, fn: (a, c) => { const lo = int(a[0]!, c), hi = int(a[1]!, c); const r = c.host.random?.() ?? Math.random(); return hi <= lo ? lo : lo + Math.floor(r * (hi - lo)); } },
  round: { min: 1, max: 1, fn: (a, c) => bankersRound(num(a[0]!, c)) },
  floor: { min: 1, max: 1, fn: (a, c) => Math.floor(num(a[0]!, c)) },
  ceiling: { min: 1, max: 1, fn: (a, c) => Math.ceil(num(a[0]!, c)) },
  abs: { min: 1, max: 1, fn: (a, c) => Math.abs(num(a[0]!, c)) },
  sqrt: { min: 1, max: 1, fn: (a, c) => Math.sqrt(num(a[0]!, c)) },
  sin: { min: 1, max: 1, fn: (a, c) => Math.sin(num(a[0]!, c)) },
  cos: { min: 1, max: 1, fn: (a, c) => Math.cos(num(a[0]!, c)) },
  tan: { min: 1, max: 1, fn: (a, c) => Math.tan(num(a[0]!, c)) },
  asin: { min: 1, max: 1, fn: (a, c) => Math.asin(num(a[0]!, c)) },
  acos: { min: 1, max: 1, fn: (a, c) => Math.acos(num(a[0]!, c)) },
  atan: { min: 1, max: 1, fn: (a, c) => Math.atan(num(a[0]!, c)) },
  atan2: { min: 2, max: 2, fn: (a, c) => Math.atan2(num(a[0]!, c), num(a[1]!, c)) },
  sinh: { min: 1, max: 1, fn: (a, c) => Math.sinh(num(a[0]!, c)) },
  cosh: { min: 1, max: 1, fn: (a, c) => Math.cosh(num(a[0]!, c)) },
  tanh: { min: 1, max: 1, fn: (a, c) => Math.tanh(num(a[0]!, c)) },

  // Strings
  cstr: { min: 1, max: 1, fn: (a) => str(a[0]!) },
  tostring: { min: 1, max: 1, fn: (a) => str(a[0]!) },
  cstrf: { min: 2, max: 2, fn: (a, c) => formatDotNet(num(a[0]!, c), str(a[1]!)) },
  cnumber: { min: 1, max: 1, fn: (a) => (typeof a[0] === 'number' ? a[0] : strToNum(str(a[0]!)) ?? 0) },
  strlen: { min: 1, max: 1, fn: (a) => str(a[0]!).length },
  getregexmatch: { min: 2, max: 2, fn: (a, c) => toRegExp(str(a[1]!), c.pos).exec(str(a[0]!))?.[0] ?? '' },
  // Inferred: metas compare hexstr[x&0x2] with `0x2`, so the result carries the 0x prefix.
  hexstr: { min: 1, max: 1, fn: (a, c) => `0x${(int(a[0]!, c) >>> 0).toString(16).toUpperCase()}` },
  chr: { min: 1, max: 1, fn: (a, c) => String.fromCharCode(int(a[0]!, c)) },
  ord: { min: 1, max: 1, fn: (a, c) => { const s = str(a[0]!); return s.length ? s.charCodeAt(0) : err(c, 'empty string'); } },

  // Time
  stopwatchcreate: { min: 0, max: 0, fn: () => ({ kind: 'stopwatch', startedAt: null, accumulatedMs: 0 }) },
  stopwatchstart: { min: 1, max: 1, fn: (a, c) => { const s = stopwatch(a[0]!, c); if (s.startedAt === null) s.startedAt = c.host.now(); return s; } },
  stopwatchstop: {
    min: 1, max: 1,
    fn: (a, c) => { const s = stopwatch(a[0]!, c); if (s.startedAt !== null) { s.accumulatedMs += c.host.now() - s.startedAt; s.startedAt = null; } return s; },
  },
  stopwatchelapsedseconds: {
    min: 1, max: 1,
    fn: (a, c) => { const s = stopwatch(a[0]!, c); return (s.accumulatedMs + (s.startedAt === null ? 0 : c.host.now() - s.startedAt)) / 1000; },
  },
  getunixtime: { min: 0, max: 0, fn: (_a, c) => (c.host.wallClock?.() ?? Date.now()) / 1000 },
  // UB: the date as a .NET format string writes it (default "hh:mm:ss tt"); a bad format answers "".
  getdatetimelocal: { min: 0, max: 1, fn: (a, c) => dateText(c, a, false) },
  getdatetimeutc: { min: 0, max: 1, fn: (a, c) => dateText(c, a, true) },
  getgameticks: { min: 0, max: 0, fn: (_a, c) => ticks(c) },
  getgameyear: { min: 0, max: 0, fn: (_a, c) => derethTime(ticks(c)).year },
  getgamemonth: { min: 0, max: 0, fn: (_a, c) => derethTime(ticks(c)).month },
  getgameday: { min: 0, max: 0, fn: (_a, c) => derethTime(ticks(c)).day },
  getgamehour: { min: 0, max: 0, fn: (_a, c) => derethTime(ticks(c)).hour },
  getgamehourname: { min: 1, max: 1, fn: (a, c) => DERETH_HOUR_NAMES[int(a[0]!, c) - 1] ?? err(c, 'hour must be 1..16') },
  getgamemonthname: { min: 1, max: 1, fn: (a, c) => DERETH_MONTH_NAMES[int(a[0]!, c) - 1] ?? err(c, 'month must be 1..12') },
  getisday: { min: 0, max: 0, fn: (_a, c) => { const h = derethTime(ticks(c)).hour; return b(h >= 5 && h <= 12); } },
  getisnight: { min: 0, max: 0, fn: (_a, c) => { const h = derethTime(ticks(c)).hour; return b(h < 5 || h > 12); } },
  getminutesuntilday: { min: 0, max: 0, fn: (_a, c) => { const t = ticks(c); const h = derethTime(t).hour; return h >= 5 && h <= 12 ? 0 : minutesUntil(t, DAY_START); } },
  getminutesuntilnight: { min: 0, max: 0, fn: (_a, c) => { const t = ticks(c); const h = derethTime(t).hour; return h < 5 || h > 12 ? 0 : minutesUntil(t, NIGHT_START); } },

  // Settings / meta
  vtgetsetting: { min: 1, max: 1, fn: (a, c) => need(c, 'vtGetSetting')(str(a[0]!)) },
  vtsetsetting: { min: 2, max: 2, fn: (a, c) => b(need(c, 'vtSetSetting')(str(a[0]!), str(a[1]!))) },
  uboptget: { min: 1, max: 1, fn: (a, c) => need(c, 'ubGetOption')(str(a[0]!)) },
  uboptset: { min: 2, max: 2, fn: (a, c) => b(need(c, 'ubSetOption')(str(a[0]!), a[1]!)) },
  vtgetmetastate: { min: 0, max: 0, fn: (_a, c) => need(c, 'getMetaState')() },
  vtsetmetastate: { min: 1, max: 1, fn: (a, c) => { need(c, 'setMetaState')(str(a[0]!)); return 1; } },
  // UB: the meta profile loaded, and whether the macro is running.
  vtgetmeta: { min: 0, max: 0, fn: (_a, c) => need(c, 'metaName')() },
  vtmacroenabled: { min: 0, max: 0, fn: (_a, c) => b(need(c, 'macroEnabled')()) },

  // Fellowship
  getfellowshipstatus: { min: 0, max: 0, fn: (_a, c) => b(fellow(c) !== null) },
  getfellowshipname: { min: 0, max: 0, fn: (_a, c) => fellow(c)?.name ?? '' },
  getfellowshipcount: { min: 0, max: 0, fn: (_a, c) => fellow(c)?.members.length ?? 0 },
  getfellownames: { min: 0, max: 0, fn: (_a, c) => mkList((fellow(c)?.members ?? []).map((m) => m.name)) },
  getfellowids: { min: 0, max: 0, fn: (_a, c) => mkList((fellow(c)?.members ?? []).map((m) => m.id)) },
  getfellowname: { min: 1, max: 1, fn: (a, c) => { const m = fellow(c)?.members ?? []; return m[listIndex(mkList(m.map((x) => x.name)), int(a[0]!, c), c)]!.name; } },
  getfellowid: { min: 1, max: 1, fn: (a, c) => { const m = fellow(c)?.members ?? []; return m[listIndex(mkList(m.map((x) => x.id)), int(a[0]!, c), c)]!.id; } },
  getfellowshipleaderid: { min: 0, max: 0, fn: (_a, c) => fellow(c)?.leaderId ?? 0 },
  getfellowshipisleader: { min: 0, max: 0, fn: (_a, c) => { const f = fellow(c); return b(f !== null && f.leaderId !== undefined && f.leaderId === myId(c)); } },
  getfellowshipisopen: { min: 0, max: 0, fn: (_a, c) => b(fellow(c)?.open === true) },
  getfellowshiplocked: { min: 0, max: 0, fn: (_a, c) => b(fellow(c)?.locked === true) },
  // A fellowship holds 9 (ACE Fellowship.MaxFellows).
  getfellowshipisfull: { min: 0, max: 0, fn: (_a, c) => b((fellow(c)?.members.length ?? 0) >= 9) },
  getfellowshipcanrecruit: {
    min: 0, max: 0,
    fn: (_a, c) => { const f = fellow(c); return b(f !== null && f.members.length < 9 && (f.open === true || (f.leaderId !== undefined && f.leaderId === myId(c)))); },
  },

  // Quests
  getqueststatus: { min: 1, max: 1, fn: (a, c) => { const q = questOf(a, c); return b(q === null || q.ready); } },
  testquestflag: { min: 1, max: 1, fn: (a, c) => b(questOf(a, c) !== null) },
  getquestktprogress: { min: 1, max: 1, fn: (a, c) => questOf(a, c)?.solves ?? 0 },
  getquestktrequired: { min: 1, max: 1, fn: (a, c) => questOf(a, c)?.maxSolves ?? 0 },
  isrefreshingquests: { min: 0, max: 0, fn: (_a, c) => b(need(c, 'isRefreshingQuests')()) },

  // Lists
  listcreate: { min: 0, max: Infinity, fn: (a) => mkList([...a]) },
  listadd: { min: 2, max: 2, fn: (a, c) => { const l = list(a[0]!, c); l.items.push(a[1]!); return l; } },
  listinsert: {
    min: 3, max: 3,
    fn: (a, c) => { const l = list(a[0]!, c); const i = int(a[2]!, c); if (i < 0 || i > l.items.length) err(c, `index ${i} out of range`); l.items.splice(i, 0, a[1]!); return l; },
  },
  listremove: { min: 2, max: 2, fn: (a, c) => { const l = list(a[0]!, c); const i = l.items.findIndex((x) => equal(x, a[1]!)); if (i >= 0) l.items.splice(i, 1); return l; } },
  listremoveat: { min: 2, max: 2, fn: (a, c) => { const l = list(a[0]!, c); l.items.splice(listIndex(l, int(a[1]!, c), c), 1); return l; } },
  listpop: {
    min: 1, max: 2,
    fn: (a, c) => { const l = list(a[0]!, c); if (!l.items.length) err(c, 'list is empty'); const i = listIndex(l, a.length > 1 ? int(a[1]!, c) : -1, c); return l.items.splice(i, 1)[0]!; },
  },
  listgetitem: { min: 2, max: 2, fn: (a, c) => { const l = list(a[0]!, c); return l.items[listIndex(l, int(a[1]!, c), c)]!; } },
  listcontains: { min: 2, max: 2, fn: (a, c) => b(list(a[0]!, c).items.some((x) => equal(x, a[1]!))) },
  listindexof: { min: 2, max: 2, fn: (a, c) => list(a[0]!, c).items.findIndex((x) => equal(x, a[1]!)) },
  listlastindexof: { min: 2, max: 2, fn: (a, c) => { const it = list(a[0]!, c).items; for (let i = it.length - 1; i >= 0; i--) if (equal(it[i]!, a[1]!)) return i; return -1; } },
  listcount: { min: 1, max: 1, fn: (a, c) => list(a[0]!, c).items.length },
  listclear: { min: 1, max: 1, fn: (a, c) => { const l = list(a[0]!, c); l.items.length = 0; return l; } },
  listcopy: { min: 1, max: 1, fn: (a, c) => mkList([...list(a[0]!, c).items]) },
  // Inferred: returns a reversed copy (the reference doesn't say; a copy can't surprise a caller holding the original).
  listreverse: { min: 1, max: 1, fn: (a, c) => mkList([...list(a[0]!, c).items].reverse()) },
  listfromrange: {
    min: 2, max: 2,
    fn: (a, c) => { const lo = int(a[0]!, c), hi = int(a[1]!, c); const out: ExprValue[] = []; const step = hi >= lo ? 1 : -1; for (let i = lo; step > 0 ? i <= hi : i >= hi; i += step) out.push(i); return mkList(out); },
  },
  listfilter: {
    min: 2, max: 2,
    fn: (a, c) => { const l = list(a[0]!, c); return withSlots(c, [0], str(a[1]!), (ev) => mkList(l.items.filter((x) => { setSlots(c, [x]); return truthy(ev()); }))); },
  },
  listmap: {
    min: 2, max: 2,
    fn: (a, c) => { const l = list(a[0]!, c); return withSlots(c, [0], str(a[1]!), (ev) => mkList(l.items.map((x) => { setSlots(c, [x]); return ev(); }))); },
  },
  // $1 = item, $2 = running value, which starts at 0 (corpus: listreduce[doors,`$2+wobjectgetisdooropen[$1]`] counts open doors).
  listreduce: {
    min: 2, max: 2,
    fn: (a, c) => { const l = list(a[0]!, c); return withSlots(c, [0, 0], str(a[1]!), (ev) => l.items.reduce<ExprValue>((acc, x) => { setSlots(c, [x, acc]); return ev(); }, 0)); },
  },
  // Comparator: $1, $2 → negative / 0 / positive. Returns a sorted copy.
  listsort: {
    min: 2, max: 2,
    fn: (a, c) => { const l = list(a[0]!, c); return withSlots(c, [0, 0], str(a[1]!), (ev) => mkList([...l.items].sort((x, y) => { setSlots(c, [x, y]); return num(ev(), c); }))); },
  },

  // Dictionaries
  dictcreate: {
    min: 0, max: Infinity,
    fn: (a, c) => { if (a.length % 2) err(c, 'needs key,value pairs'); const m = new Map<string, ExprValue>(); for (let i = 0; i < a.length; i += 2) m.set(str(a[i]!), a[i + 1]!); return { kind: 'dict', map: m }; },
  },
  dictgetitem: { min: 2, max: 2, fn: (a, c) => { const v = dict(a[0]!, c).map.get(str(a[1]!)); return v === undefined ? 0 : v; } },
  dicthaskey: { min: 2, max: 2, fn: (a, c) => b(dict(a[0]!, c).map.has(str(a[1]!))) },
  dictadditem: { min: 3, max: 3, fn: (a, c) => { const d = dict(a[0]!, c); d.map.set(str(a[1]!), a[2]!); return d; } },
  dictremovekey: { min: 2, max: 2, fn: (a, c) => b(dict(a[0]!, c).map.delete(str(a[1]!))) },
  dictkeys: { min: 1, max: 1, fn: (a, c) => mkList([...dict(a[0]!, c).map.keys()]) },
  dictvalues: { min: 1, max: 1, fn: (a, c) => mkList([...dict(a[0]!, c).map.values()]) },
  dictsize: { min: 1, max: 1, fn: (a, c) => dict(a[0]!, c).map.size },
  dictclear: { min: 1, max: 1, fn: (a, c) => { const d = dict(a[0]!, c); d.map.clear(); return d; } },
  dictcopy: { min: 1, max: 1, fn: (a, c) => ({ kind: 'dict', map: new Map(dict(a[0]!, c).map) }) },
};

/**
 * Documented VTank/UB functions this module deliberately does not run: salvage
 * through the Ust (ust*; the macro's own Salvage loot action does that),
 * multi-client networking (netclients), the account hash (the browser never
 * holds the Decal account's name), and the item-detail blobs spelldata /
 * componentdata.
 */
export const UNSUPPORTED_FUNCTIONS: readonly string[] = [
  'ustadd', 'ustopen', 'ustsalvage', 'netclients', 'getaccounthash', 'spelldata', 'componentdata',
];

/** Every function name the evaluator implements (host support aside). */
export const EXPR_FUNCTIONS: readonly string[] = Object.keys(F).sort();

function parseCoords(s: string): ExprValue {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([NnSs])[\s,]+(\d+(?:\.\d+)?)\s*([EeWw])(?:[\s,]+(-?\d+(?:\.\d+)?)\s*[Zz])?\s*$/.exec(s);
  if (!m) return null;
  const ns = Number(m[1]) * (/[Ss]/.test(m[2]!) ? -1 : 1);
  const ew = Number(m[3]) * (/[Ww]/.test(m[4]!) ? -1 : 1);
  return { kind: 'coords', ns, ew, z: m[5] ? Number(m[5]) : 0 };
}

/** 0 none, 1 number, 3 string, 7 object (lists, dicts, coordinates, stopwatches count as objects). */
function internalType(v: ExprValue): number {
  if (v === null) return 0;
  if (typeof v === 'number') return 1;
  if (typeof v === 'string') return 3;
  return 7;
}

function arith(op: BinaryOp, l: ExprValue, r: ExprValue, c: Ctx): ExprValue {
  if (op === '+' && (typeof l === 'string' || typeof r === 'string')) return str(l) + str(r);
  const x = num(l, c), y = num(r, c);
  if ((op === '&' || op === '|') && !(Number.isFinite(x) && Number.isFinite(y))) return err(c, 'bitwise operands must be finite numbers');
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': return x / y;
    case '%': return x % y;
    case '^': return x ** y;
    case '&': return Number(BigInt.asIntN(64, BigInt(Math.trunc(x)) & BigInt(Math.trunc(y))));
    case '|': return Number(BigInt.asIntN(64, BigInt(Math.trunc(x)) | BigInt(Math.trunc(y))));
    default: return err(c, `bad operator ${op}`);
  }
}

function compare(l: ExprValue, r: ExprValue, c: Ctx): number {
  const ln = typeof l === 'number' ? l : typeof l === 'string' ? strToNum(l) : null;
  const rn = typeof r === 'number' ? r : typeof r === 'string' ? strToNum(r) : null;
  if (ln !== null && rn !== null) return ln - rn;
  if (typeof l === 'string' && typeof r === 'string') return l < r ? -1 : l > r ? 1 : 0;
  return err(c, `can't compare ${describe(l)} with ${describe(r)}`);
}

function indexValue(t: ExprValue, i: ExprValue, c: Ctx): ExprValue {
  if (isObj(t) && t.kind === 'dict') { const v = t.map.get(str(i)); return v === undefined ? 0 : v; }
  if (isObj(t) && t.kind === 'list') return t.items[listIndex(t, int(i, c), c)]!;
  if (typeof t === 'string') {
    const k = int(i, c), j = k < 0 ? t.length + k : k;
    if (j < 0 || j >= t.length) err(c, `index ${k} out of range (length ${t.length})`);
    return t[j]!;
  }
  return err(c, `can't index ${describe(t)}`);
}

function sliceValue(t: ExprValue, s: ExprValue | null, e: ExprValue | null, c: Ctx): ExprValue {
  const len = typeof t === 'string' ? t.length : isObj(t) && t.kind === 'list' ? t.items.length : err(c, `can't slice ${describe(t)}`);
  const clamp = (v: ExprValue | null, d: number) => { if (v === null) return d; const k = int(v, c); return Math.max(0, Math.min(len, k < 0 ? len + k : k)); };
  const a = clamp(s, 0), z = clamp(e, len);
  if (typeof t === 'string') return t.slice(a, z);
  return mkList((t as ExprList).items.slice(a, z));
}

export function evalExpr(node: ExprNode, host: ExprHost): ExprValue {
  const c: Ctx = { host, pos: node.pos, name: '' };
  switch (node.type) {
    case 'num': return node.value;
    case 'str': return node.value;
    case 'var': return getV(c, 'var', node.name);
    case 'seq': { let v: ExprValue = 0; for (const n of node.items) v = evalExpr(n, host); return v; }
    case 'unary': {
      const v = evalExpr(node.arg, host);
      return node.op === '!' ? b(!truthy(v)) : -num(v, { ...c, name: '-' });
    }
    case 'index': return indexValue(evalExpr(node.target, host), evalExpr(node.index, host), { ...c, name: '{}' });
    case 'slice':
      return sliceValue(evalExpr(node.target, host), node.start ? evalExpr(node.start, host) : null, node.end ? evalExpr(node.end, host) : null, { ...c, name: '{:}' });
    case 'binary': {
      const oc = { ...c, name: node.op };
      if (node.op === '&&') return b(truthy(evalExpr(node.left, host)) && truthy(evalExpr(node.right, host)));
      if (node.op === '||') return b(truthy(evalExpr(node.left, host)) || truthy(evalExpr(node.right, host)));
      const l = evalExpr(node.left, host), r = evalExpr(node.right, host);
      switch (node.op) {
        case '==': return b(equal(l, r));
        case '!=': return b(!equal(l, r));
        case '#': return b(toRegExp(str(r), node.pos).test(str(l)));
        case '<': return b(compare(l, r, oc) < 0);
        case '>': return b(compare(l, r, oc) > 0);
        case '<=': return b(compare(l, r, oc) <= 0);
        case '>=': return b(compare(l, r, oc) >= 0);
        default: return arith(node.op, l, r, oc);
      }
    }
    case 'call': {
      const def = F[node.name];
      if (!def) {
        if (UNSUPPORTED_FUNCTIONS.includes(node.name)) throw new ExprError(`unsupported function ${node.name}`, node.pos);
        throw new ExprError(`unknown function ${node.name}`, node.pos);
      }
      const fc: Ctx = { host, pos: node.pos, name: node.name };
      if (node.args.length < def.min || node.args.length > def.max) {
        const want = def.min === def.max ? `${def.min}` : def.max === Infinity ? `at least ${def.min}` : `${def.min}-${def.max}`;
        throw new ExprError(`${node.name} takes ${want} argument${want === '1' ? '' : 's'}, got ${node.args.length}`, node.pos);
      }
      return def.fn(node.args.map((a) => evalExpr(a, host)), fc);
    }
  }
}

export function runExpr(src: string, host: ExprHost): ExprValue {
  return evalExpr(parseCached(src), host);
}
