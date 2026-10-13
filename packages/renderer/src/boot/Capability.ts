/**
 * RELEASE.capability-check — can this browser run the client?
 *
 * Retail had a minimum-spec list on the box; a browser needs the check at
 * boot, before the patch screen starts downloading. A hard problem (no WebGL
 * 2, no WebSocket) stops with an explanation; a soft one (little memory, no
 * mouse) explains and lets the player continue. This screen is browser UX,
 * not a retail screen (CLAUDE.md, browser-UX exception), and it draws before
 * any DAT is loaded, so it uses plain CSS named colours.
 */

export interface CapabilityProblem {
  id: 'webgl2' | 'websocket' | 'memory' | 'pointer';
  hard: boolean;
  text: string;
}

export interface CapabilityEnv {
  /** A WebGL 2 context can be created. */
  webgl2: boolean;
  websocket: boolean;
  /** navigator.deviceMemory in GB (Chromium; capped at 8), or null when the browser doesn't say. */
  deviceMemoryGb: number | null;
  /** A mouse or trackpad is present (`(pointer: fine)` or `(any-pointer: fine)`). */
  finePointer: boolean;
}

/** Below this the streamed client (~1–2 GB in world) is likely to be killed by the browser. */
export const MIN_DEVICE_MEMORY_GB = 4;

export function capabilityProblems(env: CapabilityEnv): CapabilityProblem[] {
  const out: CapabilityProblem[] = [];
  if (!env.webgl2) {
    out.push({
      id: 'webgl2', hard: true,
      text: 'This browser could not start WebGL 2, which the game needs to draw the world. '
        + 'Use a current Chrome, Edge, Firefox or Safari on a desktop or laptop, and make sure hardware acceleration '
        + '(graphics acceleration) is turned on in the browser settings. '
        // A browser that ran the game before turns WebGL off for the site after a graphics crash (Chrome:
        // chrome://gpu shows it), until it restarts (live 2026-10-13: Chrome 155 on Windows, minutes after playing).
        + 'If the game worked before in this browser, quit the browser completely and start it again: after a '
        + 'graphics crash the browser turns graphics off for the site until it restarts (in Chrome, chrome://gpu shows it). '
        + 'If it keeps happening, update your graphics driver.',
    });
  }
  if (!env.websocket) {
    out.push({ id: 'websocket', hard: true, text: 'This browser cannot open the connection the game uses (WebSocket). Use a current desktop browser.' });
  }
  if (env.deviceMemoryGb !== null && env.deviceMemoryGb < MIN_DEVICE_MEMORY_GB) {
    out.push({
      id: 'memory', hard: false,
      text: `This device reports ${env.deviceMemoryGb} GB of memory. The game needs about ${MIN_DEVICE_MEMORY_GB} GB and may close or run slowly.`,
    });
  }
  if (!env.finePointer) {
    out.push({
      id: 'pointer', hard: false,
      text: 'Asheron\'s Call is played with a keyboard and mouse. Phones and tablets are not supported.',
    });
  }
  return out;
}

/** Probe the real browser. */
export function probeCapabilities(win: Window & typeof globalThis): CapabilityEnv {
  let webgl2 = false;
  try {
    const gl = win.document.createElement('canvas').getContext('webgl2');
    webgl2 = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { webgl2 = false; }
  const mem = (win.navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const mq = (q: string) => { try { return win.matchMedia(q).matches; } catch { return true; } };
  return {
    webgl2,
    websocket: typeof win.WebSocket === 'function',
    deviceMemoryGb: typeof mem === 'number' && mem > 0 ? mem : null,
    finePointer: mq('(pointer: fine)') || mq('(any-pointer: fine)'),
  };
}

/**
 * Show the problems over the page. Resolves when the player chooses to
 * continue (soft problems only); never resolves when a problem is hard.
 */
export function showCapabilityScreen(doc: Document, problems: CapabilityProblem[]): Promise<void> {
  const hard = problems.some(p => p.hard);
  const root = doc.createElement('div');
  root.id = 'capability-screen';
  Object.assign(root.style, {
    position: 'fixed', inset: '0', zIndex: '1000', background: 'black', color: 'wheat',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
    font: '16px/1.5 Georgia, "Times New Roman", serif',
  });
  const box = doc.createElement('div');
  Object.assign(box.style, { maxWidth: '560px', border: '1px solid darkgoldenrod', padding: '24px 28px' });
  const title = doc.createElement('h1');
  title.textContent = hard ? 'This browser can\'t run the game' : 'Before you continue';
  Object.assign(title.style, { font: 'bold 22px Georgia, serif', color: 'goldenrod', margin: '0 0 12px' });
  box.appendChild(title);
  for (const p of problems) {
    const para = doc.createElement('p');
    para.className = `capability-problem capability-${p.id}`;
    para.textContent = p.text;
    para.style.margin = '0 0 10px';
    box.appendChild(para);
  }
  root.appendChild(box);
  doc.body.appendChild(root);
  if (hard) return new Promise(() => {});
  return new Promise((resolve) => {
    const btn = doc.createElement('button');
    btn.className = 'capability-continue';
    btn.textContent = 'Continue anyway';
    Object.assign(btn.style, { marginTop: '8px', font: '16px Georgia, serif', padding: '6px 16px', cursor: 'pointer' });
    btn.addEventListener('click', () => { root.remove(); resolve(); });
    box.appendChild(btn);
  });
}
