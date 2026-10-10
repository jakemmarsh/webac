// Types for tools/lib/udp-impair.mjs (the retail relay's network impairment).
export interface ImpairmentConfig { latencyMs: number; jitterMs: number; lossPct: number; seed: number }
export interface ImpairedLink {
  send(deliver: () => void): 'dropped' | 'delayed' | 'sent';
  close(): void;
}
export function resolveImpairment(env: Record<string, string | undefined>): ImpairmentConfig | null;
export function seededRandom(seed: number): () => number;
export function makeImpairedLink(
  config: ImpairmentConfig | null,
  schedule?: (fn: () => void, ms: number) => unknown,
  cancel?: (handle: unknown) => void,
): ImpairedLink;
export function makeLinkPair(
  config: ImpairmentConfig | null,
  schedule?: (fn: () => void, ms: number) => unknown,
  cancel?: (handle: unknown) => void,
): { up: ImpairedLink; down: ImpairedLink };
