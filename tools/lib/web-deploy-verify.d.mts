// Types for tools/lib/web-deploy-verify.mjs (post-deploy checks of what players load).
export interface FetchedResult { status: number; body: Uint8Array | null; ms: number; error?: string }
export interface VerifyFailure { host: string; path: string; reason: string }
export interface VerifyResult {
  ok: boolean;
  rounds: number;
  failures: VerifyFailure[];
  passed: { host: string; path: string; ms: number; size: number }[];
}
export type FetchLike = (url: string, init?: { signal?: AbortSignal; redirect?: string }) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
export function extractAssetPaths(html: string): { entry: string | null; assets: string[] };
export function fetchChecked(fetchFn: FetchLike, url: string, timeoutMs: number): Promise<FetchedResult>;
export function verifyDeploy(opts: {
  hosts: string[];
  expectBuild?: string | null;
  expectIndex?: string | null;
  localSize?: (path: string) => number | null;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  windowMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  concurrency?: number;
  log?: (line: string) => void;
}): Promise<VerifyResult>;
export function liveVersionId(statusJson: unknown): string | null;
