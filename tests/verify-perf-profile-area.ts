/** tools/lib/profile-area — perf-profile's area buckets. */
import { describe, it, expect } from 'vitest';
import { profileArea } from '../tools/lib/profile-area.js';

const THREE_URL = 'http://localhost:3000/node_modules/.vite/deps/three.js?v=1';

describe('profileArea', () => {
  it('splits three.js into draw submission, scene graph, raycast and other', () => {
    expect(profileArea({ functionName: 'WebGLRenderer.renderBufferDirect', url: THREE_URL })).toBe('three.js: draw submission');
    expect(profileArea({ functionName: 'setValueV3f', url: THREE_URL })).toBe('three.js: draw submission');
    expect(profileArea({ functionName: 'updateMatrixWorld', url: THREE_URL })).toBe('three.js: scene graph');
    expect(profileArea({ functionName: 'projectObject', url: 'http://localhost:3000/node_modules/three/src/renderers/WebGLRenderer.js' })).toBe('three.js: scene graph');
    expect(profileArea({ functionName: 'raycast', url: THREE_URL })).toBe('three.js: raycast');
    expect(profileArea({ functionName: 'somethingElse', url: THREE_URL })).toBe('three.js: other');
  });
  it('buckets game code by folder (Vite serves the renderer from /src), other packages, GC and idle', () => {
    expect(profileArea({ functionName: 'tick', url: 'http://localhost:3000/src/animation/AnimationSequencer.ts' })).toBe('game: animation');
    expect(profileArea({ functionName: 'frame', url: 'http://localhost:3000/src/main.ts?t=5' })).toBe('game: (root)');
    expect(profileArea({ functionName: 'read', url: 'http://localhost:3000/@fs/Users/x/acjs/packages/dat-parser/src/DatReader.ts' })).toBe('game: @ac/dat-parser');
    expect(profileArea({ functionName: 'x', url: 'http://localhost:3000/node_modules/.vite/deps/idb.js' })).toBe('other deps');
    expect(profileArea({ functionName: '(garbage collector)', url: '' })).toBe('gc');
    expect(profileArea({ functionName: '(idle)', url: '' })).toBe('idle');
    expect(profileArea({ functionName: '(program)', url: '' })).toBe('browser (program)');
    expect(profileArea({ functionName: 'drawElements', url: '' })).toBe('native');
  });
});
