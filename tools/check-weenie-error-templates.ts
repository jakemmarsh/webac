/**
 * check-weenie-error-templates — verify every WEENIE_ERROR_WITH_STRING_TEXT
 * template against the retail client's own literals (RECON.weenie-error-templates).
 *
 *   npx tsx tools/check-weenie-error-templates.ts [--json out.json]
 *
 * Retail renders 0x028B WeenieErrorWithString through
 * ClientCommunicationSystem::HandleFailureEvent @ 00571990 (docs/retail-client-symbols.md,
 * "Server failure codes"). Ghidra's decomp of that switch drops most sprintf
 * format arguments, so this reads the binary instead: it disassembles the
 * function with objdump, walks the compare/jump-table dispatch for each code
 * to its arm, and collects the UTF-16 .rdata literals the arm pushes before
 * AddTextToScroll (0x563c50), plus the text type pushed with it. An arm with
 * one "%s" literal is a sprintf template; one literal without "%s" is
 * value + literal; no literal is the value passed through. Templates are
 * compared with the trailing "\n" dropped (the chat sink owns the line break).
 *
 * Needs reference/client-eol/acclient.exe (provision-remote-env.sh) and
 * GNU binutils objdump (`objdump`, or Homebrew's `gobjdump` on macOS, where
 * `objdump` is LLVM's). Exit 1 when any template differs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findGnuObjdump } from './lib/gnu-objdump.ts';
import { WEENIE_ERROR_WITH_STRING_TEXT } from '../packages/shared/src/combat/WeenieErrorWithStringText.ts';

const EXE = resolve(import.meta.dirname, '../reference/client-eol/acclient.exe');
const FN_START = 0x571990, FN_END = 0x575500;
const DISPATCH = 0x571a03;       // first `cmp edi, code` after the prologue
const DEFAULT_ARM = 0x57544a;    // switch default: prints nothing
const ADD_TEXT_TO_SCROLL = 0x563c50;
const RDATA = { va: 0x792000, off: 0x392000, end: 0x8093a6 };
const TEXT = { va: 0x401000, off: 0x1000 };

const exe = readFileSync(EXE);
const fileOff = (va: number) => (va >= RDATA.va ? va - RDATA.va + RDATA.off : va - TEXT.va + TEXT.off);
const u8 = (va: number) => exe[fileOff(va)];
const u32 = (va: number) => exe.readUInt32LE(fileOff(va));
function wstr(va: number): string {
  let off = fileOff(va), s = '';
  for (let c = exe.readUInt16LE(off); c !== 0 && s.length < 600; off += 2, c = exe.readUInt16LE(off)) s += String.fromCharCode(c);
  return s;
}

const OBJDUMP = findGnuObjdump();
if (!OBJDUMP) throw new Error('needs GNU binutils objdump (objdump or gobjdump); LLVM objdump output is not parseable here');
const asm = execFileSync(OBJDUMP, ['-d', '-M', 'intel', `--start-address=0x${FN_START.toString(16)}`, `--stop-address=0x${FN_END.toString(16)}`, EXE], { encoding: 'utf8', maxBuffer: 64 << 20 });
const ins = new Map<number, { op: string; arg: string; next: number }>();
let prev: number | undefined;
/**
 * GNU objdump (Linux, the cloud) prints `edi,0x4e8` and `DWORD PTR [eax*4+0x…]`;
 * macOS's objdump is llvm-objdump: `edi, 0x4e8`, `dword ptr [eax*4 + 0x…]` and
 * a `<.text+0x…>` label after branch targets, and `[4*eax + …]` for
 * `[eax*4+…]`. Normalize to the GNU spelling.
 */
const gnuOperands = (arg: string) => arg
  .replace(/\s*<[^>]*>\s*$/, '')
  .replace(/\b(dword|word|byte) ptr\b/gi, (_m, w: string) => `${w.toUpperCase()} PTR`)
  .replace(/\s*([,+*-])\s*/g, '$1')
  .replace(/\[(\d)\*(\w+)/g, '[$2*$1')
  .trim();
for (const line of asm.split('\n')) {
  const m = /^\s*([0-9a-f]+):\s+(?:[0-9a-f]{2} )+\s*\t(\S+)\s*(.*)$/.exec(line);
  if (!m) continue;
  const a = parseInt(m[1], 16);
  ins.set(a, { op: m[2], arg: gnuOperands(m[3]), next: 0 });
  if (prev !== undefined) ins.get(prev)!.next = a;
  prev = a;
}
if (!ins.has(DISPATCH)) throw new Error(`${OBJDUMP} output has no instruction at 0x${DISPATCH.toString(16)}; cannot walk the dispatch`);
const num = (s: string) => (s.startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10));

/** Follow the compare chains and byte-indexed jump tables to the arm for `code`. */
function dispatch(code: number): number {
  const reg: Record<string, number> = { edi: code };
  let pc = DISPATCH, flags: [number, number] = [0, 0];
  for (let i = 0; i < 200; i++) {
    const { op, arg, next } = ins.get(pc)!;
    let m: RegExpExecArray | null;
    if (op === 'cmp') { const [r, v] = arg.split(','); flags = [reg[r], num(v)]; pc = next; continue; }
    if (/^j(a|b|e|ne|be|ae|mp)$/.test(op) && arg.startsWith('0x')) {
      const [a, b] = flags;
      const take = { ja: a > b, jb: a < b, je: a === b, jne: a !== b, jbe: a <= b, jae: a >= b, jmp: true }[op]!;
      pc = take ? parseInt(arg, 16) : next; continue;
    }
    if (op === 'lea' && (m = /^(\w+),\[edi([+-]0x[0-9a-f]+)\]$/.exec(arg))) { reg[m[1]] = (code + parseInt(m[2], 16)) >>> 0; pc = next; continue; }
    if (op === 'movzx' && (m = /^(\w+),BYTE PTR \[(\w+)\+0x([0-9a-f]+)\]$/.exec(arg))) { reg[m[1]] = u8(reg[m[2]] + parseInt(m[3], 16)); pc = next; continue; }
    if (op === 'jmp' && (m = /^DWORD PTR \[(\w+)\*4\+0x([0-9a-f]+)\]$/.exec(arg))) { pc = u32(reg[m[1]] * 4 + parseInt(m[2], 16)); continue; }
    return pc;
  }
  throw new Error(`dispatch for 0x${code.toString(16)} did not settle`);
}

/** Walk an arm to its AddTextToScroll, collecting the .rdata literals it pushes. */
function arm(start: number): { literals: string[]; textType: number | null } {
  const literals: string[] = [], pushes: Array<number | string> = [], seen = new Set<number>();
  let pc = start;
  for (let i = 0; i < 400 && !seen.has(pc) && ins.has(pc); i++) {
    seen.add(pc);
    const { op, arg, next } = ins.get(pc)!;
    if (op === 'push') {
      if (/^(0x)?[0-9a-f]+$/.test(arg)) {
        const v = num(arg);
        if (v >= RDATA.va && v < RDATA.end) literals.push(wstr(v));
        pushes.push(v);
      } else pushes.push(arg);
    }
    if (op === 'call' && arg === `0x${ADD_TEXT_TO_SCROLL.toString(16)}`) {
      const t = pushes.at(-2);
      return { literals, textType: typeof t === 'number' ? t : null };
    }
    if (op === 'jmp' && arg.startsWith('0x')) { pc = parseInt(arg, 16); if (pc === DEFAULT_ARM) break; continue; }
    if (op.startsWith('ret')) break;
    pc = next;
  }
  return { literals, textType: null };
}

/** Retail's line for a code in our `_` notation (null = no arm, prints nothing). */
export function retailTemplate(code: number): { template: string; textType: number | null } | null {
  const a = dispatch(code);
  if (a === DEFAULT_ARM) return null;
  const { literals, textType } = arm(a);
  // A literal that merely names a fallback value (0x4bf pushes L"item") is not the line.
  const lines = literals.filter((s) => s !== 'item');
  let template: string;
  if (lines.length === 0) template = '_';
  else if (lines.length === 1) template = lines[0].includes('%s') ? lines[0].replace(/%s/g, '_') : `_${lines[0]}`;
  else template = lines.join(' | ');
  return { template: template.replace(/\n$/, ''), textType };
}

// Arms built by concatenation that the single-literal rule above cannot express;
// each is checked by hand against the decomp (acclient-decompiled.annotated.c).
const CONCAT_ARMS: Record<number, string> = {
  0x04F8: '_ fails to affect you because you are not the same sort of player killer as _!', // value + lit + value + "!\n"
  0x0518: 'This fellowship is locked; _ cannot be recruited into the fellowship.', // lit + value + lit
  0x0528: 'The fellowship is locked; you cannot open locked fellowships.', // fixed text, value unused
  0x053B: 'Banned Characters: _', // three AddTextToScroll calls: lit, value, "\n"
};

const rows: Array<{ code: string; ours: string; retail: string | null; textType: number | null; ok: boolean }> = [];
for (const [k, ours] of Object.entries(WEENIE_ERROR_WITH_STRING_TEXT)) {
  const code = Number(k);
  const r = retailTemplate(code);
  const retail = CONCAT_ARMS[code] ?? r?.template ?? null;
  rows.push({ code: `0x${code.toString(16).padStart(4, '0')}`, ours, retail, textType: r?.textType ?? null, ok: retail === ours });
}
const bad = rows.filter((r) => !r.ok);
for (const r of bad) console.log(`${r.code} DIFFERS\n  ours   ${JSON.stringify(r.ours)}\n  retail ${JSON.stringify(r.retail)}`);
console.log(`check-weenie-error-templates: ${rows.length - bad.length}/${rows.length} templates match retail HandleFailureEvent @ 00571990`);
const j = process.argv.indexOf('--json');
if (j > -1) writeFileSync(process.argv[j + 1], JSON.stringify(rows, null, 1) + '\n');
process.exit(bad.length ? 1 : 0);
