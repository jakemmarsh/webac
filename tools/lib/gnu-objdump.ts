/**
 * Locate a GNU binutils objdump. The disassembly parsers in tools/ read GNU's
 * Intel syntax (`DWORD PTR [eax*4+0x…]`, tab-separated columns); macOS ships
 * LLVM's objdump under the same name, whose output they cannot read. Homebrew's
 * binutils installs GNU's as `gobjdump`.
 */
import { execFileSync } from 'node:child_process';

export const GNU_OBJDUMP_CANDIDATES = ['objdump', 'gobjdump'] as const;

export function findGnuObjdump(candidates: readonly string[] = GNU_OBJDUMP_CANDIDATES): string | undefined {
  for (const bin of candidates) {
    try {
      const v = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (/^GNU objdump/m.test(v)) return bin;
    } catch { /* not installed */ }
  }
  return undefined;
}
