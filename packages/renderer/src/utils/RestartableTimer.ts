/**
 * A single pending-callback slot: scheduling a new call cancels any
 * previous one still pending, so only the most recently scheduled call
 * ever fires. Used for "the latest request wins" transition timers where
 * an earlier stale timer firing after a later one has already changed
 * state would clobber that later state (e.g. main.ts's portal-space
 * hide-timer: a teleport's own hide must not fire after a subsequent
 * teleport has re-shown the overlay).
 */
export class RestartableTimer {
  private id: ReturnType<typeof setTimeout> | null = null;

  schedule(callback: () => void, delayMs: number): void {
    this.cancel();
    this.id = setTimeout(() => {
      this.id = null;
      callback();
    }, delayMs);
  }

  cancel(): void {
    if (this.id !== null) {
      clearTimeout(this.id);
      this.id = null;
    }
  }

  get isPending(): boolean {
    return this.id !== null;
  }
}
