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
 * ErrorMessage = …" (no usable GPU process). Firefox (dom/canvas/WebGLContext.cpp):
 * "WebGL creation failed: * AllowWebgl2:false restricts context creation on
 * this system." when its GfxInfo blocklist refuses FEATURE_WEBGL2 for this
 * graphics card or driver (gfxPlatform::InitWebGLConfig). WebGL 1 is allowed on
 * unknown configurations and WebGL 2 is not (GfxInfoBase::
 * OnlyAllowFeatureOnKnownConfig), so a Windows PC with no graphics driver
 * ("Microsoft Basic Display Adapter"), a virtual machine, or an unknown vendor or
 * driver version gets WebGL 1 (often in software) but no WebGL 2. Firefox's
 * hardware-acceleration checkbox does not change this; webgl.force-enabled skips
 * the check. "WebGL is currently disabled." is webgl.disabled = true or
 * Troubleshoot Mode. webgl.enable-webgl2 = false fires no event at all: the
 * "webgl2" context type is simply not recognised (dom/canvas/CanvasUtils.cpp).
 *
 * BUG.webgl-blocked-in-page — privacy / anti-fingerprinting extensions replace
 * HTMLCanvasElement.prototype.getContext in the page with a function that
 * returns null for WebGL. The browser then fires no creation-error event and
 * WebGL 1 fails as well, which used to read as `no_webgl` and sent the player
 * to the graphics-acceleration setting (prod 2026-11-17: five Chrome 148-150
 * boots, one player reloading twice in 3 s; reproduced live with a page-world
 * getContext override). pageBlockEvidence() looks for the override: whether
 * getContext is still the browser's own function (read with an untouched
 * realm's Function.prototype.toString), and whether a fresh realm the patch may
 * not reach (an about:blank iframe, an OffscreenCanvas) can still create a
 * WebGL 2 context. Either one names the cause `blocked_in_page`.
 *
 * The game does not go around the block with the browser's own getContext: the
 * player installed the extension to stop sites using WebGL, three.js and every
 * other canvas path call the patched method, and such extensions usually wrap
 * more of WebGL than getContext. The screen tells them how to allow this site.
 *
 * Page code shared by every era; nothing here is era-specific.
 */
import { classifyGpu, unmaskedRenderer } from '../telemetry/WorldReporter.js';

export const WEBGL_FAILURE_CAUSES = [
  'blocklisted', 'acceleration_disabled', 'gpu_process_unavailable', 'context_lost_after_crash',
  'webgl1_only', 'no_webgl', 'unknown', 'disabled_by_policy', 'webgl2_blocked', 'webgl_turned_off',
  'blocked_in_page',
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
  /** BUG.webgl-blocked-in-page — signs that a page script replaced getContext (pageBlockEvidence). Absent = none looked for. */
  pageBlock?: PageBlockEvidence | null;
}

/** BUG.webgl-blocked-in-page — what the page-level check found. */
export interface PageBlockEvidence {
  /** HTMLCanvasElement.prototype.getContext (what the probe called) is not the browser's own function. */
  patched: boolean;
  /** A realm the page's patch did not reach (fresh iframe, OffscreenCanvas) created a WebGL 2 context. */
  freshRealmWebGl2: boolean;
}

// Strings only a real browser failure produces (statusMessage); none comes from a page patch, which returns null silently.
const BROWSER_STATUS = /context loss|enterprise policy|commandline switch|command line switch|allowwebgl2|webgl is currently disabled|block ?list|black ?list|gpuchannelhost|gpu process|gl_vendor|bindtocurrentsequence|could not create a webgl/;

/** Normalise the evidence into one cause. */
export function classifyWebGlFailure(e: WebGlFailureEvidence): WebGlFailureCause {
  const s = (e.status ?? '').toLowerCase();
  if (/context loss and was blocked|caused context loss/.test(s)) return 'context_lost_after_crash';
  // Chromium: "disabled by enterprise policy or commandline switch" — a policy or a launch switch
  // (e.g. --disable-3d-apis), which no flag undoes (live 2026-10-17, headless Chrome 148).
  if (/enterprise policy|commandline switch|command line switch/.test(s)) return 'disabled_by_policy';
  // Firefox: WebGL 2 alone refused by the GfxInfo blocklist (unknown/missing driver, VM, blocklisted driver).
  if (/allowwebgl2\s*:\s*false/.test(s)) return 'webgl2_blocked';
  // Firefox: webgl.disabled = true, or Firefox running in Troubleshoot (safe) Mode.
  if (/webgl is currently disabled/.test(s)) return 'webgl_turned_off';
  if (/block ?list|black ?list/.test(s)) return 'blocklisted';
  // BUG.webgl-blocked-in-page: a fresh realm drew where the page could not, so the page's own getContext is
  // the block. A patched getContext alone is weaker (a pass-through wrapper, e.g. a WebGL debugger, also
  // reads as patched), so it counts only when no WebGL at all came back and the browser gave no reason.
  if (!BROWSER_STATUS.test(s) && e.pageBlock) {
    if (e.pageBlock.freshRealmWebGl2) return 'blocked_in_page';
    if (e.pageBlock.patched && !e.webgl1) return 'blocked_in_page';
  }
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

/**
 * Probe WebGL 2; when it fails, gather the evidence and classify why. `pageBlock` (pageBlockEvidence on the
 * real page) runs only on failure.
 */
export function probeWebGl2(makeCanvas: () => ProbeCanvas, pageBlock?: () => PageBlockEvidence | null): WebGl2Probe {
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
  let evidence: PageBlockEvidence | null = null;
  try { evidence = pageBlock?.() ?? null; } catch { evidence = null; }
  const cause = classifyWebGlFailure({ status, webgl1: !!v1.ctx, webgl1Renderer, canvas2d: !!c2d.ctx, pageBlock: evidence });
  return { renderer: null, webgl2: false, failure: { cause, status: cleanWebGlStatus(status) } };
}

/**
 * BUG.webgl-crash-block-wait — one quiet WebGL 2 attempt, for the wait after a graphics crash
 * (boot/Capability.ts runCapabilityGate): true when a context could be created. The context is
 * released at once through WEBGL_lose_context, a loss the page asks for, which Chromium does not
 * count against the site (only a loss the GPU process reports does).
 */
export function canCreateWebGl2(makeCanvas: () => ProbeCanvas): boolean {
  const { ctx } = tryContext(makeCanvas, 'webgl2');
  if (!ctx) return false;
  releaseGl(ctx);
  return true;
}

// ── BUG.webgl-blocked-in-page: is getContext still the browser's own? ──

type AnyFn = (...args: unknown[]) => unknown;

/** The minimal window surface pageBlockEvidence reads (a real Window, or a test stub). */
export interface PageBlockWindow {
  document?: { createElement(tag: string): unknown; documentElement?: unknown; body?: unknown } | null;
  HTMLCanvasElement?: { prototype: { getContext?: unknown } } | null;
  OffscreenCanvas?: (new (w: number, h: number) => ProbeCanvas) & { prototype: { getContext?: unknown } } | null;
  Function?: { prototype: { toString: AnyFn } } | null;
}

/**
 * True when `fn` reads as a browser built-in: `function getContext() { [native code] }` (Firefox splits it
 * over lines). `toString` should come from a realm the page's scripts did not touch, so a patch that also
 * fakes Function.prototype.toString in the page is still seen.
 */
export function isNativeFunction(fn: unknown, toString: AnyFn, name = 'getContext'): boolean {
  if (typeof fn !== 'function') return false;
  let src: string;
  try { src = String(toString.call(fn)); } catch { return false; }
  return new RegExp(`^function\\s+${name}\\s*\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}$`).test(src.trim());
}

/** One WebGL 2 attempt through `getContext` called on `canvas`, released at once. */
function tryNativeWebGl2(getContext: unknown, canvas: unknown): boolean {
  if (typeof getContext !== 'function' || !canvas) return false;
  try {
    const gl = (getContext as AnyFn).call(canvas, 'webgl2');
    if (!gl) return false;
    releaseGl(gl);
    return true;
  } catch { return false; }
}

interface FrameLike { style?: { display?: string }; contentWindow?: PageBlockWindow | null; remove?(): void }

/**
 * Look for a page-level WebGL block (see the file comment): a hidden about:blank iframe gives an untouched
 * Function.prototype.toString to judge the page's getContext with, and its own canvas tries WebGL 2 there;
 * an OffscreenCanvas tries it too when its getContext is still native. Best effort: anything that throws
 * counts as no evidence.
 */
export function pageBlockEvidence(win: PageBlockWindow): PageBlockEvidence {
  let patched = false;
  let freshRealmWebGl2 = false;
  const pageGetContext = win.HTMLCanvasElement?.prototype?.getContext;
  let frame: FrameLike | null = null;
  try {
    let toString: AnyFn | null = win.Function?.prototype?.toString ?? null;
    const doc = win.document;
    const host = (doc?.body ?? doc?.documentElement) as { appendChild?(n: unknown): unknown } | null | undefined;
    if (doc && host?.appendChild) {
      frame = doc.createElement('iframe') as FrameLike;
      if (frame.style) frame.style.display = 'none';
      host.appendChild(frame);
      const fresh = frame.contentWindow ?? null;
      const freshToString = fresh?.Function?.prototype?.toString;
      if (typeof freshToString === 'function') toString = freshToString;
      const freshGetContext = fresh?.HTMLCanvasElement?.prototype?.getContext;
      if (fresh?.document && isNativeFunction(freshGetContext, toString ?? freshToString as AnyFn)) {
        freshRealmWebGl2 = tryNativeWebGl2(freshGetContext, fresh.document.createElement('canvas'));
      }
    }
    if (toString) {
      if (pageGetContext !== undefined && !isNativeFunction(pageGetContext, toString)) patched = true;
      const off = win.OffscreenCanvas;
      const offGetContext = off?.prototype?.getContext;
      // Only HTMLCanvasElement's getContext ran in the probe, so only it decides `patched`; OffscreenCanvas is a
      // second place to try WebGL 2, used when the patch left it alone.
      if (off && !freshRealmWebGl2 && isNativeFunction(offGetContext, toString)) {
        try { freshRealmWebGl2 = tryNativeWebGl2(offGetContext, new off(1, 1)); } catch { /* no evidence */ }
      }
    }
  } catch { /* best effort */ } finally {
    try { frame?.remove?.(); } catch { /* best effort */ }
  }
  return { patched, freshRealmWebGl2 };
}

// ── Platform ──────────────────────────────────────────────────────────

export type HelpOs = 'windows' | 'mac' | 'linux' | 'linux_arm' | 'chromeos' | 'other';
export type HelpBrowser = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';
export interface HelpPlatform {
  os: HelpOs; browser: HelpBrowser;
  /** BUG.webgl-blocked-in-page — a Chromium browser that names its private window and its own blocking differently. Absent = neither. */
  chromiumBrand?: 'brave' | 'opera';
}

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
  // Brave's UA string is Chrome's; only its client-hint brand says Brave. Opera adds OPR/ to the UA.
  const chromiumBrand = browser === 'chrome'
    ? (brands.some(b => b.includes('brave')) ? 'brave' : brands.some(b => b.includes('opera')) || /\bOPR\//.test(ua) ? 'opera' : undefined)
    : undefined;
  return chromiumBrand ? { os, browser, chromiumBrand } : { os, browser };
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
  // Firefox's hardware-acceleration checkbox only sets the compositor; it does not decide whether WebGL may use
  // the graphics card (WebGLContext::CreateAndInitGL reads it only for the power preference), so it gets no step here.
  return null;
}

function driverStep(os: HelpOs, browser: HelpBrowser): string {
  const restart = browser === 'firefox' ? 'restart Firefox' : 'restart the browser';
  return os === 'windows'
    ? `Install the latest graphics driver from your graphics card's maker (Intel, AMD or NVIDIA), then ${restart}.`
    : `Update your graphics driver, then ${restart}.`;
}

const FIREFOX_SUPPORT = 'about:support (the Graphics section) shows why Firefox turned WebGL off. '
  + 'Setting webgl.force-enabled to true in about:config can override it, at your own risk: it may be unstable on this graphics driver.';

/**
 * BUG.webgl-crash-block-wait — Chromium blocks 3D for a site that lost two or more contexts to a GPU
 * crash, and each recorded loss expires after kBlockedDomainExpirationPeriod = base::Minutes(2)
 * (content/browser/gpu/gpu_data_manager_impl_private.cc, Are3DAPIsBlockedAtTime): no restart is
 * needed, and the page waits it out by itself (Capability.ts). The status string that names this
 * cause is Chromium's alone, so only a Chromium browser reaches it.
 */
function crashBlockText(browser: HelpBrowser): string {
  const name = browser === 'edge' ? 'Edge' : browser === 'chrome' ? 'Chrome' : 'the browser';
  return `After a graphics crash, ${name} turns graphics off for this site for up to two minutes. `
    + 'The game will continue by itself when they come back. If it doesn\'t, press Reload. '
    + 'If it keeps happening, update your graphics driver.';
}

const RESTART = 'If the game worked before in this browser, quit the browser completely and start it again: after a '
  + 'graphics crash the browser turns graphics off for the site until it restarts';

/**
 * BUG.webgl-blocked-in-page — a page script (almost always a privacy or anti-fingerprinting extension)
 * replaced getContext: allow WebGL for the site in it, or check in a private window, where each of these
 * browsers runs extensions only when the player allowed them there.
 */
function blockedInPageText(platform: HelpPlatform, site: string): string[] {
  const allow = `Allow WebGL for ${site} in that extension, or turn the extension off for this site, then press Reload.`;
  if (platform.browser === 'firefox') {
    return ['A Firefox add-on is blocking WebGL on this site (privacy and anti-fingerprinting add-ons do this).',
      `Allow WebGL for ${site} in that add-on, or turn the add-on off for this site, then press Reload.`,
      'To check, open this page in a Private Window, where add-ons are off unless you allowed them.'];
  }
  if (platform.browser === 'safari') {
    return ['A Safari extension is blocking WebGL on this site (privacy and anti-fingerprinting extensions do this).',
      allow, 'To check, open this page in a Private Window, where extensions are off unless you allowed them.'];
  }
  if (platform.chromiumBrand === 'brave') {
    return ['A browser extension or Brave Shields is blocking WebGL on this site.',
      `Click the Brave Shields button in the address bar and turn Shields off for this site, or allow WebGL for ${site} in the extension, then press Reload.`];
  }
  const privateWindow = platform.browser === 'edge' ? 'an InPrivate window' : platform.chromiumBrand === 'opera' ? 'a private window'
    : platform.browser === 'chrome' ? 'an Incognito window' : 'a private window';
  return ['A browser extension is blocking WebGL on this site (privacy and anti-fingerprinting extensions do this).',
    allow, `To check, open this page in ${privateWindow}, where extensions are off unless you allowed them.`];
}

/**
 * The player-facing explanation for a WebGL 2 failure, most likely fix first. `site` names the host in the
 * page-block advice (the page's own hostname; "this site" when unknown).
 */
export function webgl2HelpText(failure: WebGlFailure | null, platform: HelpPlatform, site = 'this site'): string {
  const { os, browser } = platform;
  const chromium = browser === 'chrome' || browser === 'edge';
  const gpuPage = browser === 'edge' ? 'edge://gpu' : 'chrome://gpu';
  const tryFirefox = os === 'linux' || os === 'linux_arm' || os === 'windows' ? 'Or try Firefox, which may work on this computer.' : null;
  const parts: Array<string | null> = [INTRO];
  const cause = failure?.cause ?? 'unknown';
  switch (cause) {
    case 'context_lost_after_crash':
      parts.push(crashBlockText(browser));
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
    case 'webgl2_blocked':
      parts.push(`${browser === 'firefox' ? 'Firefox' : 'The browser'} has turned WebGL 2 off because it doesn't recognise this computer's graphics driver`
        + (os === 'windows' ? ' (usually no graphics driver is installed, and Windows is using "Microsoft Basic Display Adapter", or this is a virtual machine).' : '.'),
      driverStep(os, browser),
      browser === 'firefox' ? 'Or open about:config, set webgl.force-enabled to true, and reload this page (at your own risk: it may be slow or unstable).' : null);
      break;
    case 'webgl_turned_off':
      parts.push(browser === 'firefox'
        ? 'WebGL is turned off in Firefox. Open about:config, set webgl.disabled to false, and reload this page. If Firefox is in Troubleshoot Mode, restart it normally.'
        : 'WebGL is turned off in this browser\'s settings. Turn it back on and reload this page.');
      break;
    case 'acceleration_disabled':
      if (browser === 'firefox') {
        parts.push('Firefox is drawing without the graphics card, which usually means it can\'t use this computer\'s graphics driver.',
          driverStep(os, browser), FIREFOX_SUPPORT);
        break;
      }
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
      if (browser === 'firefox') {
        // webgl.enable-webgl2 = false is silent (no creation-error event), so it lands here.
        parts.push('It can only start the older WebGL 1.', 'Open about:config, check that webgl.enable-webgl2 is true, and reload this page.',
          'If it is, update Firefox and your graphics driver.');
        break;
      }
      parts.push('It can only start the older WebGL 1, which usually means an old graphics driver or browser.',
        'Update the browser and your graphics driver.',
        chromium ? `If that doesn't help: ${flagsStep(browser)}` : 'Or try a current Chrome or Firefox.');
      break;
    case 'blocked_in_page':
      parts.push(...blockedInPageText(platform, site));
      break;
    case 'no_webgl':
      if (browser === 'firefox') {
        parts.push('WebGL is turned off or blocked in Firefox.', 'Open about:config, check that webgl.disabled is false, and allow WebGL for this site in any privacy add-on.', FIREFOX_SUPPORT);
        break;
      }
      // BUG.webgl-blocked-in-page: an extension that blocks WebGL without leaving a trace the probe can see
      // also lands here, so a Chromium player gets the private-window check before the settings.
      parts.push('WebGL is turned off or unavailable in this browser.',
        chromium ? `A browser extension (privacy or anti-fingerprinting) can cause this: if this page works in ${browser === 'edge' ? 'an InPrivate' : 'an Incognito'} window, allow WebGL for this site in the extension.` : null,
        accelerationStep(browser) ?? 'Make sure hardware (graphics) acceleration is turned on in the browser settings.',
        chromium ? `${gpuPage} shows whether WebGL is disabled and why.` : 'Or try a current Chrome, Edge or Firefox.');
      break;
    default:
      parts.push('Use a current Chrome, Edge, Firefox or Safari on a desktop or laptop, and make sure hardware acceleration '
        + '(graphics acceleration) is turned on in the browser settings.',
      `${RESTART} (in Chrome, chrome://gpu shows it).`, 'If it keeps happening, update your graphics driver.');
  }
  if (os === 'windows' && browser !== 'firefox' && (cause === 'blocklisted' || cause === 'acceleration_disabled' || cause === 'gpu_process_unavailable' || cause === 'no_webgl')) {
    parts.push(WORK_PC);
  }
  return parts.filter((p): p is string => !!p).join(' ');
}
