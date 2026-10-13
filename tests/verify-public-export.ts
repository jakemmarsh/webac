/**
 * RELEASE.open-source-repo — the public mirror's rules
 * (tools/public-export-lib.mjs) and the export of HEAD
 * (tools/public-export.mjs). The last test keeps every commit publishable:
 * a pasted decompiled line or a secret in shipped code fails it here,
 * before a sync would refuse to publish.
 *
 * Decompiler idioms in the samples are built by concatenation so this file
 * does not itself match the scanner and stays in the public tree.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { classifyFile, isPublicPath, looksBinary, namesPrivateFile, privateExecutables, publicPathFor, scanText, DECOMP_STRONG } from '../tools/public-export-lib.mjs';
import { buildExport } from '../tools/public-export.mjs';

const U4 = 'undefined' + '4';
const EXTRA = 'extraout' + '_EAX';
const PARAM = 'param' + '_3';
// Private paths, split so this file never names one in code (tests that do are left out of the mirror).
const HOOK = 'tools/hooks/' + 'pre-commit-check.sh';
const SHOT = 'docs/images/retail-' + 'client-wine-charselect.png';

describe('isPublicPath', () => {
  it('publishes the code, tests, tools and public docs', () => {
    for (const p of ['packages/renderer/src/main.ts', 'services/ws-tcp-bridge/src/server.ts', 'tests/verify-x.ts',
      'tools/task-status.mjs', 'LICENSE', 'README.md', 'package.json', '.github/workflows/ci.yml',
      'docs/architecture.md', 'docs/mockups/automation/index.html',
      'verification/texture-index.json', 'verification/scorecard.json']) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('keeps retail evidence, internal notes and our own ops private', () => {
    for (const p of ['verification/sidebyside/inv.png', 'verification/perf/run.json', SHOT,
      'docs/remote-agent-ops.md', 'docs/progress-archive/2026-09.md', 'docs/retail-client-symbols.md', 'docs/release-plan.md',
      'CLAUDE.md', 'GOAL.md', 'progress.md', 'tasks.json', '.claude/settings.json',
      'tools/capture-' + 'retail-ab.ts', 'tools/launch-' + 'retail-client-mac.sh', 'tools/deploy-' + 'railway.sh', HOOK,
      'reference/client-' + 'eol/acclient.exe', 'dat/client_portal.dat']) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});

describe('publicPathFor', () => {
  it('places the sync workflow under .github/workflows/ only in the public tree', () => {
    expect(isPublicPath('deploy/public-repo/public-sync.yml')).toBe(true);
    expect(publicPathFor('deploy/public-repo/public-sync.yml')).toBe('.github/workflows/public-sync.yml');
    expect(publicPathFor('packages/renderer/src/main.ts')).toBe('packages/renderer/src/main.ts');
  });
});

describe('classifyFile', () => {
  it('fails shipped code that carries a pasted decompiled line', () => {
    const v = classifyFile('packages/renderer/src/x.ts', `// ${U4} uVar1 = ${'FUN' + '_00401000'}(${PARAM});`);
    expect(v.action).toBe('fail');
    expect(v.hits?.[0].line).toBe(1);
  });

  it('allows a prose citation of an argument name in shipped code', () => {
    expect(classifyFile('packages/renderer/src/x.ts', `/** AutoWear @ 005601c0 with ${PARAM} = 0. */`).action).toBe('keep');
  });

  it('drops a test that quotes decompiled lines instead of failing the export', () => {
    expect(classifyFile('tests/verify-x.ts', `expect(body).toContain('SetText(this->m_p,${EXTRA});');`).action).toBe('drop');
    // A weak idiom only counts when the test reads the private decomp.
    const quoting = `const D = 'reference/client-${'eol'}/decomp/a.c'; expect(b).toMatch(/${PARAM} == 0/);`;
    expect(classifyFile('tests/verify-x.ts', quoting).action).toBe('drop');
    expect(classifyFile('tests/verify-x.ts', `// cited: ${PARAM} = 0`).action).toBe('keep');
  });

  it('never drops the shared test harness (other tests import it)', () => {
    expect(classifyFile('tests/_harness/x.ts', `// ${EXTRA}`).action).toBe('fail');
  });

  it('fails secrets but not string-table tokens', () => {
    expect(classifyFile('tools/x.ts', `const apiKey = '${'sk-ant-' + 'a'.repeat(30)}';`).action).toBe('fail');
    expect(classifyFile('tools/x.ts', `password: "${'Abc123'.repeat(4)}"`).action).toBe('fail');
    expect(classifyFile('tools/x.ts', 'const key = "-----BEGIN RSA ' + 'PRIVATE KEY-----";').action).toBe('fail');
    expect(classifyFile('packages/x.ts', "{ token: 'ID_CharGen_GearText_HairButton', table: 0x23000002 }").action).toBe('keep');
    expect(classifyFile('tests/x.ts', "password: 'testacjs'").action).toBe('keep');
  });

  it('fails retail binaries and unlisted images', () => {
    expect(classifyFile('tools/acclient.exe', null).action).toBe('fail');
    expect(classifyFile('packages/renderer/public/client_portal.dat', null).action).toBe('fail');
    expect(classifyFile('packages/renderer/src/shot.png', null).action).toBe('fail');
    expect(classifyFile('docs/mockups/automation/a.png', null).action).toBe('keep');
    // GoArrow's MIT arrow art ships (its licence beside it).
    expect(classifyFile('packages/renderer/src/ui/goarrow/arrows/chrome.png', null).action).toBe('keep');
  });
});

describe('tests that exercise private files', () => {
  const tracked = [HOOK, 'tools/task-status.mjs', SHOT,
    'docs/remote-agent-ops.md', 'packages/renderer/src/main.ts'];

  it('collects only private tools and images', () => {
    expect(privateExecutables(tracked)).toEqual([HOOK, SHOT]);
  });

  it('counts a private file named in code, not in a comment', () => {
    const priv = privateExecutables(tracked);
    expect(namesPrivateFile(`const P = '${HOOK}';`, priv)).toBe(HOOK);
    expect(namesPrivateFile(` * compared with ${SHOT}`, priv)).toBeNull();
    expect(namesPrivateFile(`// see ${HOOK}`, priv)).toBeNull();
  });
});

describe('helpers', () => {
  it('scanText reports 1-based lines', () => {
    expect(scanText(`a\nb ${U4}\nc`, DECOMP_STRONG)).toEqual([{ line: 2, text: `b ${U4}` }]);
  });
  it('looksBinary finds a NUL', () => {
    expect(looksBinary(Buffer.from([1, 2, 0, 3]))).toBe(true);
    expect(looksBinary(Buffer.from('text'))).toBe(false);
  });
});

let inRepo = false;
try { execFileSync('git', ['rev-parse', 'HEAD'], { stdio: 'ignore' }); inRepo = true; } catch { /* not a git checkout */ }

describe.skipIf(!inRepo)('export of HEAD', () => {
  it('is publishable: no pasted decomp, secrets, retail binaries or unlisted images in shipped files', () => {
    const r = buildExport('HEAD');
    expect(r.failures.map((f) => `${f.path}: ${f.reason}`)).toEqual([]);
    const paths = new Set(r.files.map((f) => f.path));
    expect(paths.has('packages/renderer/src/main.ts')).toBe(true);
    expect(paths.has('LICENSE')).toBe(true);
    expect(paths.has('.github/workflows/public-sync.yml')).toBe(true);
    expect(paths.has('deploy/public-repo/public-sync.yml')).toBe(false);
    expect([...paths].some((p) => p.startsWith('verification/sidebyside/') || p === 'CLAUDE.md')).toBe(false);
  });
});
