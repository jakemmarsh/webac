/**
 * A plugin window redraws by rebuilding its body (Mag-Tools' every second, a tracker's on each change). A text box being
 * typed in would be replaced mid-word and the next keys would fall through to the game: a space jumped, letters ran
 * hotkeys (found live 2026-10-13 adding a Mag-Tools periodic command). This puts focus and the caret back in the
 * rebuilt box: the same `name` / `data-name`, else the same place among the window's text boxes.
 */
type Field = HTMLInputElement | HTMLTextAreaElement;

function fieldsOf(root: HTMLElement): Field[] {
  return Array.from(root.querySelectorAll<Field>('input, textarea')).filter((e) => !(e instanceof HTMLInputElement) || !['checkbox', 'radio', 'button', 'submit', 'range'].includes(e.type));
}

function nameOf(e: Field): string | null { return e.getAttribute('name') ?? e.dataset.name ?? null; }

export function redrawKeepingFocus(root: HTMLElement, draw: () => void): void {
  const active = root.ownerDocument.activeElement;
  const before = fieldsOf(root);
  const was = active && root.contains(active) ? before.find((e) => e === active) : undefined;
  if (!was) { draw(); return; }
  const name = nameOf(was);
  const index = before.indexOf(was);
  const value = was.value;
  let start: number | null = null; let end: number | null = null;
  try { start = was.selectionStart; end = was.selectionEnd; } catch { /* no selection on this input type */ }
  draw();
  if (was.isConnected) return; // the box survived the redraw: nothing lost
  const after = fieldsOf(root);
  const next = (name !== null ? after.find((e) => nameOf(e) === name) : undefined) ?? after[index];
  if (!next) return;
  if (next.value !== value) next.value = value;
  next.focus();
  try { if (start !== null) next.setSelectionRange(start, end ?? start); } catch { /* no selection on this input type */ }
}
