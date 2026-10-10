export interface ScanHit { line: number; text: string }
export interface FileVerdict { action: 'keep' | 'drop' | 'fail'; reason?: string; hits?: ScanHit[] }
export const PUBLIC_ROOTS: string[];
export const PUBLIC_DOCS: string[];
export const EXCLUDED: string[];
export const DECOMP_STRONG: RegExp[];
export const DECOMP_WEAK: RegExp[];
export const SECRET_PATTERNS: RegExp[];
export const FORBIDDEN_EXTENSIONS: RegExp;
export const IMAGE_EXTENSIONS: RegExp;
export const ALLOWED_IMAGES: string[];
export function isPublicPath(path: string): boolean;
export function scanText(text: string, patterns: RegExp[]): ScanHit[];
export function classifyFile(path: string, text: string | null): FileVerdict;
export function privateExecutables(trackedPaths: string[]): string[];
export function namesPrivateFile(text: string, privatePaths: string[]): string | null;
export function looksBinary(buf: Uint8Array): boolean;
export const RENAMES: Record<string, string>;
export function publicPathFor(path: string): string;
