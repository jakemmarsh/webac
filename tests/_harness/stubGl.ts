/**
 * A recording stand-in for a WebGL2 context, enough for a real
 * THREE.WebGLRenderer to construct and render in Node (no GPU, no
 * headless-gl). Every call is a no-op returning a plausible value; the
 * calls that matter for frame-structure tests are recorded:
 *   - clear(mask): each mask, so a test can see which buffers a frame wiped;
 *   - createProgram / useProgram: program creation and switches.
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

export function createStubGl(width = 64, height = 64): StubGl {
  const log: StubGlLog = { clears: [], programsCreated: 0, programSwitches: 0, draws: 0 };
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
    getExtension: () => null,
    getSupportedExtensions: () => [],
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
    getProgramInfoLog: () => '',
    getProgramParameter: (_p: unknown, pname: number) => {
      if (pname === C('ACTIVE_UNIFORMS') || pname === C('ACTIVE_ATTRIBUTES')) return 0;
      return true;
    },
    getUniformLocation: () => null,
    getAttribLocation: () => -1,
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
    reset() { log.clears.length = 0; log.programsCreated = 0; log.programSwitches = 0; log.draws = 0; },
  };
}

/** A real three.js WebGLRenderer on a stub context (stencil on, as SceneManager.initRenderer makes it). */
export function createStubRenderer(width = 64, height = 64): { renderer: THREE.WebGLRenderer; stub: StubGl } {
  const stub = createStubGl(width, height);
  const renderer = new THREE.WebGLRenderer({ canvas: stub.canvas, context: stub.gl, stencil: true });
  renderer.setSize(width, height, false);
  return { renderer, stub };
}
