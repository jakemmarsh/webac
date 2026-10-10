export interface ProgressEntry { heading: string; date: string | null; text: string }
export const UNDATED: 'undated';
export function headingDate(line: string): string | null;
export function splitEntries(text: string): { preamble: string; entries: ProgressEntry[] };
export function minusDays(ymd: string, days: number): string;
export function planArchive(entries: ProgressEntry[], opts: { today: string; keepDays?: number }): { keep: ProgressEntry[]; archive: Map<string, ProgressEntry[]> };
export function archiveHeader(bucket: string): string;
export function liveHeader(archiveRel: string, buckets: string[], keepDays: number): string;
export function buildArchive(opts: {
  text: string; today: string; keepDays?: number; outDir: string; archiveRel: string;
  readExisting?: (path: string) => string | null;
}): {
  writes: Map<string, string>; keep: ProgressEntry[]; archive: Map<string, ProgressEntry[]>; buckets: Set<string>;
  liveText: (allBuckets: string[]) => string;
};
