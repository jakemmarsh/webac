/**
 * A recording stand-in for a WebGL2 context, enough for a real
 * THREE.WebGLRenderer to construct and render in Node (no GPU, no
 * headless-gl). Every call is a no-op returning a plausible value; the
 * calls that matter for frame-structure tests are recorded:
 *   - clear(mask): each mask, so a test can see which buffers a frame wiped;
 *   - createProgram / useProgram: program creation and switches;
 *   - link waits: the first query of a linked program's results
 *     (getProgramInfoLog / getProgramParameter / getActiveUniform / uniform or
 *     attribute locations), where a real driver without
 *     KHR_parallel_shader_compile makes the caller wait for the link.
 * three.js's own code decides when to clear, which program a material gets
 * and when lights force a program change, so a test of a render pass
 * structure (scene/IndoorView.ts) drives the shipped three.js paths.
 */
import * as THREE from 'three';

export const GL_DEPTH_BUFFER_BIT = 0x0100;
export const GL_STENCIL_BUFFER_BIT = 0x0400;
export const GL_COLOR_BUFFER_BIT = 0x4000;

export interface StubGlLog {
  /** clear() masks, in order. */
  clears: number[];
  /** createProgram() calls. */
  programsCreated: number;
  /** useProgram() calls (three skips the call when the program is already bound). */
  programSwitches: number;
  /** drawElements / drawArrays calls. */
  draws: number;
  /** Programs whose link result was first queried (each one a synchronous link wait on a real driver). */
  linkWaits: number;
}

export interface StubGlOptions {
  /** Extensions getExtension returns (default none: e.g. no KHR_parallel_shader_compile, as Firefox). */
  extensions?: readonly string[];
  /** Called at each link wait (a test advances its fake clock here to model the link's cost). */
  onLinkWait?: () => void;
}

export interface StubGl {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  log: StubGlLog;
  /** Reset the counters (between a warm-up frame and the measured ones). */
  reset(): void;
}

const REAL_CONSTANTS: Record<string, number> = {
  DEPTH_BUFFER_BIT: GL_DEPTH_BUFFER_BIT,
  STENCIL_BUFFER_BIT: GL_STENCIL_BUFFER_BIT,
  COLOR_BUFFER_BIT: GL_COLOR_BUFFER_BIT,
  NO_ERROR: 0,
};

export function createStubGl(width = 64, height = 64, opts: StubGlOptions = {}): StubGl {
  const log: StubGlLog = { clears: [], programsCreated: 0, programSwitches: 0, draws: 0, linkWaits: 0 };
  const exts = new Set(opts.extensions ?? []);
  /** Linked programs whose result nobody has asked for yet. */
  const unwaited = new WeakSet<object>();
  const waitFor = (program: unknown): void => {
    if (program && typeof program === 'object' && unwaited.has(program)) {
      unwaited.delete(program);
      log.linkWaits++;
      opts.onLinkWait?.();
    }
  };
  const constants = new Map<string, number>();
  let nextConstant = 0x10000;
  const constant = (name: string): number => {
    if (name in REAL_CONSTANTS) return REAL_CONSTANTS[name];
    let v = constants.get(name);
    if (v === undefined) { v = nextConstant++; constants.set(name, v); }
    return v;
  };
  const C = (name: string) => constant(name);
  const canvas = {
    width, height, style: {} as CSSStyleDeclaration,
    addEventListener() {}, removeEventListener() {},
    getContext: () => proxy,
    clientWidth: width, clientHeight: height,
  } as unknown as HTMLCanvasElement;

  const impl: Record<string, unknown> = {
    canvas,
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    drawingBufferColorSpace: 'srgb',
    getContextAttributes: () => ({ alpha: false, antialias: false, depth: true, stencil: true, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false }),
    isContextLost: () => false,
    getExtension: (name: string) => (exts.has(name) ? {} : null),
    getSupportedExtensions: () => [...exts],
    getError: () => 0,
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    getParameter: (p: number) => {
      if (p === C('VERSION')) return 'WebGL 2.0';
      if (p === C('SHADING_LANGUAGE_VERSION')) return 'WebGL GLSL ES 3.00';
      if (p === C('VENDOR') || p === C('RENDERER')) return 'stub';
      if (p === C('SCISSOR_BOX') || p === C('VIEWPORT')) return new Int32Array([0, 0, width, height]);
      if (p === C('MAX_SAMPLES')) return 4;
      if (p === C('MAX_TEXTURE_SIZE') || p === C('MAX_CUBE_MAP_TEXTURE_SIZE') || p === C('MAX_RENDERBUFFER_SIZE')) return 4096;
      if (p === C('MAX_VIEWPORT_DIMS')) return new Int32Array([4096, 4096]);
      if (p === C('MAX_VERTEX_UNIFORM_VECTORS') || p === C('MAX_FRAGMENT_UNIFORM_VECTORS')) return 1024;
      return 16;
    },
    createProgram: () => { log.programsCreated++; return {}; },
    linkProgram: (program: object) => { unwaited.add(program); },
    useProgram: () => { log.programSwitches++; },
    clear: (mask: number) => { log.clears.push(mask); },
    drawElements: () => { log.draws++; },
    drawArrays: () => { log.draws++; },
    drawElementsInstanced: () => { log.draws++; },
    drawArraysInstanced: () => { log.draws++; },
    createShader: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    createRenderbuffer: () => ({}),
    createVertexArray: () => ({}),
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    getShaderSource: () => '',
    getProgramInfoLog: (program: unknown) => { waitFor(program); return ''; },
    getProgramParameter: (program: unknown, pname: number) => {
      // COMPLETION_STATUS_KHR (0x91B1) is the extension's non-blocking poll.
      if (pname !== 0x91b1) waitFor(program);
      if (pname === C('ACTIVE_UNIFORMS') || pname === C('ACTIVE_ATTRIBUTES')) return 0;
      return true;
    },
    getActiveUniform: (program: unknown) => { waitFor(program); return null; },
    getUniformLocation: (program: unknown) => { waitFor(program); return null; },
    getAttribLocation: (program: unknown) => { waitFor(program); return -1; },
    checkFramebufferStatus: () => C('FRAMEBUFFER_COMPLETE'),
  };
  const proxy = new Proxy(impl, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return constant(prop);
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;

  return {
    gl: proxy, canvas, log,
    reset() { log.clears.length = 0; log.programsCreated = 0; log.programSwitches = 0; log.draws = 0; log.linkWaits = 0; },
  };
}

/** A real three.js WebGLRenderer on a stub context (stencil on, as SceneManager.initRenderer makes it). */
export function createStubRenderer(width = 64, height = 64, opts: StubGlOptions = {}): { renderer: THREE.WebGLRenderer; stub: StubGl } {
  const stub = createStubGl(width, height, opts);
  const renderer = new THREE.WebGLRenderer({ canvas: stub.canvas, context: stub.gl, stencil: true });
  renderer.setSize(width, height, false);
  return { renderer, stub };
}
