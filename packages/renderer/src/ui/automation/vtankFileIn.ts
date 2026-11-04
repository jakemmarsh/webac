/**
 * AGENT.vtank-import-files — the player's own VirindiTank files into the browser (Reddit, 2026-11-04: "I
 * can't figure out how to add my own .nav / .met / .utl files that are already created in my vtank folder").
 *
 * In Windows VTank read them from its folder (the Profiles tab's dropdowns, `/vt nav|meta|loot|settings
 * load`). A page has no folder, so the files come through the browser's file picker (several at once: a whole
 * folder's worth) or a drop on the window. This is the browser-UX stand-in for that folder, as the downloads
 * (VTankWindow.giveFile) are for VTank writing to it. VTank writes Windows-1252 text.
 */

/** Every file kind the importer reads (vtankFiles.ts): VTank's .met / .nav / .utl / .usd and metaf's .af. */
export const VT_FILE_ACCEPT = '.met,.nav,.utl,.usd,.af';

export interface VtTextFile { name: string; text: string }

/** Read picked or dropped files as VTank wrote them (Windows-1252), in the order given. */
export async function readVTankFiles(files: ArrayLike<Blob & { name: string }>): Promise<VtTextFile[]> {
  const list = Array.from(files);
  const dec = new TextDecoder('windows-1252');
  return Promise.all(list.map(async (f) => ({ name: f.name, text: dec.decode(await f.arrayBuffer()) })));
}

/**
 * The browser's file picker, several files at once. A page may open it only inside a user action (a click,
 * or a key press such as Enter in the chat box) for a few seconds after it: false when the browser says
 * that has run out (`navigator.userActivation`), so the caller can say where the button is instead.
 * A cancelled picker calls nothing.
 */
export function pickVTankFiles(onFiles: (files: VtTextFile[]) => void, doc: Document = document): boolean {
  const ua = (globalThis.navigator as Navigator & { userActivation?: { isActive: boolean } } | undefined)?.userActivation;
  if (ua && !ua.isActive) return false;
  const input = doc.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = VT_FILE_ACCEPT;
  input.addEventListener('change', () => {
    const files = input.files;
    if (!files?.length) return;
    void readVTankFiles(files).then((read) => { if (read.length) onFiles(read); });
  });
  input.click();
  return true;
}

const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * Files dropped on `el` are read and handed over (`data-vtank-drop="1"` while a file drag is over it).
 * Returns the detach function.
 */
export function attachVTankFileDrop(el: HTMLElement, onFiles: (files: VtTextFile[]) => void): () => void {
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    el.dataset.vtankDrop = '1';
  };
  const leave = (e: DragEvent) => {
    // Leaving for a child is not leaving the window.
    if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
    delete el.dataset.vtankDrop;
  };
  const drop = (e: DragEvent) => {
    delete el.dataset.vtankDrop;
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer?.files;
    if (files?.length) void readVTankFiles(files).then((read) => { if (read.length) onFiles(read); });
  };
  el.addEventListener('dragover', over);
  el.addEventListener('dragenter', over);
  el.addEventListener('dragleave', leave);
  el.addEventListener('drop', drop);
  return () => {
    el.removeEventListener('dragover', over);
    el.removeEventListener('dragenter', over);
    el.removeEventListener('dragleave', leave);
    el.removeEventListener('drop', drop);
  };
}

/**
 * A file dropped anywhere else on the page would make the browser open it in place of the game, ending the
 * session. Once installed, a file drag that no drop target took does nothing.
 */
export function guardPageFileDrops(target: Window | Document = window): void {
  const t = target as EventTarget & { __vtFileGuard?: boolean };
  if (t.__vtFileGuard) return;
  t.__vtFileGuard = true;
  const stop = (e: Event) => { if (hasFiles(e as DragEvent)) e.preventDefault(); };
  t.addEventListener('dragover', stop);
  t.addEventListener('drop', stop);
}
