/**
 * FAITHFUL.476 — no orphan imports in GameUI.ts / main.ts.
 *
 *  Extending the FAITHFUL.468-475 orphan audit to unused imports: the
 *  original finding dropped `ATTRIBUTE_MAX` from GameUI.ts and the
 *  `SpellBase` type import from main.ts. The invariant is "every imported
 *  name is referenced in the file" — checked here by parsing the real
 *  sources with the TypeScript compiler and walking the AST (2026-09-15:
 *  converted from a source-text pin that named ATTRIBUTE_MAX and a
 *  citation comment; CORE.17.k.b.b.a.f moved the slider mapping into
 *  ui/ChargenAttributeSliders.ts, so the name is legitimately gone again).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const REPO = resolve(__dirname, '..');
const FILES = {
  GameUI: resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'),
  main: resolve(REPO, 'packages/renderer/src/main.ts'),
};

interface ImportedName { local: string; from: string; typeOnly: boolean }

/** Every local name an import declaration binds (default, namespace, named — value or type). */
function importedNames(sf: ts.SourceFile): ImportedName[] {
  const out: ImportedName[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const from = (stmt.moduleSpecifier as ts.StringLiteral).text;
    const clause = stmt.importClause;
    if (clause.name) out.push({ local: clause.name.text, from, typeOnly: clause.isTypeOnly });
    const b = clause.namedBindings;
    if (b && ts.isNamespaceImport(b)) out.push({ local: b.name.text, from, typeOnly: clause.isTypeOnly });
    if (b && ts.isNamedImports(b)) {
      for (const el of b.elements) out.push({ local: el.name.text, from, typeOnly: clause.isTypeOnly || el.isTypeOnly });
    }
  }
  return out;
}

/** Identifier references outside import declarations (value AND type positions — a type-only import is used by a type reference). */
function referencedIdentifiers(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      // A property name after a dot (`a.b`) or a property key in an object
      // literal is not a reference to a binding named `b`.
      const p = node.parent;
      const isPropertyName = (ts.isPropertyAccessExpression(p) && p.name === node)
        || (ts.isPropertyAssignment(p) && p.name === node)
        || (ts.isPropertySignature(p) && p.name === node)
        || (ts.isPropertyDeclaration(p) && p.name === node)
        || (ts.isMethodDeclaration(p) && p.name === node)
        || (ts.isQualifiedName(p) && p.right === node);
      if (!isPropertyName) names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return names;
}

function unusedImports(path: string): ImportedName[] {
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const used = referencedIdentifiers(sf);
  return importedNames(sf).filter((n) => !used.has(n.local));
}

describe('FAITHFUL.476 — every import in GameUI.ts is referenced', () => {
  it('no orphan value or type import', () => {
    const orphans = unusedImports(FILES.GameUI);
    expect(orphans.map((o) => `${o.local} from ${o.from}`)).toEqual([]);
  });

  it('the shared attribute constants GameUI still uses are imported (DEFAULT_ATTRIBUTE_CREDITS); ATTRIBUTE_MAX lives in ui/ChargenAttributeSliders.ts and the Custom row\'s reset is ApplyTemplate (ui/ChargenTemplates.ts) now, so ATTRIBUTE_MIN is not imported either', () => {
    const sf = ts.createSourceFile(FILES.GameUI, readFileSync(FILES.GameUI, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const shared = importedNames(sf).filter((n) => n.from === '@ac/shared').map((n) => n.local);
    expect(shared).not.toContain('ATTRIBUTE_MIN');
    expect(shared).toContain('DEFAULT_ATTRIBUTE_CREDITS');
    expect(shared).not.toContain('ATTRIBUTE_MAX');
    const sliders = importedNames(sf).filter((n) => n.from === './ChargenAttributeSliders.js').map((n) => n.local);
    expect(sliders).toContain('sliderWidgetX');
    expect(sliders).toContain('sliderPositionForValue');
  });
});

describe('FAITHFUL.476 — every import in main.ts is referenced', () => {
  it('no orphan value or type import (the SpellBase type import stays gone)', () => {
    const orphans = unusedImports(FILES.main);
    expect(orphans.map((o) => `${o.local} from ${o.from}`)).toEqual([]);
    const sf = ts.createSourceFile(FILES.main, readFileSync(FILES.main, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    expect(importedNames(sf).some((n) => n.local === 'SpellBase')).toBe(false);
  });
});

describe('FAITHFUL.476 — the checker itself', () => {
  it('flags an unused named import, an unused type import and an unused namespace import; a name used only in a type position counts as used', () => {
    const src = `import { used, orphan } from './a.js';\nimport type { T, U } from './b.js';\nimport * as ns from './c.js';\nimport dflt from './d.js';\nconst x: T = used(1);\nconst o = { orphan: 1, dflt: 2 };\nexport { x, o };\n`;
    const sf = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const usedNames = referencedIdentifiers(sf);
    const orphans = importedNames(sf).filter((n) => !usedNames.has(n.local)).map((n) => n.local);
    expect(orphans.sort()).toEqual(['U', 'dflt', 'ns', 'orphan']);
  });
});
