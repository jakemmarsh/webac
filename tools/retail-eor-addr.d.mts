export interface PeSection { name: string; va: number; vsize: number; rawPtr: number; rawSize: number }
export interface PeImage { bytes: Uint8Array; imageBase: number; sections: PeSection[] }
export interface Symbol { addr: number; name: string }
export function loadPe(bytes: Uint8Array): PeImage;
export function vaToOffset(img: PeImage, va: number): number;
export function offsetToVa(img: PeImage, off: number): number;
export function stableMask(bytes: Uint8Array, start: number, len: number, imageBase: number): boolean[];
export function mapAddress(
  from: PeImage, to: PeImage, va: number, opts?: { radius?: number; anchorLen?: number },
): { va: number; votes: number; anchors: number } | null;
export function loadSymbols(tsv: string): Symbol[];
export function symbolFor(symbols: Symbol[], va: number): Symbol | null;
