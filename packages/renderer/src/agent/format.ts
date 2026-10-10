/**
 * Compact text renderings of agent API results — what an LLM player reads.
 * Text, not JSON: a dozen nearby objects as JSON is ~3× the tokens and
 * harder to scan. Pure functions; the CLI and the MCP server both use them.
 */
import type { AgentChatLine, AgentEvent, AgentItem, AgentObject, AgentObservation, AgentSpell, AgentTracePoint } from './types.ts';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** 0..360 compass bearing → "N" / "NE" / … */
export function compassPoint(bearing: number): string {
  const b = ((bearing % 360) + 360) % 360;
  return COMPASS[Math.round(b / 45) % 8];
}

/** Relative bearing → "ahead" / "ahead-left" / "left" / "behind-right" / … */
export function relativeDirection(rel: number): string {
  const a = Math.abs(rel);
  const side = rel < 0 ? 'left' : 'right';
  if (a <= 20) return 'ahead';
  if (a <= 70) return `ahead-${side}`;
  if (a <= 110) return side;
  if (a <= 160) return `behind-${side}`;
  return 'behind';
}

const pct = (f: number): string => `${Math.round(f * 100)}%`;

/** "45s", "12m", "3h", "2d": how long ago a remembered place was seen. */
export function seenAgoText(s: number): string {
  if (s < 120) return `${Math.round(s)}s`;
  if (s < 2 * 3600) return `${Math.round(s / 60)}m`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function formatObject(o: AgentObject): string {
  const bits = [
    `#${o.guid.toString(16)}`,
    o.name,
    `[${o.kind}${o.level ? ` L${o.level}` : ''}]`,
    `${o.dist.toFixed(1)}m ${relativeDirection(o.relBearing)} (${compassPoint(o.bearing)})`,
  ];
  if (Math.abs(o.dz) >= 2) bits.push(`${o.dz > 0 ? 'up' : 'down'} ${Math.abs(o.dz).toFixed(0)}m`);
  if (o.health !== undefined) bits.push(`hp ${pct(o.health)}`);
  if (o.stack && o.stack > 1) bits.push(`x${o.stack}`);
  if (o.open) bits.push('open');
  if (o.dying) bits.push('dying');
  if (o.seenAgo !== undefined) bits.push(`last seen ${seenAgoText(o.seenAgo)} ago`);
  return bits.join('  ');
}

/** Chat lines, with a run of identical lines collapsed to one "(×N)". */
export function formatChat(lines: AgentChatLine[]): string {
  const out: string[] = [];
  let prev = '';
  let n = 0;
  const flush = (): void => { if (n) out.push(`${prev}${n > 1 ? ` (×${n})` : ''}`); };
  for (const l of lines) {
    const s = `  (${l.kind}) ${l.text}`;
    if (s === prev) { n++; continue; }
    flush();
    prev = s;
    n = 1;
  }
  flush();
  return out.join('\n');
}

/** "buffs (3): Strength Other II 2m10s, …" soonest to expire first, or "buffs: none (ac_spells / ac_cast to buff yourself or others)". */
export function formatBuffs(buffs: ReadonlyArray<{ name: string; remaining: number }>): string {
  if (!buffs.length) return 'buffs: none (ac_spells finds buffs you know; ac_cast casts them on yourself or another player)';
  const left = (s: number): string => (s < 0 ? 'permanent' : s >= 60 ? `${Math.floor(s / 60)}m${Math.floor(s % 60) ? `${Math.floor(s % 60)}s` : ''}` : `${Math.max(0, Math.floor(s))}s`);
  const sorted = [...buffs].sort((a, b) => (a.remaining < 0 ? Infinity : a.remaining) - (b.remaining < 0 ? Infinity : b.remaining));
  const shown = sorted.slice(0, 16).map((b) => `${b.name} ${left(b.remaining)}`);
  return `buffs (${buffs.length}): ${shown.join(', ')}${buffs.length > shown.length ? `, +${buffs.length - shown.length} more` : ''}`;
}

export function formatObservation(obs: AgentObservation): string {
  const out: string[] = [];
  const me = obs.me;
  if (obs.screen !== 'world' || !me) {
    out.push(`screen: ${obs.screen}${me ? '' : ' (not in world)'}`);
    if (!me) return out.join('\n');
  }
  const v = (x: { cur: number; max: number }): string => `${x.cur}/${x.max}`;
  out.push(`${me.name} (L${me.level})${me.dead ? '  ** DEAD **' : ''}  HP ${v(me.health)}  ST ${v(me.stamina)}  MA ${v(me.mana)}  mode ${me.combatMode}`);
  out.push(`at ${me.coords ?? 'indoors'}  cell ${me.cell}  facing ${Math.round(me.heading)}° (${compassPoint(me.heading)})${me.task ? `  task: ${me.task}` : ''}`);
  if (me.pyreals !== undefined || me.burden || me.xp) out.push(`pyreals ${me.pyreals ?? '?'}${me.burden ? `  burden ${me.burden}` : ''}${me.xp ? `  unassigned xp ${me.xp.unassigned.toLocaleString('en-US')}${me.xp.unassigned >= 1000 ? ' (spend it: ac_raise)' : ''}` : ''}`);
  for (const [i, d] of obs.dialogs.entries()) out.push(`DIALOG ${i} [${d.buttons.join(' / ')}]: ${d.text.replace(/\s+/g, ' ')}`);
  if (obs.dialogs.length) out.push('  (answer or dismiss each with ac_dialog, e.g. button=OK; a dialog stays up until you do)');
  out.push(formatBuffs((obs.buffs ?? []).filter((b) => b.beneficial !== false)));
  const bad = (obs.buffs ?? []).filter((b) => b.beneficial === false);
  if (bad.length) out.push(formatBuffs(bad).replace(/^buffs/, 'debuffs'));
  if (obs.buffsMissing?.length) out.push(`  buffs you know that aren't up: ${obs.buffsMissing.slice(0, 10).join(', ')}${obs.buffsMissing.length > 10 ? ` +${obs.buffsMissing.length - 10} more` : ''} (ac_cast; "… Other" ones go on a fellow with target=)`);
  if (obs.windows?.length) out.push(`windows open: ${obs.windows.join(', ')}  (ac_close name=… or all, when done with them)`);
  out.push(`target: ${obs.target ? formatObject(obs.target) : 'none'}`);
  out.push(`nearby (${obs.nearby.length}${obs.nearbyTotal > obs.nearby.length ? ` of ${obs.nearbyTotal}` : ''}, nearest first):`);
  for (const o of obs.nearby) out.push(`  ${formatObject(o)}`);
  if (obs.remembered?.length) {
    out.push('remembered, out of view (walk_to / use them by name):');
    for (const o of obs.remembered) out.push(`  ${formatObject(o)}`);
  }
  if (obs.chat.length) {
    out.push('chat/log since last look:');
    out.push(formatChat(obs.chat));
  }
  out.push(`seq ${obs.seq}`);
  return out.join('\n');
}

export function formatEvents(events: AgentEvent[]): string {
  if (!events.length) return '(no events)';
  return events.map((e) => `  [${e.seq}] ${e.type}: ${e.text}`).join('\n');
}

export function formatInventory(items: AgentItem[]): string {
  if (!items.length) return '(empty)';
  const groups = new Map<string, AgentItem[]>();
  for (const it of items) {
    const g = groups.get(it.where) ?? [];
    g.push(it);
    groups.set(it.where, g);
  }
  const out: string[] = [];
  for (const [where, list] of groups) {
    out.push(`${where}:`);
    for (const it of list) {
      const extra = [it.slot, it.stack && it.stack > 1 ? `x${it.stack}` : '', it.type].filter(Boolean).join(', ');
      out.push(`  #${it.guid.toString(16)} ${it.name}${extra ? `  (${extra})` : ''}`);
    }
  }
  return out.join('\n');
}

export function formatTrace(points: AgentTracePoint[]): string {
  if (!points.length) return '(no trace yet)';
  return points.map((p) => `  -${p.ago.toFixed(1)}s  ${p.cell}  (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, z ${p.z.toFixed(2)})  facing ${p.heading}°  ${p.mode}${p.camera ? `  camera ${p.camera[0].toFixed(2)}${p.camera[1] - p.camera[0] > 0.005 ? `–${p.camera[1].toFixed(2)}` : ''}m` : ''}${p.task ? `  [${p.task}]` : ''}`).join('\n');
}

export function formatSpells(spells: AgentSpell[]): string {
  if (!spells.length) return '(no matching spells)';
  return spells.map((s) => `  ${s.id}  ${s.name}  [${s.school}${s.level ? ` L${s.level}` : ''}]`).join('\n');
}
