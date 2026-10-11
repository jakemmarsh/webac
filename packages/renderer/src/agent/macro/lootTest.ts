/**
 * VirindiTank's /vt testitem and /vt propertydump (docs/vtank-parity-gaps.md
 * §3.9; its wiki's Virindi_Tank_Commands): what the loot rules would do with
 * the selected item were it on a corpse, and the selected item's raw game
 * properties as its examination gave them.
 */
import { PropertyBool, PropertyDataId, PropertyFloat, PropertyInt, PropertyString } from '@ac/shared';

export interface DumpProps {
  int?: Record<number, number>; float?: Record<number, number>; string?: Record<number, string>;
  bool?: Record<number, boolean>; did?: Record<number, number>; spells?: string[];
}

const nameOf = (e: Record<number, string>, k: number): string => (typeof e[k] === 'string' ? e[k] : `#${k}`);

/** The item's properties, a line per kind (ACE property names; unknown keys by number). */
export function propertyDumpLines(itemName: string, props: DumpProps | null): string[] {
  if (!props) return [`${itemName}: no examination data`];
  const out = [`Properties of ${itemName}:`];
  const kind = (label: string, map: Record<number, unknown> | undefined, names: Record<number, string>, fmt: (v: unknown, k: number) => string) => {
    const keys = Object.keys(map ?? {}).map(Number).sort((a, b) => a - b);
    if (!keys.length) return;
    out.push(`  ${label}: ${keys.map((k) => `${nameOf(names, k)}(${k})=${fmt(map![k], k)}`).join(', ')}`);
  };
  kind('Int', props.int, PropertyInt as unknown as Record<number, string>, (v) => String(v));
  kind('Float', props.float, PropertyFloat as unknown as Record<number, string>, (v) => String(Math.round(Number(v) * 10000) / 10000));
  kind('Bool', props.bool, PropertyBool as unknown as Record<number, string>, (v) => (v ? 'true' : 'false'));
  kind('String', props.string, PropertyString as unknown as Record<number, string>, (v) => JSON.stringify(String(v)));
  kind('DataId', props.did, PropertyDataId as unknown as Record<number, string>, (v) => `0x${(Number(v) >>> 0).toString(16).toUpperCase().padStart(8, '0')}`);
  if (props.spells?.length) out.push(`  Spells: ${props.spells.join(', ')}`);
  if (out.length === 1) out.push('  (none)');
  return out;
}

/** /vt testitem's answer: the action and the rule, or that no rule takes it. */
export function testItemLine(itemName: string, result: { action: string; rule: string } | null): string {
  return result ? `TestItem: ${itemName} => ${result.action} (rule: ${result.rule})` : `TestItem: ${itemName} => no rule matches (left on the corpse)`;
}
