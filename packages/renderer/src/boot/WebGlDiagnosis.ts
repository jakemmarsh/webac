/**
 * BOOT.webgl2-diagnosis — why this browser could not start WebGL 2, and what
 * the player can do about it.
 *
 * Production saw "unsupported browser: webgl2" from Windows Chrome after a
 * graphics crash, Windows Chrome on a (likely managed) work machine, and Linux
 * aarch64 Chrome (a Raspberry Pi-class board, where Chrome blocklists the GPU
 * driver). The game can't draw without WebGL 2 (three.js dropped WebGL 1, and
 * Chrome no longer falls back to SwiftShader), so the best we can do is name
 * the cause and give the fix for that cause on that platform.
 *
 * The browser's own reason arrives as the `webglcontextcreationerror` event's
 * statusMessage, fired synchronously inside getContext() in Chromium and
 * Firefox, so the listener goes on before the call. Chromium's strings
 * (third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc):
 * "Web page caused context loss and was blocked" (blocked after a GPU crash),
 * "disabled by enterprise policy or commandline switch", and
 * "Could not create a WebGL context, VENDOR = …, GL_VENDOR = Disabled, …
 * ErrorMessage = …" (no usable GPU process). Firefox names blocklist entries
 * in its message.
 *
 * Page code shared by every era; nothing here is era-specific.
 */
import { classifyGpu, unmaskedRenderer } from '../telemetry/WorldReporter.js';

export const WEBGL_FAILURE_CAUSES = [
  'blocklisted', 'acceleration_disabled', 'gpu_process_unavailable', 'context_lost_after_crash',
  'webgl1_only', 'no_webgl', 'unknown', 'disabled_by_policy',
] as const;
export type WebGlFailureCause = typeof WEBGL_FAILURE_CAUSES[number];

export interface WebGlFailure {
  cause: WebGlFailureCause;
  /** The browser's statusMessage, clipped and reduced to plain characters (cleanWebGlStatus), or null. */
  status: string | null;
}

/** Longest statusMessage kept; the useful part (the reason) comes first. */
export const WEBGL_STATUS_MAX = 120;

/** Keep only [A-Za-z0-9 .,:;()/_-], collapse whitespace, clip to WEBGL_STATUS_MAX; null when nothing is left. */
export function cleanWebGlStatus(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw;
  // Chromium's "Could not create a WebGL context, VENDOR = …, GL_VENDOR = …, … ErrorMessage = …" puts the
  // reason last, past the clip: keep the head, GL_VENDOR and the ErrorMessage.
  const err = /ErrorMessage\s*=\s*(.*)$/s.exec(raw);
  if (err) {
    const glVendor = /GL_VENDOR\s*=\s*([^,]*)/.exec(raw)?.[1]?.trim();
    text = [raw.split(',')[0], glVendor ? `GL_VENDOR ${glVendor}` : null, err[1]].filter(Boolean).join('; ');
  }
  const s = text.replace(/[^A-Za-z0-9\s.,:;()/_-]/g, '').replace(/\s+/g, ' ').trim().slice(0, WEBGL_STATUS_MAX).trim();
  return s.length > 0 ? s : null;
}

export interface WebGlFailureEvidence {
  /** statusMessage of the WebGL 2 attempt (raw). */
  status: string | null;
  /** A WebGL 1 context could be created. */
  webgl1: boolean;
  /** The WebGL 1 context's unmasked renderer, when the browser shows it. */
  webgl1Renderer: string | null;
  /** A 2D canvas context could be created. */
  canvas2d: boolean;
}

/** Normalise the evidence into one cause. */
export function classifyWebGlFailure(e: WebGlFailureEvidence): WebGlFailureCause {
  const s = (e.status ?? '').toLowerCase();
  if (/context loss and was blocked|caused context loss/.test(s)) return 'context_lost_after_crash';
  // Chromium: "disabled by enterprise policy or commandline switch" — a policy or a launch switch
  // (e.g. --disable-3d-apis), which no flag undoes (live 2026-10-17, headless Chrome 148).
  if (/enterprise policy|commandline switch|command line switch/.test(s)) return 'disabled_by_policy';
  if (/block ?list|black ?list/.test(s)) return 'blocklisted';
  if (e.webgl1 && classifyGpu(e.webgl1Renderer) === 'software') return 'acceleration_disabled';
  if (e.webgl1) return 'webgl1_only';
  if (/gpuchannelhost|gpu process|gl_vendor = disabled|bindtocurrentsequence|could not create a webgl/.test(s)) return 'gpu_process_unavailable';
  if (!e.canvas2d) return 'unknown';
  if (!s) return 'no_webgl';
  return 'unknown';
}

interface ProbeCanvas {
  getContext(kind: string): unknown;
  addEventListener?(type: string, listener: (ev: Event) => void): void;
}

type GlLike = { getExtension(name: string): unknown; getParameter(p: number): unknown };

/** Try one context kind on a fresh canvas, catching the creation-error statusMessage. */
function tryContext(makeCanvas: () => ProbeCanvas, kind: string): { ctx: unknown; status: string | null } {
  let status: string | null = null;
  let ctx: unknown = null;
  try {
    const c = makeCanvas();
    c.addEventListener?.('webglcontextcreationerror', (ev: Event) => {
      const m = (ev as Event & { statusMessage?: unknown }).statusMessage;
      if (typeof m === 'string' && m) status = m;
    });
    ctx = c.getContext(kind);
  } catch (err) {
    ctx = null;
    if (status === null && err instanceof Error && err.message) status = err.message;
  }
  return { ctx, status };
}

function releaseGl(gl: unknown): void {
  try { ((gl as GlLike).getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext(); } catch { /* best effort */ }
}

export interface WebGl2Probe {
  /** The WebGL 2 context's unmasked renderer when it worked. */
  renderer: string | null;
  webgl2: boolean;
  /** Why it failed (null when it worked). */
  failure: WebGlFailure | null;
}

/** Probe WebGL 2; when it fails, gather the evidence and classify why. */
export function probeWebGl2(makeCanvas: () => ProbeCanvas): WebGl2Probe {
  const v2 = tryContext(makeCanvas, 'webgl2');
  if (v2.ctx) {
    const renderer = unmaskedRenderer(v2.ctx as GlLike);
    releaseGl(v2.ctx);
    return { renderer, webgl2: true, failure: null };
  }
  const v1 = tryContext(makeCanvas, 'webgl');
  const webgl1Renderer = v1.ctx ? unmaskedRenderer(v1.ctx as GlLike) : null;
  if (v1.ctx) releaseGl(v1.ctx);
  const c2d = tryContext(makeCanvas, '2d');
  const status = v2.status ?? v1.status;
  const cause = classifyWebGlFailure({ status, webgl1: !!v1.ctx, webgl1Renderer, canvas2d: !!c2d.ctx });
  return { renderer: null, webgl2: false, failure: { cause, status: cleanWebGlStatus(status) } };
}

// ── Platform ──────────────────────────────────────────────────────────

export type HelpOs = 'windows' | 'mac' | 'linux' | 'linux_arm' | 'chromeos' | 'other';
export type HelpBrowser = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';
export interface HelpPlatform { os: HelpOs; browser: HelpBrowser }

export interface NavigatorLike {
  userAgent?: string;
  userAgentData?: { platform?: string; brands?: Array<{ brand: string }> } | null;
}

/** OS and browser family from navigator.userAgentData (Chromium) with the userAgent string as fallback. */
export function detectHelpPlatform(nav: NavigatorLike | null | undefined): HelpPlatform {
  const ua = nav?.userAgent ?? '';
  const uadPlatform = (nav?.userAgentData?.platform ?? '').toLowerCase();
  const brands = (nav?.userAgentData?.brands ?? []).map(b => b.brand.toLowerCase());
  let os: HelpOs = 'other';
  if (uadPlatform === 'windows' || /Windows NT/.test(ua)) os = 'windows';
  else if (uadPlatform === 'chrome os' || uadPlatform === 'chromeos' || /\bCrOS\b/.test(ua)) os = 'chromeos';
  else if (uadPlatform === 'macos' || /Macintosh|Mac OS X/.test(ua)) os = 'mac';
  else if (uadPlatform === 'android' || /Android/.test(ua)) os = 'other';
  else if (uadPlatform === 'linux' || /Linux|X11/.test(ua)) os = /aarch64|arm64|armv\d|\barm\b/i.test(ua) ? 'linux_arm' : 'linux';
  let browser: HelpBrowser = 'other';
  if (brands.some(b => b.includes('edge')) || /\bEdg\//.test(ua)) browser = 'edge';
  else if (/Firefox\//.test(ua)) browser = 'firefox';
  else if (brands.some(b => b === 'google chrome' || b === 'chromium') || /Chrome\/|Chromium\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'safari';
  return { os, browser };
}

// ── Advice ────────────────────────────────────────────────────────────

const INTRO = 'This browser could not start WebGL 2, which the game needs to draw the world.';
const POLICY = 'Graphics are turned off for this browser by a policy (on a work or school computer, your IT department) '
  + 'or by a setting it was started with. Ask your IT department, or try another browser.';
const WORK_PC = 'On a work computer, graphics may be turned off by your IT policy.';

function flagsStep(browser: HelpBrowser): string | null {
  if (browser === 'chrome') return 'Open chrome://flags/#ignore-gpu-blocklist, set "Override software rendering list" to Enabled, and click Relaunch.';
  if (browser === 'edge') return 'Open edge://flags/#ignore-gpu-blocklist, set "Override software rendering list" to Enabled, and click Restart.';
  return null;
}

function accelerationStep(browser: HelpBrowser): string | null {
  if (browser === 'chrome') return 'Open Settings > System (chrome://settings/system), turn on "Use graphics acceleration when available", and click Relaunch.';
  if (browser === 'edge') return 'Open Settings > System and performance (edge://settings/system), turn on "Use graphics acceleration when available", and restart Edge.';
  if (browser === 'firefox') return 'Open Settings > General > Performance, untick "Use recommended performance settings", tick the hardware acceleration box, and restart Firefox.';
  return null;
}

const FIREFOX_SUPPORT = 'about:support (the Graphics section) shows why Firefox turned WebGL off. '
  + 'Setting webgl.force-enabled to true in about:config can override it, at your own risk: it may be unstable on this graphics driver.';

const RESTART = 'If the game worked before in this browser, quit the browser completely and start it again: after a '
  + 'graphics crash the browser turns graphics off for the site until it restarts';

/** The player-facing explanation for a WebGL 2 failure, most likely fix first. */
export function webgl2HelpText(failure: WebGlFailure | null, platform: HelpPlatform): string {
  const { os, browser } = platform;
  const chromium = browser === 'chrome' || browser === 'edge';
  const gpuPage = browser === 'edge' ? 'edge://gpu' : 'chrome://gpu';
  const tryFirefox = os === 'linux' || os === 'linux_arm' || os === 'windows' ? 'Or try Firefox, which may work on this computer.' : null;
  const parts: Array<string | null> = [INTRO];
  const cause = failure?.cause ?? 'unknown';
  switch (cause) {
    case 'context_lost_after_crash':
      parts.push(`${RESTART}${chromium ? ` (${gpuPage} shows it)` : ''}.`, 'If it keeps happening, update your graphics driver.');
      break;
    case 'blocklisted':
      if (chromium) {
        parts.push(`${browser === 'edge' ? 'Edge' : 'Chrome'} has turned graphics off for this computer's graphics chip or driver.`,
          flagsStep(browser), tryFirefox);
      } else if (browser === 'firefox') {
        parts.push('Firefox has turned WebGL off for this computer\'s graphics chip or driver.', 'Update your graphics driver.', FIREFOX_SUPPORT);
      } else {
        parts.push('The browser has turned graphics off for this computer\'s graphics chip or driver. Update your graphics driver, or try Chrome or Firefox.');
      }
      break;
    case 'disabled_by_policy':
      parts.push(POLICY);
      break;
    case 'acceleration_disabled':
      parts.push('The browser is drawing without the graphics card (hardware acceleration looks turned off).',
        accelerationStep(browser) ?? 'Turn on hardware (graphics) acceleration in the browser settings and restart it, or try Chrome or Firefox.');
      break;
    case 'gpu_process_unavailable':
      // Chromium reports the same failure when graphics acceleration is off and when the GPU is blocklisted;
      // on Linux (ARM boards above all) the blocklist is the usual reason, elsewhere the setting.
      parts.push('The browser could not use the graphics card.');
      if (chromium && (os === 'linux' || os === 'linux_arm')) {
        parts.push(flagsStep(browser), `If that doesn't help: ${accelerationStep(browser)}`, tryFirefox);
      } else {
        parts.push(accelerationStep(browser) ?? 'Turn on hardware (graphics) acceleration in the browser settings and restart it.',
          `${RESTART}.`, chromium ? `If ${gpuPage} still shows WebGL disabled: ${flagsStep(browser)}` : null);
      }
      break;
    case 'webgl1_only':
      parts.push('It can only start the older WebGL 1, which usually means an old graphics driver or browser.',
        'Update the browser and your graphics driver.',
        chromium ? `If that doesn't help: ${flagsStep(browser)}` : browser === 'firefox' ? FIREFOX_SUPPORT : 'Or try a current Chrome or Firefox.');
      break;
    case 'no_webgl':
      parts.push('WebGL is turned off or unavailable in this browser.',
        accelerationStep(browser) ?? 'Make sure hardware (graphics) acceleration is turned on in the browser settings.',
        chromium ? `${gpuPage} shows whether WebGL is disabled and why.` : browser === 'firefox' ? FIREFOX_SUPPORT : 'Or try a current Chrome, Edge or Firefox.');
      break;
    default:
      parts.push('Use a current Chrome, Edge, Firefox or Safari on a desktop or laptop, and make sure hardware acceleration '
        + '(graphics acceleration) is turned on in the browser settings.',
      `${RESTART} (in Chrome, chrome://gpu shows it).`, 'If it keeps happening, update your graphics driver.');
  }
  if (os === 'windows' && (cause === 'blocklisted' || cause === 'acceleration_disabled' || cause === 'gpu_process_unavailable' || cause === 'no_webgl')) {
    parts.push(WORK_PC);
  }
  return parts.filter((p): p is string => !!p).join(' ');
}
