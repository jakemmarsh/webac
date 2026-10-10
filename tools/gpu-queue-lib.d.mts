// Types for tools/gpu-queue-lib.mjs (docs/gpu-worker.md).
export type GpuJobKind = 'perf' | 'perf-soak' | 'screen-regression' | 'sidebyside' | 'retail-ab' | 'dat-streaming' | 'streaming-ab';
export interface GpuJob {
  id?: string;
  kind?: string;
  sha?: string;
  task?: string;
  args?: Record<string, unknown>;
  requestedAt?: string;
  requestedBy?: string;
  _file?: string;
}
export const KINDS: Record<GpuJobKind, { timeoutMin: number; describe: string }>;
export const QUEUE_DIR: string;
export const RESULTS_DIR: string;
export const MAX_ARTIFACT_IMAGES: number;
export const RETAIL_IDLE_SEC: number;
export const RETAIL_INTERRUPTED_EXIT: number;
export const DAT_STREAMING_OUT: string;
export const DAT_STREAMING_TELEPORTS: string[];
export const STREAMING_AB_OUT: string;
export const STREAMING_AB_ACCOUNT: string;
export const STREAMING_AB_PATHS: string[];
export const STREAMING_AB_MIN_INTERVAL_H: number;
export function streamingAbDue(opts: { last: { sha: string; finishedAt: string } | null; changedPaths: string[] | null; nowMs: number }): boolean;
export function validateJob(job: unknown): string[];
export function commandFor(job: GpuJob, opts: { url: string; account?: string }): { argv: string[]; env: Record<string, string> };
export function verdictFor(kind: string, exitCode: number, timedOut?: boolean): 'pass' | 'fail' | 'error' | 'timeout' | 'review' | 'interrupted';
export function pendingJobs<T extends GpuJob>(jobs: T[], done: Iterable<string>): T[];
export function resultIdFor(job: GpuJob): string;
export function newJobId(job: { task?: string; kind: string; sha: string }, now?: Date): string;
export function retailAbSheetScenes(
  job: { args?: { scenes?: string[] } }, available: string[],
  written?: { sinceMs: number; mtimeMs: (scene: string) => number | undefined },
): string[];
export function parseRegressionReport(md: string): { headline: string; changed: string[] };
export interface CiRun { databaseId?: number; headSha: string; status: string; conclusion: string | null }
export function ciRunFor<R extends CiRun>(runs: R[], sha: string, contains: (head: string, sha: string) => boolean): { run: R | null; state: 'done' | 'waiting' | 'missing' };
export const MIN_BATTERY_PCT: number;
export interface HostContention { otherBrowsers: number; retailClients: number; load1: number; cpus: number; top: string[]; reason: string | null }
export interface PsRow { pid: number; ppid: number; pcpu: number; command: string }
export interface MachineState { ac: boolean; batteryPct: number | null; idleSec: number; contention?: HostContention; nowMs?: number }
export const TIMING_KINDS: Set<string>;
export const CONTENTION_MAX_WAIT_H: number;
export const CONTENDED_LOAD_PER_CPU: number;
export function parsePs(text: string): PsRow[];
export function processTree(rows: PsRow[], root: number | undefined): Set<number>;
export function playwrightBrowserRoots(rows: PsRow[]): number[];
export function hostContention(rows: PsRow[], opts?: { load1?: number; cpus?: number; ownRoot?: number }): HostContention;
export function jobBlockedReason(job: GpuJob, state: MachineState): string | null;
export function machineBlockedReason(state: MachineState): string | null;
export function pickRunnable<T extends GpuJob>(pending: T[], state: MachineState): { job: T | null; skipped: string[] };
export function timeoutMinFor(job: GpuJob): number;
export const PLAYING_IDLE_SEC: number;
export function playingReason(bridgeSessions: number, idleSec: number): string | null;
export function isLongJob(job: GpuJob): boolean;
