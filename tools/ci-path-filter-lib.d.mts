export const CI_YML: string;
export function globToRegExp(glob: string): RegExp;
export function fileTriggers(patterns: string[], file: string): boolean;
export function pushTriggers(patterns: string[], files: string[]): boolean;
export function pathsFor(yml: string, event: string): string[] | null;
export function loadCiFilters(file?: string): { yml: string; push: string[] | null; pull_request: string[] | null };
