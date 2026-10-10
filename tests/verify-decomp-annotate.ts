/**
 * tools/decomp-annotate-lib.ts — inlining globals.tsv values into the
 * decompiled client (acclient-decompiled.annotated.c). Drives the real table
 * builder and line annotator with globals.tsv-shaped input, so it runs
 * everywhere (no reference/ needed).
 */
import { describe, it, expect } from 'vitest';
import { ANNOTATION_MARKER, annotateLine, annotateSource, buildAnnotationTable } from '../tools/decomp-annotate-lib';
import { TSV_HEADER } from '../tools/pdb-globals-lib';

const row = (name: string, type: string, init: string, value: string, kind = 'ldata') =>
  [name, kind, type, '0x800000', '.data', init, value, '1'].join('\t');

const TSV = [
  TSV_HEADER,
  row('MAX_QUANTUM', 'const double', 'dyninit', '$E116: ___real_3ff0000000000000 / MIN_FRAMERATE'),
  row('ATTACK_POWERUP_TIME', 'const double', 'static', '1'),
  row('Timer::cur_time', 'double', 'static', '0', 'gdata'),
  row('Render_Choices', 'unsigned long[4]', 'static', '[1, 2, 4, 8]'),
  row('INVALID_TIME', 'const double', 'bss', ''),
  row('$S100', '<function> *', 'static', '0x6e9b50'),
  row('g_pHandler', 'Handler *', 'static', '0x7ca010'),
  row('s_title', 'const char *', 'static', '0x7ca010 -> "Asheron\'s Call"'),
  row('N', 'QTIsaac::__unnamed', 'const', 'N (256)', 'const'),
  row('SPLIT', 'const float', 'static', '0.5'),
  row('SPLIT', 'const float', 'static', '0.25'),
].join('\n');

describe('buildAnnotationTable', () => {
  const t = buildAnnotationTable(TSV);
  it('keeps consts, dyninit consts, non-const tables and string pointers', () => {
    expect(t.get('ATTACK_POWERUP_TIME')).toBe('1');
    expect(t.get('MAX_QUANTUM')).toBe('dyninit $E116: ___real_3ff0000000000000 / MIN_FRAMERATE');
    expect(t.get('Render_Choices')).toBe('[1, 2, 4, 8]');
    expect(t.get('s_title')).toBe('0x7ca010 -> "Asheron\'s Call"');
  });
  it('drops runtime scalars, bss, compiler temporaries, bare pointers and 1-2 letter names', () => {
    for (const n of ['Timer::cur_time', 'INVALID_TIME', '$S100', 'g_pHandler', 'N']) expect(t.has(n)).toBe(false);
  });
  it('reports a name whose copies disagree as ambiguous rather than picking one', () => {
    expect(t.get('SPLIT')).toMatch(/^ambiguous \(2 values: 0\.5 \| 0\.25\)$/);
  });
});

describe('annotateLine / annotateSource', () => {
  const t = buildAnnotationTable(TSV);
  it('appends every referenced global once, including ::-scoped references', () => {
    const line = '  x = ::MAX_QUANTUM + ATTACK_POWERUP_TIME * ::MAX_QUANTUM;';
    expect(annotateLine(line, t)).toBe(
      `${line}${ANNOTATION_MARKER}MAX_QUANTUM: dyninit $E116: ___real_3ff0000000000000 / MIN_FRAMERATE; ATTACK_POWERUP_TIME: 1`,
    );
  });
  it('ignores member accesses that share a global\'s name, and comment lines', () => {
    const t2 = new Map([['SPEED', '4']]);
    expect(annotateLine('  a = this->SPEED + b.SPEED;', t2)).toBe('  a = this->SPEED + b.SPEED;');
    expect(annotateLine('// ===== Foo::SPEED @ 00401000 =====', t2)).toBe('// ===== Foo::SPEED @ 00401000 =====');
    expect(annotateLine('  a = SPEED;', t2)).toBe(`  a = SPEED;${ANNOTATION_MARKER}SPEED: 4`);
  });
  it('keeps the line count (citations stay valid) and is idempotent', () => {
    const src = 'void f() {\n  y = ATTACK_POWERUP_TIME;\n  z = 1;\n}';
    const once = annotateSource(src, t);
    expect(once.annotatedLines).toBe(1);
    expect(once.text.split('\n')).toHaveLength(4);
    const twice = annotateSource(once.text, t);
    expect(twice.text).toBe(once.text);
    expect(twice.annotatedLines).toBe(0);
  });
});
