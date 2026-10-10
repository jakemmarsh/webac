/**
 * CORE.17.k.c — extract the retail client's per-error-code TEXT SINK for the
 * server's WeenieError / WeenieErrorWithString codes.
 *
 * The decompiled EoL client (reference/client-eol/decomp/acclient-decompiled.c)
 * routes both 0xF7B0:0x028A WeenieError and 0x028B WeenieErrorWithString
 * (and a non-zero UseDone code — ClientUISystem::Handle_Item__UseDone) through
 * `ClientCommunicationSystem::HandleFailureEvent @ 00571990`, one switch over
 * the code where every arm ends in `ClientSystem::AddTextToScroll(this, text,
 * TYPE, true, 0)` with an explicit text type:
 *   0x1a  the spew box over the 3D view (gmSpewBoxUI; a chat window shows it
 *         only with Chat Options > Errors ticked)
 *   0     a plain chat line (retail's type-0 literals carry a trailing "\n")
 *   7     a chat line of text type 7 (ChatMessageType.Magic — light blue)
 * A code with no arm (the switch default) prints NOTHING; 0x4b8–0x4ba call
 * CM_Character::SendNotice_AbuseReportResponse instead of any text.
 *
 * The walk follows Ghidra's control flow: a `case 0xNNN:` / `if (param_1 ==
 * 0xNNN)` start, forward through `goto LAB_*` jumps (shared arms), `break`
 * (continue after the enclosing switch — the nested switches fall into the
 * shared sprintf arms), until the first AddTextToScroll or the exit label.
 *
 * Run: `npx tsx tools/generate-weenie-error-sinks.ts`
 * Output: packages/shared/src/combat/WeenieErrorSink.ts (rewritten in place).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
export const DECOMP_PATH = resolve(REPO, 'reference/client-eol/decomp/acclient-decompiled.c');
const OUT_PATH = resolve(REPO, 'packages/shared/src/combat/WeenieErrorSink.ts');

export const FUNCTION_HEADER = '// ===== ClientCommunicationSystem::HandleFailureEvent @ 00571990 =====';
/** The common exit label every arm ends on (`switchD_00571a5b_caseD_18:` = the default). */
export const EXIT_LABEL = 'switchD_00571a5b_caseD_18';

export interface SinkEntry {
  code: number;
  /** AddTextToScroll text type, or null when the arm prints nothing. */
  type: number | null;
  /** 1-based decomp line of the AddTextToScroll (or of the arm's end). */
  line: number;
  /** The first wide/narrow string literal met on the arm (evidence only). */
  literal: string | null;
  /** A non-text notice the arm raises instead (SendNotice_*). */
  notice: string | null;
}

/** Slice the function body out of the decomp: [startLine, endLine) 1-based. */
export function functionBounds(lines: readonly string[]): { start: number; end: number } {
  const start = lines.findIndex((l) => l.startsWith(FUNCTION_HEADER));
  if (start < 0) throw new Error(`HandleFailureEvent header not found in ${DECOMP_PATH}`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('// ===== ')) end++;
  return { start: start + 1, end: end + 1 };
}

export function extractSinks(source: string): SinkEntry[] {
  const all = source.split('\n');
  const { start, end } = functionBounds(all);
  const body = all.slice(start - 1, end - 1);
  const base = start;

  // Labels, case starts, and the innermost enclosing `switch(param_1)` per line.
  const labels = new Map<string, number>();
  const starts = new Map<number, number>();
  const enclosing: Array<number | null> = new Array(body.length).fill(null);
  const switchCloseAfter = new Map<number, number>();
  const openSwitches: Array<{ idx: number; depth: number }> = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    let m = /^\s*(LAB_[0-9a-f]+|switchD_[0-9a-f]+_caseD_[0-9a-f]+):\s*$/.exec(l);
    if (m) labels.set(m[1], i);
    m = /^\s*case (0x[0-9a-f]+):/.exec(l);
    if (m && !starts.has(parseInt(m[1], 16))) starts.set(parseInt(m[1], 16), i);
    m = /if \(param_1 == (0x[0-9a-f]+)\)/.exec(l);
    if (m && !starts.has(parseInt(m[1], 16))) starts.set(parseInt(m[1], 16), i);
    if (/switch\(param_1\) \{/.test(l)) openSwitches.push({ idx: i, depth: depth + 1 });
    enclosing[i] = openSwitches.length ? openSwitches[openSwitches.length - 1].idx : null;
    depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
    while (openSwitches.length && depth < openSwitches[openSwitches.length - 1].depth) {
      switchCloseAfter.set(openSwitches.pop()!.idx, i + 1);
    }
  }

  const walk = (startIdx: number): Omit<SinkEntry, 'code'> => {
    let literal: string | null = null;
    let notice: string | null = null;
    const seen = new Set<string>();
    let j = startIdx;
    for (let steps = 0; j < body.length && steps < 400; steps++) {
      const l = body[j];
      if (literal === null) {
        const lit = /L?"((?:[^"\\]|\\.)*)"/.exec(l);
        if (lit && lit[1].length > 0) literal = lit[1];
      }
      const sn = /(SendNotice_\w+)\(/.exec(l);
      if (sn && !/AddTextToScroll/.test(l)) notice = sn[1];
      // A call split across two lines: `AddTextToScroll` then the argument line.
      const joined = /AddTextToScroll\s*$/.test(l.trimEnd()) ? l + body[j + 1] : l;
      const call = /AddTextToScroll\s*\(\(ClientSystem \*\)this,[^,]+,(0x[0-9a-f]+|\d+),/.exec(joined);
      if (call) return { type: parseInt(call[1], call[1].startsWith('0x') ? 16 : 10), line: base + j, literal, notice };
      const g = /goto (LAB_[0-9a-f]+|switchD_[0-9a-f]+_caseD_[0-9a-f]+);/.exec(l);
      if (g) {
        if (g[1] === EXIT_LABEL) return { type: null, line: base + j, literal, notice };
        if (seen.has(g[1])) throw new Error(`loop at ${base + j}`);
        seen.add(g[1]);
        j = labels.get(g[1])!;
        continue;
      }
      if (/^\s*break;/.test(l) && j !== startIdx) {
        const sw = enclosing[j];
        if (sw === null || !switchCloseAfter.has(sw)) return { type: null, line: base + j, literal, notice };
        j = switchCloseAfter.get(sw)!;
        continue;
      }
      if (/^\s*return;/.test(l)) return { type: null, line: base + j, literal, notice };
      j++;
    }
    throw new Error(`walk from ${base + startIdx} did not terminate`);
  };

  return [...starts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([code, idx]) => ({ code, ...walk(idx) }));
}

function hex4(n: number): string { return '0x' + n.toString(16).toUpperCase().padStart(4, '0'); }

export function render(entries: readonly SinkEntry[]): string {
  const out: string[] = [];
  out.push('/**');
  out.push(' * WeenieErrorSink — which text sink the retail client used for each server');
  out.push(' * WeenieError / WeenieErrorWithString code (CORE.17.k.c).');
  out.push(' *');
  out.push(' * Source of truth: the decompiled EoL client, ClientCommunicationSystem::');
  out.push(' * HandleFailureEvent @ 00571990 — the one switch both 0x028A WeenieError and');
  out.push(' * 0x028B WeenieErrorWithString (Handle_Communication__WeenieError @ 0057adf0 /');
  out.push(' * …WithString @ 0057cb90) and a non-zero UseDone code (ClientUISystem::');
  out.push(' * Handle_Item__UseDone @ 00565xxx) run through. Each arm ends in');
  out.push(' * ClientSystem::AddTextToScroll(this, text, TYPE, true, 0):');
  out.push(' *   0x1a — the spew box over the 3D view (chat windows only with Errors ticked)');
  out.push(' *   0    — a plain chat line (retail literal carries a trailing "\\n")');
  out.push(' *   7    — a chat line of text type 7 (ChatMessageType.Magic, light blue)');
  out.push(' * A code with no arm prints NOTHING (the switch default); 0x04B8–0x04BA raise');
  out.push(' * CM_Character::SendNotice_AbuseReportResponse instead of text.');
  out.push(' *');
  out.push(' * GENERATED by tools/generate-weenie-error-sinks.ts — do not hand-edit.');
  out.push(` * ${entries.length} codes; each comment carries the decomp line + the first literal on the arm.`);
  out.push(' */');
  out.push('');
  out.push('/** AddTextToScroll text type: a plain chat line. */');
  out.push('export const WEENIE_ERROR_TEXT_TYPE_CHAT = 0;');
  out.push('/** AddTextToScroll text type 7 (ChatMessageType.Magic). */');
  out.push('export const WEENIE_ERROR_TEXT_TYPE_MAGIC = 7;');
  out.push('/** AddTextToScroll text type 0x1a: the spew box. */');
  out.push('export const WEENIE_ERROR_TEXT_TYPE_SPEW = 0x1a;');
  out.push('');
  out.push('/** code → retail AddTextToScroll text type (only the codes with a text arm). */');
  out.push('export const WEENIE_ERROR_TEXT_TYPE: Readonly<Record<number, number>> = Object.freeze({');
  for (const e of entries) {
    if (e.type === null) continue;
    const lit = e.literal ? ` ${JSON.stringify(e.literal)}` : '';
    out.push(`  [${hex4(e.code)}]: ${e.type === 0x1a ? '0x1a' : String(e.type)}, // :${e.line}${lit}`);
  }
  out.push('});');
  out.push('');
  out.push('/** Codes whose arm raises a non-text notice (no AddTextToScroll). */');
  out.push('export const WEENIE_ERROR_NOTICE_ONLY: Readonly<Record<number, string>> = Object.freeze({');
  for (const e of entries) {
    if (e.type === null && e.notice) out.push(`  [${hex4(e.code)}]: '${e.notice}', // :${e.line}`);
  }
  out.push('});');
  out.push('');
  out.push('/**');
  out.push(' * The retail text type for a code, or null when the retail client printed');
  out.push(' * nothing for it (no switch arm, or a notice-only arm).');
  out.push(' */');
  out.push('export function weenieErrorTextType(code: number): number | null {');
  out.push('  return WEENIE_ERROR_TEXT_TYPE[code] ?? null;');
  out.push('}');
  out.push('');
  out.push("export type WeenieErrorSink = 'spew' | 'chat' | 'none';");
  out.push('');
  out.push('/** spew (0x1a) | chat (any other text type) | none (retail printed nothing). */');
  out.push('export function weenieErrorSink(code: number): WeenieErrorSink {');
  out.push('  const type = weenieErrorTextType(code);');
  out.push('  if (type === null) return \'none\';');
  out.push('  return type === WEENIE_ERROR_TEXT_TYPE_SPEW ? \'spew\' : \'chat\';');
  out.push('}');
  out.push('');
  return out.join('\n');
}

function main(): void {
  const entries = extractSinks(readFileSync(DECOMP_PATH, 'utf8'));
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(String(e.type), (counts.get(String(e.type)) ?? 0) + 1);
  writeFileSync(OUT_PATH, render(entries));
  console.log(`wrote ${OUT_PATH}: ${entries.length} codes`, Object.fromEntries(counts));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
