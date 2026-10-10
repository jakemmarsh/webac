/**
 * The background frame ticker (BackgroundTicker.ts): a steady beat from a
 * dedicated worker, whose timers the browser does not throttle the way it
 * stops a hidden or covered page's requestAnimationFrame and timers.
 * Message `ms` > 0 starts (or retimes) the beat; 0 stops it.
 */
let id: ReturnType<typeof setInterval> | null = null;
self.onmessage = (e: MessageEvent<number>) => {
  if (id !== null) clearInterval(id);
  id = e.data > 0 ? setInterval(() => (self as unknown as Worker).postMessage(0), e.data) : null;
};
