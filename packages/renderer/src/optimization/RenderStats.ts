/**
 * RenderStats — lightweight frame timing and render statistics.
 *
 * Tracks frame rate, draw calls, and memory usage for performance
 * monitoring without the overhead of a full profiler.
 */
export class RenderStats {
  private frameTimes: number[] = [];
  private maxSamples = 60;
  private lastFrameTime = 0;

  /** Record start of a frame. Returns the frame start time. */
  frameStart(): number {
    return performance.now();
  }

  /** Record end of a frame. Pass the value from frameStart(). */
  frameEnd(startTime: number): void {
    const elapsed = performance.now() - startTime;
    this.frameTimes.push(elapsed);
    if (this.frameTimes.length > this.maxSamples) {
      this.frameTimes.shift();
    }
    this.lastFrameTime = elapsed;
  }

  /** Average frame time over recent samples (ms). */
  get avgFrameTime(): number {
    if (this.frameTimes.length === 0) return 0;
    const sum = this.frameTimes.reduce((a, b) => a + b, 0);
    return sum / this.frameTimes.length;
  }

  /** Current FPS estimate. */
  get fps(): number {
    const avg = this.avgFrameTime;
    return avg > 0 ? 1000 / avg : 0;
  }

  /** Last frame time (ms). */
  get lastFrame(): number {
    return this.lastFrameTime;
  }

  /** Get Three.js renderer info (draw calls, triangles, etc.). */
  static getRendererInfo(renderer: { info: { render: { calls: number; triangles: number }; memory: { geometries: number; textures: number } } }): {
    drawCalls: number;
    triangles: number;
    geometries: number;
    textures: number;
  } {
    return {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    };
  }
}
