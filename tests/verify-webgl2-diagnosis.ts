/**
 * BOOT.webgl2-diagnosis — the real boot/WebGlDiagnosis.ts + Capability.ts probe
 * with fake canvases (Node has no WebGL), the advice per cause and platform,
 * the boot report's new fields, and the bridge sanitizer that re-validates them.
 */
import { describe, it, expect } from 'vitest';
import {
  probeWebGl2, classifyWebGlFailure, cleanWebGlStatus, detectHelpPlatform, webgl2HelpText,
  WEBGL_FAILURE_CAUSES, type WebGlFailureCause, type HelpPlatform,
} from '../packages/renderer/src/boot/WebGlDiagnosis.js';
import { capabilityProblems, probeCapabilities } from '../packages/renderer/src/boot/Capability.js';
import { ErrorReporter } from '../packages/renderer/src/telemetry/ErrorReporter.js';
import { sanitizeClientError, WEBGL_FAILURE_CAUSES as BRIDGE_CAUSES } from '../services/ws-tcp-bridge/src/clientErrors.js';

const DEBUG_RENDERER = 0x9246;

function fakeGl(renderer: string | null) {
  let lost = false;
  return {
    get lost() { return lost; },
    getExtension(name: string) {
      if (name === 'WEBGL_debug_renderer_info') return renderer === null ? null : { UNMASKED_RENDERER_WEBGL: DEBUG_RENDERER };
      if (name === 'WEBGL_lose_context') return { loseContext: () => { lost = true; } };
      return null;
    },
    getParameter(p: number) { return p === DEBUG_RENDERER ? renderer : null; },
  };
}

interface FakeBrowser {
  webgl2?: { renderer: string | null } | null;
  webgl1?: { renderer: string | null } | null;
  canvas2d?: boolean;
  /** statusMessage fired synchronously inside getContext for each failing WebGL kind. */
  status?: string | null;
  /** getContext throws instead of returning null. */
  throws?: boolean;
}

/** A canvas factory that behaves like a browser: the creation-error event fires inside getContext. */
function fakeCanvases(b: FakeBrowser) {
  const made: Array<{ kinds: string[] }> = [];
  const factory = () => {
    const listeners: Array<(ev: Event) => void> = [];
    const rec = { kinds: [] as string[] };
    made.push(rec);
    return {
      addEventListener(type: string, l: (ev: Event) => void) { if (type === 'webglcontextcreationerror') listeners.push(l); },
      getContext(kind: string) {
        rec.kinds.push(kind);
        if (b.throws) throw new Error('boom');
        if (kind === '2d') return b.canvas2d === false ? null : {};
        const ok = kind === 'webgl2' ? b.webgl2 : b.webgl1;
        if (ok) return fakeGl(ok.renderer);
        if (b.status) for (const l of listeners) l({ type: 'webglcontextcreationerror', statusMessage: b.status } as unknown as Event);
        return null;
      },
    };
  };
  return { factory, made };
}

const CHROME_WIN = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', userAgentData: { platform: 'Windows', brands: [{ brand: 'Google Chrome' }, { brand: 'Chromium' }] } };
const CHROME_PI = { userAgent: 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', userAgentData: { platform: 'Linux', brands: [{ brand: 'Chromium' }] } };
const EDGE_WIN = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0', userAgentData: { platform: 'Windows', brands: [{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }] } };
const FIREFOX_LINUX = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' };
const SAFARI_MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' };
const CHROMEOS = { userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36' };

const CHROME_NO_GPU = 'Could not create a WebGL2 context, VENDOR = 0xffff, DEVICE = 0xffff, GL_VENDOR = Disabled, GL_RENDERER = Disabled, GL_VERSION = Disabled, Sandboxed = no, ErrorMessage = OffscreenContext Creation failed, GpuChannelHost creation failed.';

describe('BOOT.webgl2-diagnosis — probing with fake canvases', () => {
  it('a working WebGL 2 context: no failure, renderer read, context released, nothing else probed', () => {
    const { factory, made } = fakeCanvases({ webgl2: { renderer: 'ANGLE (NVIDIA GeForce RTX 3080)' } });
    const p = probeWebGl2(factory);
    expect(p).toEqual({ webgl2: true, renderer: 'ANGLE (NVIDIA GeForce RTX 3080)', failure: null });
    expect(made.flatMap(m => m.kinds)).toEqual(['webgl2']);
  });

  const cases: Array<[string, FakeBrowser, WebGlFailureCause]> = [
    ['Chrome after a GPU crash (page blocked)', { status: 'Web page caused context loss and was blocked' }, 'context_lost_after_crash'],
    ['Firefox blocklist entry', { status: 'WebGL creation failed: * Refused to create native OpenGL context because of blocklist entry: FEATURE_FAILURE_OPENGL_1' }, 'blocklisted'],
    ['Chrome WebGL turned off by policy/switch (--disable-3d-apis, live 2026-10-17)', { status: 'disabled by enterprise policy or commandline switch' }, 'disabled_by_policy'],
    ['WebGL 1 on SwiftShader only (acceleration off)', { webgl1: { renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)' } }, 'acceleration_disabled'],
    ['WebGL 1 on llvmpipe only', { webgl1: { renderer: 'llvmpipe (LLVM 15.0.7, 128 bits)' } }, 'acceleration_disabled'],
    ['WebGL 1 on a real GPU but no WebGL 2', { webgl1: { renderer: 'Mali-400 MP' } }, 'webgl1_only'],
    ['Chrome with no GPU process', { status: CHROME_NO_GPU }, 'gpu_process_unavailable'],
    ['no WebGL at all and no reason given', {}, 'no_webgl'],
    ['not even a 2D canvas', { canvas2d: false }, 'unknown'],
    ['an unrecognised reason', { status: 'Something odd happened' }, 'unknown'],
  ];
  for (const [name, browser, cause] of cases) {
    it(`${name} → ${cause}`, () => {
      const { factory, made } = fakeCanvases(browser);
      const p = probeWebGl2(factory);
      expect(p.webgl2).toBe(false);
      expect(p.failure?.cause).toBe(cause);
      // Each context kind gets its own fresh canvas.
      expect(made.map(m => m.kinds)).toEqual([['webgl2'], ['webgl'], ['2d']]);
    });
  }

  it('the statusMessage is captured from the event fired inside getContext, clipped to plain characters', () => {
    const { factory } = fakeCanvases({ status: CHROME_NO_GPU });
    const status = probeWebGl2(factory).failure!.status!;
    expect(status.length).toBeLessThanOrEqual(120);
    // Chromium's reason comes last: the head, GL_VENDOR and the ErrorMessage are kept, '=' is not.
    expect(status).toBe('Could not create a WebGL2 context; GL_VENDOR Disabled; OffscreenContext Creation failed, GpuChannelHost creation failed.');
    expect(cleanWebGlStatus('Web page caused context loss and was blocked')).toBe('Web page caused context loss and was blocked');
    expect(cleanWebGlStatus('x'.repeat(300))).toBe('x'.repeat(120));
    expect(cleanWebGlStatus('  a\n<script>"x"</script>  ')).toBe('a scriptx/script');
    expect(cleanWebGlStatus('<<>>')).toBeNull();
    expect(cleanWebGlStatus(42)).toBeNull();
  });

  it('a getContext that throws is a failed context, not a crash', () => {
    const { factory } = fakeCanvases({ throws: true });
    const p = probeWebGl2(factory);
    expect(p.webgl2).toBe(false);
    expect(p.failure?.cause).toBe('unknown'); // the 2D canvas threw too
  });

  it('classifyWebGlFailure: a crash block wins over everything else', () => {
    expect(classifyWebGlFailure({ status: 'Web page caused context loss and was blocked', webgl1: true, webgl1Renderer: 'SwiftShader', canvas2d: true })).toBe('context_lost_after_crash');
  });

  it('probeCapabilities carries the failure and the platform into capabilityProblems', () => {
    const { factory } = fakeCanvases({ status: CHROME_NO_GPU });
    const win = {
      document: { createElement: factory },
      navigator: { ...CHROME_PI, webdriver: false },
      WebSocket: function WebSocket() {},
      matchMedia: () => ({ matches: true }),
      location: { search: '' },
    } as unknown as Parameters<typeof probeCapabilities>[0];
    const env = probeCapabilities(win);
    expect(env.webgl2).toBe(false);
    expect(env.webgl2Failure?.cause).toBe('gpu_process_unavailable');
    expect(env.platform).toEqual({ os: 'linux_arm', browser: 'chrome' });
    const text = capabilityProblems(env)[0].text;
    expect(text.indexOf('chrome://flags/#ignore-gpu-blocklist')).toBeGreaterThan(-1);
    expect(text.indexOf('chrome://flags/#ignore-gpu-blocklist')).toBeLessThan(text.indexOf('chrome://settings/system'));
  });
});

describe('BOOT.webgl2-diagnosis — platform detection', () => {
  it('reads OS and browser from userAgentData and the user agent', () => {
    expect(detectHelpPlatform(CHROME_WIN)).toEqual({ os: 'windows', browser: 'chrome' });
    expect(detectHelpPlatform(CHROME_PI)).toEqual({ os: 'linux_arm', browser: 'chrome' });
    expect(detectHelpPlatform(EDGE_WIN)).toEqual({ os: 'windows', browser: 'edge' });
    expect(detectHelpPlatform({ userAgent: EDGE_WIN.userAgent })).toEqual({ os: 'windows', browser: 'edge' });
    expect(detectHelpPlatform(FIREFOX_LINUX)).toEqual({ os: 'linux', browser: 'firefox' });
    expect(detectHelpPlatform(SAFARI_MAC)).toEqual({ os: 'mac', browser: 'safari' });
    expect(detectHelpPlatform(CHROMEOS)).toEqual({ os: 'chromeos', browser: 'chrome' });
    expect(detectHelpPlatform(null)).toEqual({ os: 'other', browser: 'other' });
  });
});

describe('BOOT.webgl2-diagnosis — the advice per cause and platform', () => {
  const at = (cause: WebGlFailureCause, nav: Parameters<typeof detectHelpPlatform>[0]) =>
    webgl2HelpText({ cause, status: null }, detectHelpPlatform(nav));
  const before = (text: string, a: string, b: string) => {
    expect(text).toContain(a);
    expect(text).toContain(b);
    expect(text.indexOf(a)).toBeLessThan(text.indexOf(b));
  };

  it('blocklisted Chrome on a Pi: the flags override first, then Firefox; no work-computer line off Windows', () => {
    const t = at('blocklisted', CHROME_PI);
    before(t, 'chrome://flags/#ignore-gpu-blocklist', 'Firefox');
    expect(t).toContain('"Override software rendering list" to Enabled');
    expect(t).toContain('Relaunch');
    expect(t).not.toMatch(/work computer/);
  });

  it('blocklisted Edge uses edge://flags; on Windows the IT-policy line is added', () => {
    const t = at('blocklisted', EDGE_WIN);
    expect(t).toContain('edge://flags/#ignore-gpu-blocklist');
    expect(t).not.toContain('chrome://flags');
    expect(t).toMatch(/On a work computer, graphics may be turned off by your IT policy\.$/);
  });

  it('blocklisted Firefox points at about:support and warns about webgl.force-enabled', () => {
    const t = at('blocklisted', FIREFOX_LINUX);
    expect(t).toContain('about:support');
    expect(t).toMatch(/webgl\.force-enabled.*own risk/);
  });

  it('disabled by policy or a launch switch: the same words on every OS and browser, never flag or settings advice', () => {
    const want = 'This browser could not start WebGL 2, which the game needs to draw the world. Graphics are turned off for this browser by a policy (on a work or school computer, your IT department) or by a setting it was started with. Ask your IT department, or try another browser.';
    for (const nav of [CHROME_WIN, CHROME_PI, EDGE_WIN, FIREFOX_LINUX, SAFARI_MAC, CHROMEOS]) {
      const t = at('disabled_by_policy', nav);
      expect(t).toBe(want);
      expect(t).not.toMatch(/flags|ignore-gpu-blocklist|settings\/system|about:/);
    }
  });

  it('acceleration disabled: each browser\'s own setting', () => {
    expect(at('acceleration_disabled', CHROME_WIN)).toContain('chrome://settings/system');
    expect(at('acceleration_disabled', CHROME_WIN)).toContain('"Use graphics acceleration when available"');
    expect(at('acceleration_disabled', CHROME_WIN)).toMatch(/work computer/);
    expect(at('acceleration_disabled', EDGE_WIN)).toContain('edge://settings/system');
    expect(at('acceleration_disabled', FIREFOX_LINUX)).toMatch(/Settings > General > Performance/);
  });

  it('after a crash: today\'s restart wording, chrome://gpu in Chrome, no IT line', () => {
    const t = at('context_lost_after_crash', CHROME_WIN);
    expect(t).toMatch(/quit the browser completely and start it again/);
    expect(t).toContain('chrome://gpu');
    expect(t).toMatch(/update your graphics driver/);
    expect(t).not.toMatch(/work computer|flags/);
  });

  it('no GPU process: Linux leads with the flags override, Windows with the acceleration setting', () => {
    before(at('gpu_process_unavailable', CHROME_PI), 'ignore-gpu-blocklist', 'chrome://settings/system');
    const win = at('gpu_process_unavailable', CHROME_WIN);
    before(win, 'chrome://settings/system', 'ignore-gpu-blocklist');
    expect(win).toMatch(/work computer/);
  });

  it('WebGL 1 only and no WebGL: update advice; Safari gets no Chrome-only paths', () => {
    expect(at('webgl1_only', CHROME_WIN)).toMatch(/Update the browser and your graphics driver/);
    const safari = at('no_webgl', SAFARI_MAC);
    expect(safari).not.toMatch(/chrome:|edge:|about:/);
  });

  it('every cause on every platform yields one short paragraph that starts with the same sentence', () => {
    for (const cause of WEBGL_FAILURE_CAUSES) {
      for (const nav of [CHROME_WIN, CHROME_PI, EDGE_WIN, FIREFOX_LINUX, SAFARI_MAC, CHROMEOS]) {
        const t = at(cause, nav);
        expect(t.startsWith('This browser could not start WebGL 2')).toBe(true);
        expect(t).not.toMatch(/null|undefined/);
        expect(t.length).toBeLessThan(800);
      }
    }
    const unknown: HelpPlatform = { os: 'other', browser: 'other' };
    expect(webgl2HelpText(null, unknown)).toMatch(/worked before in this browser/);
  });
});

describe('BOOT.webgl2-diagnosis — the boot report and the bridge', () => {
  it('ErrorReporter sends webglCause / webglStatus only when given', () => {
    const sent: Array<Record<string, unknown>> = [];
    const r = new ErrorReporter({ endpoint: 'https://b.example/client-errors', build: 'b', screen: () => 'boot', userAgent: 'UA', send: (_u, body) => sent.push(JSON.parse(body)) });
    r.report('boot', 'unsupported browser: webgl2 (disabled_by_policy)', { webglCause: 'disabled_by_policy', webglStatus: 'disabled by enterprise policy or commandline switch' });
    r.report('boot', 'other');
    expect(sent[0]).toMatchObject({ kind: 'boot', webglCause: 'disabled_by_policy', webglStatus: 'disabled by enterprise policy or commandline switch' });
    expect(sent[1]).not.toHaveProperty('webglCause');
    expect(sent[1]).not.toHaveProperty('webglStatus');
  });

  it('the bridge keeps the same causes as the page', () => {
    expect([...BRIDGE_CAUSES]).toEqual([...WEBGL_FAILURE_CAUSES]);
  });

  it('the sanitizer accepts known causes, re-cleans and clips the status, and drops junk', () => {
    const base = { kind: 'boot', message: 'unsupported browser: webgl2' };
    for (const cause of WEBGL_FAILURE_CAUSES) {
      expect(sanitizeClientError({ ...base, webglCause: cause })?.webglCause).toBe(cause);
    }
    const long = sanitizeClientError({ ...base, webglCause: 'gpu_process_unavailable', webglStatus: `${'x'.repeat(200)}<img src=y>` })!;
    expect(long.webglStatus).toBe('x'.repeat(120));
    expect(sanitizeClientError({ ...base, webglCause: 'unknown', webglStatus: 'a <b>"c"</b> {d}' })!.webglStatus).toBe('a bc/b d');
    const junk = sanitizeClientError({ ...base, webglCause: 'rm -rf', webglStatus: 'x' })!;
    expect(junk).not.toHaveProperty('webglCause');
    expect(junk).not.toHaveProperty('webglStatus'); // no status without a known cause
    expect(sanitizeClientError({ ...base, webglCause: 'disabled_by_policy', webglStatus: 'disabled by enterprise policy or commandline switch' }))
      .toMatchObject({ webglCause: 'disabled_by_policy', webglStatus: 'disabled by enterprise policy or commandline switch' });
    expect(sanitizeClientError({ ...base, webglCause: 'blocklisted', webglStatus: 7 })).not.toHaveProperty('webglStatus');
    expect(sanitizeClientError({ ...base, webglCause: 'blocklisted', webglStatus: '<>' })).not.toHaveProperty('webglStatus');
    expect(sanitizeClientError({ ...base, webglCause: ['blocklisted'] })).not.toHaveProperty('webglCause');
    // A report without the fields is unchanged.
    expect(sanitizeClientError(base)).not.toHaveProperty('webglCause');
  });
});
