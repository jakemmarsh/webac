/**
 * Inline global/constant VALUES into the decompiled retail client.
 *
 * Ghidra prints globals as bare names (`::MAX_QUANTUM`, `PhysicsTimer::curr_time`)
 * with no initializer, so a reader of acclient-decompiled.c has to know to look
 * each one up in symbols/globals.tsv. This appends the value as an end-of-line
 * comment wherever a known global is referenced, so it is on screen in every
 * grep / sed of the decomp:
 *
 *   PhysicsTimer::curr_time = PhysicsTimer::curr_time + ::MAX_QUANTUM; //= MAX_QUANTUM: dyninit $E116: ___real_3ff0000000000000 / MIN_FRAMERATE
 *
 * Only appends to the END of a line, so line numbers (cited all over
 * docs/ and progress.md) match the plain decomp. Written to a separate
 * acclient-decompiled.annotated.c; the plain file stays byte-identical for the
 * tests that match its lines. Idempotent: lines that already carry the marker
 * are left alone.
 */

export const ANNOTATION_MARKER = ' //= ';

/** Longest value text inlined; longer ones are cut with an ellipsis. */
const MAX_VALUE_LEN = 80;

export interface GlobalValue {
  /** 'static' | 'const' | 'dyninit' (bss rows carry no initial value). */
  init: string;
  value: string;
}

/**
 * Build name → annotation text from globals.tsv content. Skips rows without a
 * usable initial value (bss, function pointers, compiler `$` temporaries,
 * runtime-constructed objects). A name whose copies disagree is reported as
 * ambiguous instead of picking one.
 */
export function buildAnnotationTable(tsv: string): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  const lines = tsv.split('\n');
  const header = lines[0].split('\t');
  const col = (n: string) => header.indexOf(n);
  const iName = col('name'), iType = col('type'), iInit = col('init'), iValue = col('value');
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split('\t');
    if (f.length < header.length) continue;
    const name = f[iName], type = f[iType], init = f[iInit], value = f[iValue];
    if (!name || name.startsWith('$') || name.startsWith('`')) continue;
    if (init === 'bss' || value === '') continue;
    if (type.includes('<function>') || type.startsWith('PStringBase') || type === '__unnamed') continue;
    // Pointers are only useful when they resolve to a string literal.
    if (type.trimEnd().endsWith('*') && !value.includes('-> "')) continue;
    // A non-const scalar is runtime state (Timer::cur_time starts at 0 and
    // ticks); its initial value would mislead. Non-const tables/structs stay.
    if (!type.startsWith('const') && SCALAR_TYPE.test(type)) continue;
    // One- and two-letter names (an enum's `N`) collide with locals/fields.
    if (!name.includes('::') && name.length < 3) continue;
    let text = init === 'dyninit' ? `dyninit ${value}` : value;
    if (text.length > MAX_VALUE_LEN) text = `${text.slice(0, MAX_VALUE_LEN - 1)}…`;
    let set = byName.get(name);
    if (!set) byName.set(name, (set = new Set()));
    set.add(text);
  }
  const table = new Map<string, string>();
  for (const [name, values] of byName) {
    const v = [...values];
    table.set(name, v.length === 1 ? v[0] : `ambiguous (${v.length} values: ${v.slice(0, 2).join(' | ')}${v.length > 2 ? ' | …' : ''})`);
  }
  return table;
}

const SCALAR_TYPE = /^(unsigned |signed )?(char|short|int|long|__int64|float|double|bool|long double)$/;

// Identifiers with optional C++ scope: Foo::bar, ::MAX_QUANTUM, x.
const IDENT = /(?:::)?[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/g;

/** Annotate one line; returns it unchanged if it references no known global. */
export function annotateLine(line: string, table: Map<string, string>): string {
  if (line.includes(ANNOTATION_MARKER)) return line;
  // Skip Ghidra's own comment/banner lines and function signatures' names.
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return line;
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const m of line.matchAll(IDENT)) {
    // `this->N` / `obj.N` are members, not the global of the same name.
    const before = line.slice(Math.max(0, m.index! - 2), m.index!);
    if (before.endsWith('.') || before === '->') continue;
    const name = m[0].startsWith('::') ? m[0].slice(2) : m[0];
    if (seen.has(name)) continue;
    seen.add(name);
    const v = table.get(name);
    if (v !== undefined) hits.push(`${name}: ${v}`);
  }
  return hits.length ? `${line}${ANNOTATION_MARKER}${hits.join('; ')}` : line;
}

export function annotateSource(src: string, table: Map<string, string>): { text: string; annotatedLines: number } {
  let annotatedLines = 0;
  const out = src.split('\n').map((l) => {
    const a = annotateLine(l, table);
    if (a !== l) annotatedLines++;
    return a;
  });
  return { text: out.join('\n'), annotatedLines };
}
