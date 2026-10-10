export type Verdict = 'match' | 'close' | 'off' | 'unassessed';
export interface Screen { id: string; name: string; tier: number; captures: string[]; retail: string[]; verdict: Verdict | string; judged: string | null; evidence: string; gaps: string[]; notes: string }
export interface Card { screens: Screen[]; [k: string]: unknown }
export const VERDICTS: Verdict[];
export const STALE_DAYS: number;
export function summarize(card: Card): { total: number; match: number; close: number; off: number; unassessed: number; line: string };
export function dueForJudging(card: Card, today: string, staleDays?: number): Screen[];
export function judge(card: Card, id: string, verdict: string, opts: { evidence?: string; gaps?: string[]; notes?: string; today: string; tasks?: { id: string; status: string }[]; exists?: (path: string) => boolean }): Screen;
