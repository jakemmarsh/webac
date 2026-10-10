export interface Lockfile { packages?: Record<string, { version?: string; resolved?: string; link?: boolean; optional?: boolean; [k: string]: unknown }> }
export function lockfileDrift(lock: Lockfile, hidden: Lockfile): string[];
