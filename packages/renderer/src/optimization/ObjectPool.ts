/**
 * ObjectPool — generic object pool for reusing instances.
 *
 * Avoids garbage collection pressure by recycling objects
 * instead of creating new ones. Used for frequently allocated
 * short-lived objects like projectiles, particles, and effects.
 */
export class ObjectPool<T> {
  private pool: T[] = [];
  private active: Set<T> = new Set();
  private factory: () => T;
  private reset: (obj: T) => void;
  private maxPoolSize: number;

  constructor(
    factory: () => T,
    reset: (obj: T) => void,
    maxPoolSize = 256,
  ) {
    this.factory = factory;
    this.reset = reset;
    this.maxPoolSize = maxPoolSize;
  }

  /** Acquire an object from the pool (or create new). */
  acquire(): T {
    let obj: T;
    if (this.pool.length > 0) {
      obj = this.pool.pop()!;
    } else {
      obj = this.factory();
    }
    this.active.add(obj);
    return obj;
  }

  /** Release an object back to the pool. */
  release(obj: T): void {
    if (!this.active.delete(obj)) return; // Not from this pool
    this.reset(obj);
    if (this.pool.length < this.maxPoolSize) {
      this.pool.push(obj);
    }
  }

  /** Release all active objects back to the pool. */
  releaseAll(): void {
    for (const obj of this.active) {
      this.reset(obj);
      if (this.pool.length < this.maxPoolSize) {
        this.pool.push(obj);
      }
    }
    this.active.clear();
  }

  /** Pre-warm the pool with N instances. */
  prewarm(count: number): void {
    for (let i = 0; i < count; i++) {
      const obj = this.factory();
      this.reset(obj);
      if (this.pool.length < this.maxPoolSize) {
        this.pool.push(obj);
      }
    }
  }

  get activeCount(): number { return this.active.size; }
  get pooledCount(): number { return this.pool.length; }
  get totalCount(): number { return this.active.size + this.pool.length; }
}
