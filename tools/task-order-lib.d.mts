export interface OrderTask { id: string; status: string; title?: string; tier?: number | null; filed?: string; [k: string]: unknown }
export const STATUSES: string[];
export const OPEN_STATUSES: Set<string>;
export const STATUS_MIGRATIONS: Record<string, string>;
export function isUntiered(t: { tier?: number | null; [k: string]: unknown }): boolean;
export function pickOrder<T extends OrderTask>(tasks: T[], opts?: { skip?: string[]; now?: number }): T[];
export const LOCAL_CLAIM_TTL_MS: number;
export function isFreshLocalClaim(t: OrderTask & { claim?: { by?: string; at?: string } }, now?: number): boolean;
export function parseTier(v: unknown): 1 | 2 | 3;
export function parseStatus(v: unknown): string;
export function parseFiled(v: unknown): string;
export function parseCount(v: unknown): number;
export function unknownStatuses(tasks: { id: string; status: unknown }[]): { id: string; status: unknown }[];
export function migrateStatuses(tasks: { status: string }[]): Record<string, number>;
