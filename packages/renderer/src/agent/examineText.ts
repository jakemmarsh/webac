/**
 * The examination window's content as plain text, for the agent's appraise.
 * Built from the same ExaminationView the window draws (no-cheating rule:
 * an agent sees what the panel shows, not the raw appraisal properties).
 */
import type { ExaminationView } from '../ui/examine/ExaminationWindow.ts';

export function examineText(view: ExaminationView): string {
  const out: string[] = [view.title];
  if (view.item) {
    const body = view.item.text.trim();
    // The header strip repeats in the body when the body already prints Value / Burden.
    const head = /\bValue:|\bBurden:/.test(body) ? '' : [view.item.value, view.item.burden].filter(Boolean).join('   ');
    if (head) out.push(head);
    if (body) out.push(body);
  }
  const c = view.creature;
  if (c) {
    if (c.page === 'creature' && c.creatureDisplayName) out.push(c.creatureDisplayName);
    if (c.page === 'character') {
      const who = [c.heritage, c.title, c.playerKiller].filter(Boolean).join(', ');
      if (who) out.push(who);
      if (c.allegianceName) out.push(`Allegiance: ${c.allegianceName}`);
    }
    if (c.level) out.push(`Level ${c.level}`);
    for (const r of c.stats) out.push(`${r.label}: ${r.value}`);
    for (const m of c.miscInfo) out.push(`${m.label} ${m.value}`.trim());
  }
  // `text` is the edit box's content (the "<Inscribe here>" prompt when blank); `inscription` is what was written.
  if (view.inscription?.visible && view.inscription.inscription) {
    out.push(`Inscription: "${view.inscription.inscription}"${view.inscription.scribe ? ` — ${view.inscription.scribe}` : ''}`);
  }
  return out.filter((l) => l.trim()).join('\n');
}
