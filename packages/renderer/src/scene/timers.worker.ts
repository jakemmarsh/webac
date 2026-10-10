/**
 * The page's timers while Claude plays (workerTimers.ts): a dedicated
 * worker's setTimeout / setInterval, which the browser doesn't throttle the
 * way it does a hidden or covered page's. {op:'set', id, ms, repeat} arms,
 * {op:'clear', id} disarms; the worker posts the id each time one fires.
 */
const live = new Map<number, ReturnType<typeof setTimeout>>();
self.onmessage = (e: MessageEvent<{ op: 'set' | 'clear'; id: number; ms?: number; repeat?: boolean }>) => {
  const { op, id, ms = 0, repeat = false } = e.data;
  const old = live.get(id);
  if (old !== undefined) { clearTimeout(old); clearInterval(old); live.delete(id); }
  if (op !== 'set') return;
  const post = () => (self as unknown as Worker).postMessage(id);
  live.set(id, repeat ? setInterval(post, Math.max(4, ms)) : setTimeout(() => { live.delete(id); post(); }, Math.max(0, ms)));
};
