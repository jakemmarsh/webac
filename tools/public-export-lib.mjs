/**
 * RELEASE.open-source-repo — what goes into the public mirror and what never
 * does. tools/public-export.mjs applies these rules to a git ref; this module
 * holds them as pure functions so tests/verify-public-export.ts can check them.
 *
 * This repository stays private and stays the only place work happens. The
 * public repository is generated output: each sync exports the tracked tree,
 * keeps only allowlisted paths, then scans what is left. The scan fails the
 * export (nothing is written to the public clone) when shipped code carries
 * decompiled retail code, a secret, a retail binary or an image that is not
 * on the allowlist. Test files are the one place a hit drops the file
 * instead: a test that quotes decompiled lines is pinning the private
 * reference, which a public checkout never has, so it is left out and listed
 * in the report.
 */

/** Top-level files and directories copied when nothing below excludes them. */
export const PUBLIC_ROOTS = [
  'packages/', 'services/', 'tests/', 'tools/', 'deploy/', '.github/',
  'LICENSE', 'README.md', 'NOTICE.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts',
  '.gitignore', '.dockerignore', '.mcp.json',
  // The two verification files tests read (the same two CI checks out).
  'verification/texture-index.json', 'verification/scorecard.json',
];

/**
 * Public docs. Everything else under docs/ is internal working notes: audit
 * logs, sweep reports that quote the decomp, ops notes, release planning.
 */
export const PUBLIC_DOCS = [
  'docs/architecture.md', 'docs/dat-parser.md', 'docs/renderer.md', 'docs/dat-streaming.md',
  'docs/gdle-compat.md', 'docs/operators.md', 'docs/agent-play.md', 'docs/automation-and-plugins.md',
  'docs/vtank-formats.md', 'docs/performance-budgets.md', 'docs/ac1999-support.md',
  'docs/ac1999-support-scope.md', 'docs/dark-majesty-support.md', 'docs/era-determination.md',
  'docs/roadmap-era-variants.md', 'docs/upstream-ace-pin.json', 'docs/mockups/',
];

/** Never published, even under a public root. */
export const EXCLUDED = [
  // Tools that drive or host the private retail client, or build the decomp.
  'tools/launch-retail-client-mac.sh', 'tools/retail-client-udp-relay.mjs', 'tools/capture-retail-',
  'tools/annotate-decomp-globals.ts', 'tools/extract-pdb-globals.ts',
  // Our own harness: tools/hooks/ are Claude-harness hooks (.claude/ stays private).
  'tools/hooks/',
];

/**
 * Files published under another path. The sync workflow runs only in the
 * public repository, so the private one keeps it outside .github/workflows/.
 */
export const RENAMES = {
  'deploy/public-repo/public-sync.yml': '.github/workflows/public-sync.yml',
};

/** The path a published file takes in the public tree. */
export function publicPathFor(path) {
  return RENAMES[path] ?? path;
}

/** True when `path` (repo-relative, forward slashes) is copied to the public tree. */
export function isPublicPath(path) {
  if (EXCLUDED.some((p) => path === p || path.startsWith(p))) return false;
  const under = (list) => list.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
  return under(PUBLIC_ROOTS) || under(PUBLIC_DOCS);
}

/**
 * Ghidra's output idioms. STRONG ones only appear in pasted decompiler
 * output, so a hit anywhere means decompiled code was copied in. WEAK ones
 * (argument and local names) also appear in prose citations such as
 * "`AutoWear @ 005601c0` with param_3 = 0", which name an argument without
 * copying code; they only count in a test file that reads the private
 * decomp, where they are quoted decompiled lines.
 */
export const DECOMP_STRONG = [
  /\bundefined[1248]\b/, /\bFUN_[0-9a-fA-F]{6,}\b/, /\(\*\(code \*\)/, /\bDAT_00[0-9a-fA-F]{6}\b/,
  /\bextraout_[A-Z]/, /\bunaff_[A-Za-z]/, /\bin_stack_[0-9a-f]/, /\bthis_0\d\b/, /\bCONCAT\d\d\(/,
  /this->_paddin[g]_/, // (written so this file does not match itself)
];
export const DECOMP_WEAK = [/\b_ftol2\(/, /\b[a-z]{1,3}Var\d+\b/, /\bparam_\d+\b/, /\blocal_[0-9a-f]{2,}\b/, /\bLAB_00[0-9a-fA-F]{6}\b/];

/** Credentials and keys. A placeholder or the local-only test account never matches. */
export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/, /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  // A quoted value of 20+ characters with a digit, assigned to a secret-shaped name.
  /\b(?:secret|password|passwd|api[_-]?key|auth[_-]?token|access[_-]?token)\b["']?\s*[:=]\s*["'](?=[^"']*\d)[A-Za-z0-9+/_\-]{20,}["']/i,
];

/** Binary types that must never be published (retail executables, debug symbols, DATs, captures). */
export const FORBIDDEN_EXTENSIONS = /\.(exe|dll|pdb|dat|iso|zip|7z|webm|mp4|avi|wav|ogg|mp3)$/i;

/** Images allowed in the public tree; any other image fails the export. */
export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|tga|ico)$/i;
// GoArrow's arrow, close box and glyph are MIT (Ben Howell 2007, Xanius 2018; LICENSE.txt beside them, NOTICE.md).
export const ALLOWED_IMAGES = ['docs/mockups/', 'deploy/web/', 'packages/renderer/src/ui/goarrow/arrows/'];

/** Line hits of `patterns` in `text`: [{ line, text }]. */
export function scanText(text, patterns) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((re) => re.test(lines[i]))) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 160) });
  }
  return hits;
}

/**
 * Decide one public-path file. Returns { action: 'keep' | 'drop' | 'fail', reason?, hits? }.
 * `text` is null for a binary file.
 */
export function classifyFile(path, text) {
  if (FORBIDDEN_EXTENSIONS.test(path)) return { action: 'fail', reason: 'forbidden binary type' };
  if (IMAGE_EXTENSIONS.test(path)) {
    return ALLOWED_IMAGES.some((p) => path.startsWith(p)) ? { action: 'keep' } : { action: 'fail', reason: 'image not on the allowlist' };
  }
  if (text === null) return { action: 'keep' };
  const secrets = scanText(text, SECRET_PATTERNS);
  if (secrets.length) return { action: 'fail', reason: 'possible secret', hits: secrets };
  const isTest = path.startsWith('tests/') && !path.startsWith('tests/_harness/');
  const strong = scanText(text, DECOMP_STRONG);
  const weak = isTest && text.includes('client-eol') ? scanText(text, DECOMP_WEAK) : [];
  if (strong.length || weak.length) {
    // Test files that pin the private decomp are dropped; the harness never is
    // (other tests import it, so dropping it would break them).
    if (isTest) return { action: 'drop', reason: 'quotes decompiled retail code', hits: [...strong, ...weak] };
    return { action: 'fail', reason: 'decompiled retail code', hits: strong };
  }
  return { action: 'keep' };
}

/**
 * Private files a test can exercise: tools and images that stay private.
 * A test that names one (runs the hook, imports the relay, reads the
 * screenshot) cannot pass in the public tree, so it is left out like a
 * decomp-quoting test. Mentions of private docs don't count: tests cite
 * those in comments without reading them, and neither do comment lines.
 */
export function privateExecutables(trackedPaths) {
  return trackedPaths.filter((p) => !isPublicPath(p) && /^(tools\/|docs\/images\/)/.test(p));
}

/** The first private file `text` names, or null. */
export function namesPrivateFile(text, privatePaths) {
  const code = text.split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
  return privatePaths.find((p) => code.includes(p)) ?? null;
}

/** True when the bytes look binary (a NUL in the first 8 KB). */
export function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
