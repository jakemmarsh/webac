import type { ScanHit } from './public-export-lib.mjs';
export interface ExportedFile { path: string; mode: string; data: Buffer }
export interface ExportIssue { path: string; reason?: string; hits?: ScanHit[] }
export function buildExport(ref: string): { sha: string; files: ExportedFile[]; dropped: ExportIssue[]; failures: ExportIssue[] };
