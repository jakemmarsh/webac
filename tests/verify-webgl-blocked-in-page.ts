/**
 * BUG.webgl-blocked-in-page — prod 2026-11-17: five Chrome 148-150 boots stopped on "no_webgl" (WebGL 2 and 1
 * both null, no creation-error statusMessage, 2D fine), and the screen sent players to the acceleration
 * setting. The lead reproduced the exact shape with a page-world script overriding
 * HTMLCanvasElement.prototype.getContext to return null for WebGL (what privacy / anti-fingerprinting
 * extensions do). This drives the real boot/WebGlDiagnosis.ts + Capability.ts with fake realms whose
 * getContext is or is not the browser's own function.
 */
import { describe, it, expect } from 'vitest';
import {
  probeWebGl2, classifyWebGlFailure, detectHelpPlatform, webgl2HelpText, pageBlockEvidence, isNativeFunction,
  WEBGL_FAILURE_CAUSES, type PageBlockWindow,
} from '../packages/renderer/src/boot/WebGlDiagnosis.js';
import { capabilityProblems, probeCapabilities } from '../packages/renderer/src/boot/Capability.js';
import { sanitizeClientError, WEBGL_FAILURE_CAUSES as BRIDGE_CAUSES } from '../services/ws-tcp-bridge/src/clientErrors.js';

const DEBUG_RENDERER = 0x9246;
function fakeGl(renderer: string) {
  return {
    getExtension(name: string) {
      if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: DEBUG_RENDERER };
      if (name === 'WEBGL_lose_context') return { loseContext: () => {} };
      return null;
    },
    getParameter(p: number) { return p === DEBUG_RENDERER ? renderer : null; },
  };
}

const NATIVE_SRC = 'function getContext() { [native code] }';
const CHROME_WIN = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', userAgentData: { platform: 'Windows', brands: [{ brand: 'Google Chrome' }, { brand: 'Chromium' }] } };
const CHROME_MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36', userAgentData: { platform: 'macOS', brands: [{ brand: 'Google Chrome' }, { brand: 'Chromium' }] } };
const EDGE_WIN = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0', userAgentData: { platform: 'Windows', brands: [{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }] } };
const BRAVE_MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', userAgentData: { platform: 'macOS', brands: [{ brand: 'Brave' }, { brand: 'Chromium' }] } };
const OPERA_WIN = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 OPR/120.0.0.0', userAgentData: { platform: 'Windows', brands: [{ brand: 'Opera' }, { brand: 'Chromium' }] } };
const FIREFOX_WIN = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0' };
const SAFARI_MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' };
const CHROME_NO_GPU = 'Could not create a WebGL2 context, VENDOR = 0xffff, DEVICE = 0xffff, GL_VENDOR = Disabled, GL_RENDERER = Disabled, GL_VERSION = Disabled, Sandboxed = no, ErrorMessage = OffscreenContext Creation failed, GpuChannelHost creation failed.';

/** Every fake realm's built-ins: an untouched Function.prototype.toString reports "[native code]" for any of
 * them, across realms, as a browser's does. */
const natives = new Set<unknown>();

/** A realm (window). `spoofToString` makes this realm's toString lie about the extension's wrapper too. */
function realm(opts: { webgl2Works: boolean; getContextPatched: boolean; offscreen?: 'none' | 'works' | 'fails' | 'patched'; spoofToString?: boolean }) {
  const nativeGetContext = function getContext(this: unknown, kind: string): unknown {
    if (kind === '2d') return {};
    return kind === 'webgl2' && opts.webgl2Works ? fakeGl('ANGLE (Apple, Apple M2, OpenGL 4.1)') : null;
  };
  natives.add(nativeGetContext);
  // What the extension installs: a JS wrapper that returns null for WebGL and passes the rest through.
  const patched = function getContext(this: unknown, kind: string): unknown { return /webgl/.test(kind) ? null : nativeGetContext.call(this, kind); };
  const getContext = opts.getContextPatched ? patched : nativeGetContext;
  const toString = function toString(this: unknown) {
    if (opts.spoofToString && this === patched) return NATIVE_SRC;
    return natives.has(this) ? NATIVE_SRC : 'function getContext(kind) { return null; }';
  };
  natives.add(toString);
  let Offscreen: unknown = null;
  if (opts.offscreen && opts.offscreen !== 'none') {
    const offNative = function getContext(this: unknown, kind: string) { return kind === 'webgl2' && opts.offscreen === 'works' ? fakeGl('ANGLE (Apple, Apple M2, OpenGL 4.1)') : null; };
    natives.add(offNative);
    const C = function OffscreenCanvas() {} as unknown as { prototype: { getContext: unknown } };
    C.prototype.getContext = opts.offscreen === 'patched' ? function getContext() { return null; } : offNative;
    Offscreen = C;
  }
  return {
    HTMLCanvasElement: { prototype: { getContext } },
    OffscreenCanvas: Offscreen,
    Function: { prototype: { toString } },
    /** The page's canvases: getContext is whatever the prototype holds now. */
    canvasFactory: () => ({ getContext: (kind: string) => getContext.call({}, kind) }),
  };
}

/** A page window; `frame` is the realm a fresh about:blank iframe gets (null: no contentWindow). */
function pageWindow(page: ReturnType<typeof realm>, frame: ReturnType<typeof realm> | null) {
  const state = { removed: 0, appended: 0 };
  const win = {
    HTMLCanvasElement: page.HTMLCanvasElement,
    OffscreenCanvas: page.OffscreenCanvas,
    Function: page.Function,
    document: {
      body: { appendChild: (n: unknown) => { state.appended++; return n; } },
      createElement: (tag: string) => tag === 'iframe'
        ? { style: {}, contentWindow: frame ? { ...frame, document: { createElement: () => ({}) } } : null, remove: () => { state.removed++; } }
        : page.canvasFactory(),
    },
  } as unknown as PageBlockWindow;
  return { win, state };
}

describe('BUG.webgl-blocked-in-page — detecting an extension\'s getContext override', () => {
  it('isNativeFunction: the browser\'s own getContext only, Chrome and Firefox formatting', () => {
    const ts = (src: string) => function toString() { return src; };
    expect(isNativeFunction(() => null, ts('function getContext() { [native code] }'))).toBe(true);
    expect(isNativeFunction(() => null, ts('function getContext() {\n    [native code]\n}'))).toBe(true);
    // A Proxy or bound wrapper reads as an anonymous native function: not getContext.
    expect(isNativeFunction(() => null, ts('function () { [native code] }'))).toBe(false);
    expect(isNativeFunction(() => null, ts('function getContext(t) { return null }'))).toBe(false);
    expect(isNativeFunction(undefined, ts(NATIVE_SRC))).toBe(false);
    expect(isNativeFunction(() => null, () => { throw new Error('x'); })).toBe(false);
  });

  it('prod shape: patched getContext, the iframe patched too → blocked_in_page (was no_webgl); the iframe is removed', () => {
    const page = realm({ webgl2Works: true, getContextPatched: true });
    const frame = realm({ webgl2Works: true, getContextPatched: true });
    const w = pageWindow(page, frame);
    expect(pageBlockEvidence(w.win)).toEqual({ patched: true, freshRealmWebGl2: false });
    expect(w.state).toEqual({ appended: 1, removed: 1 });
    const p = probeWebGl2(page.canvasFactory, () => pageBlockEvidence(pageWindow(page, frame).win));
    expect(p).toEqual({ webgl2: false, renderer: null, failure: { cause: 'blocked_in_page', status: null } });
    // Without the evidence the same browser still reads as before.
    expect(probeWebGl2(page.canvasFactory).failure?.cause).toBe('no_webgl');
  });

  it('a toString-spoofing patch is still caught: the iframe realm\'s untouched toString judges it, and the iframe draws', () => {
    const page = realm({ webgl2Works: true, getContextPatched: true, spoofToString: true });
    const frame = realm({ webgl2Works: true, getContextPatched: false });
    // The page's own (spoofed) toString would call the wrapper native.
    expect(isNativeFunction(page.HTMLCanvasElement.prototype.getContext, page.Function.prototype.toString)).toBe(true);
    expect(pageBlockEvidence(pageWindow(page, frame).win)).toEqual({ patched: true, freshRealmWebGl2: true });
  });

  it('a fresh place that creates WebGL 2 decides it on its own; OffscreenCanvas is tried when the patch left it alone', () => {
    expect(classifyWebGlFailure({ status: null, webgl1: true, webgl1Renderer: 'SwiftShader', canvas2d: true, pageBlock: { patched: false, freshRealmWebGl2: true } }))
      .toBe('blocked_in_page');
    // No iframe realm, page toString spoofed: OffscreenCanvas (native) creates WebGL 2.
    const withOff = realm({ webgl2Works: true, getContextPatched: true, spoofToString: true, offscreen: 'works' });
    expect(pageBlockEvidence(pageWindow(withOff, null).win)).toEqual({ patched: false, freshRealmWebGl2: true });
    // A patched OffscreenCanvas is not tried, and does not mark the probe's (native) getContext patched.
    const offPatched = realm({ webgl2Works: false, getContextPatched: false, offscreen: 'patched' });
    expect(pageBlockEvidence(pageWindow(offPatched, null).win)).toEqual({ patched: false, freshRealmWebGl2: false });
  });

  it('a real failure is never blamed on the page: native getContext and every fresh place fails too', () => {
    const page = realm({ webgl2Works: false, getContextPatched: false, offscreen: 'fails' });
    const frame = realm({ webgl2Works: false, getContextPatched: false });
    expect(pageBlockEvidence(pageWindow(page, frame).win)).toEqual({ patched: false, freshRealmWebGl2: false });
    expect(probeWebGl2(page.canvasFactory, () => pageBlockEvidence(pageWindow(page, frame).win)).failure?.cause).toBe('no_webgl');
  });

  it('a browser reason wins over a pass-through wrapper (e.g. a WebGL debugger extension)', () => {
    const wrapped = { patched: true, freshRealmWebGl2: false };
    const base = { webgl1: false, webgl1Renderer: null, canvas2d: true };
    expect(classifyWebGlFailure({ ...base, status: 'disabled by enterprise policy or commandline switch', pageBlock: wrapped })).toBe('disabled_by_policy');
    expect(classifyWebGlFailure({ ...base, status: CHROME_NO_GPU, pageBlock: wrapped })).toBe('gpu_process_unavailable');
    expect(classifyWebGlFailure({ ...base, status: 'Web page caused context loss and was blocked', pageBlock: { patched: true, freshRealmWebGl2: true } })).toBe('context_lost_after_crash');
    // A wrapper with WebGL 1 working keeps the WebGL 1 causes (Firefox's webgl.enable-webgl2 = false is silent too).
    expect(classifyWebGlFailure({ status: null, webgl1: true, webgl1Renderer: 'Intel(R) HD Graphics', canvas2d: true, pageBlock: wrapped })).toBe('webgl1_only');
  });

  it('never throws: a broken document or a throwing check is no evidence', () => {
    const bad = { document: { createElement: () => { throw new Error('nope'); }, body: { appendChild: () => null } } } as unknown as PageBlockWindow;
    expect(pageBlockEvidence(bad)).toEqual({ patched: false, freshRealmWebGl2: false });
    const page = realm({ webgl2Works: true, getContextPatched: true });
    expect(probeWebGl2(page.canvasFactory, () => { throw new Error('x'); }).failure?.cause).toBe('no_webgl');
  });

  it('probeCapabilities on the real-page shape → the extension text naming the host, no acceleration advice', () => {
    const page = realm({ webgl2Works: true, getContextPatched: true });
    const frame = realm({ webgl2Works: true, getContextPatched: true });
    const win = {
      ...pageWindow(page, frame).win,
      navigator: { ...CHROME_MAC, webdriver: false },
      WebSocket: function WebSocket() {},
      matchMedia: () => ({ matches: true }),
      location: { search: '', hostname: 'playwebac.com' },
    } as unknown as Parameters<typeof probeCapabilities>[0];
    const env = probeCapabilities(win);
    expect(env.webgl2Failure?.cause).toBe('blocked_in_page');
    expect(env.site).toBe('playwebac.com');
    const text = capabilityProblems(env)[0].text;
    expect(text).toBe('This browser could not start WebGL 2, which the game needs to draw the world. '
      + 'A browser extension is blocking WebGL on this site (privacy and anti-fingerprinting extensions do this). '
      + 'Allow WebGL for playwebac.com in that extension, or turn the extension off for this site, then press Reload. '
      + 'To check, open this page in an Incognito window, where extensions are off unless you allowed them.');
  });
});

describe('BUG.webgl-blocked-in-page — advice per browser, telemetry', () => {
  const blocked = (nav: Parameters<typeof detectHelpPlatform>[0]) =>
    webgl2HelpText({ cause: 'blocked_in_page', status: null }, detectHelpPlatform(nav), 'playwebac.com');

  it('each browser\'s private window, Firefox add-ons, Brave Shields; never hardware advice', () => {
    expect(detectHelpPlatform(BRAVE_MAC)).toEqual({ os: 'mac', browser: 'chrome', chromiumBrand: 'brave' });
    expect(detectHelpPlatform(OPERA_WIN)).toEqual({ os: 'windows', browser: 'chrome', chromiumBrand: 'opera' });
    expect(detectHelpPlatform(CHROME_WIN)).toEqual({ os: 'windows', browser: 'chrome' });
    expect(blocked(CHROME_WIN)).toContain('open this page in an Incognito window, where extensions are off unless you allowed them.');
    expect(blocked(EDGE_WIN)).toContain('an InPrivate window');
    expect(blocked(OPERA_WIN)).toContain('a private window');
    expect(blocked(OPERA_WIN)).not.toContain('Incognito');
    const brave = blocked(BRAVE_MAC);
    expect(brave).toContain('Brave Shields');
    expect(brave).toContain('allow WebGL for playwebac.com in the extension');
    const ff = blocked(FIREFOX_WIN);
    expect(ff).toContain('A Firefox add-on is blocking WebGL');
    expect(ff).toContain('Allow WebGL for playwebac.com in that add-on');
    expect(ff).toContain('Private Window');
    const safari = blocked(SAFARI_MAC);
    expect(safari).toContain('A Safari extension is blocking WebGL');
    expect(safari).toContain('Private Window');
    for (const t of [blocked(CHROME_WIN), blocked(EDGE_WIN), brave, ff, safari, blocked(OPERA_WIN)]) {
      expect(t.startsWith('This browser could not start WebGL 2')).toBe(true);
      expect(t).not.toMatch(/acceleration|graphics driver|flags|work computer|about:config|null|undefined/);
      expect(t.length).toBeLessThan(800);
    }
    expect(webgl2HelpText({ cause: 'blocked_in_page', status: null }, detectHelpPlatform(CHROME_WIN))).toContain('Allow WebGL for this site in that extension');
  });

  it('Chromium no_webgl names extensions beside the acceleration setting; Safari unchanged', () => {
    const chrome = webgl2HelpText({ cause: 'no_webgl', status: null }, detectHelpPlatform(CHROME_MAC));
    expect(chrome).toContain('A browser extension (privacy or anti-fingerprinting) can cause this: if this page works in an Incognito window, allow WebGL for this site in the extension.');
    expect(chrome).toContain('chrome://settings/system');
    expect(chrome).toContain('chrome://gpu shows whether WebGL is disabled and why.');
    expect(webgl2HelpText({ cause: 'no_webgl', status: null }, detectHelpPlatform(EDGE_WIN))).toContain('an InPrivate window');
    expect(webgl2HelpText({ cause: 'no_webgl', status: null }, detectHelpPlatform(SAFARI_MAC))).not.toMatch(/Incognito|extension/);
  });

  it('the bridge keeps the new cause in its boot reports', () => {
    expect(WEBGL_FAILURE_CAUSES).toContain('blocked_in_page');
    expect(BRIDGE_CAUSES).toContain('blocked_in_page');
    expect(sanitizeClientError({ kind: 'boot', message: 'unsupported browser: webgl2 (blocked_in_page)', webglCause: 'blocked_in_page' }))
      .toMatchObject({ webglCause: 'blocked_in_page' });
  });
});
