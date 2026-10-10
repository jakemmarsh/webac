/**
 * Windows-1252 (codepage 1252) encoder + decoder.
 *
 * ACE uses Windows-1252 for all game strings:
 *   - Network: `Network/Extensions.cs:17` WriteString16L → `Encoding.GetEncoding(1252).GetBytes`
 *   - DAT files: `BinaryReaderExtensions.cs:79` ReadPString → `Encoding.Default.GetString`
 *                (Encoding.Default is Windows-1252 on Western Windows installs;
 *                 ACE.DatLoader has a System.Text.Encoding.CodePages dependency to
 *                 force codepage 1252 on non-Windows .NET runtimes)
 *   - DAT obfuscated strings: `BinaryReaderExtensions.cs:95` →
 *                `Encoding.GetEncoding(1252).GetString` (explicit)
 *
 * Why we can't use `new TextDecoder('windows-1252')`: Node.js's TextDecoder
 * treats the encoding as effectively ISO-8859-1 — the 0x80-0x9F range maps
 * to control characters instead of the Windows-1252 punctuation set
 * (€, smart quotes, em-dash, etc.). Browsers follow the WHATWG spec and DO
 * map correctly, so a TextDecoder-only path works in browsers but fails in
 * Node tests. These helpers do the 0x80-0x9F mapping explicitly so behavior
 * is byte-identical across all environments.
 */

/** Windows-1252 specifics for the 0x80-0x9F range (where it differs from Latin-1). */
const WIN1252_CTRL_MAP: ReadonlyMap<number, number> = new Map([
  [0x20AC, 0x80], // €
  [0x201A, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201E, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02C6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8A], // Š
  [0x2039, 0x8B], // ‹
  [0x0152, 0x8C], // Œ
  [0x017D, 0x8E], // Ž
  [0x2018, 0x91], // '
  [0x2019, 0x92], // '
  [0x201C, 0x93], // "
  [0x201D, 0x94], // "
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02DC, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9A], // š
  [0x203A, 0x9B], // ›
  [0x0153, 0x9C], // œ
  [0x017E, 0x9E], // ž
  [0x0178, 0x9F], // Ÿ
]);

/** Byte → codepoint map for Windows-1252's 0x80-0x9F range (inverse of WIN1252_CTRL_MAP). */
const WIN1252_CTRL_DECODE: ReadonlyArray<number> = (() => {
  const arr = new Array<number>(0x20);
  for (let i = 0; i < 0x20; i++) arr[i] = -1;
  for (const [unicode, byte] of WIN1252_CTRL_MAP) {
    if (byte >= 0x80 && byte <= 0x9F) arr[byte - 0x80] = unicode;
  }
  return arr;
})();

/**
 * Encode a JS string to Windows-1252 bytes. Chars > U+00FF (outside both
 * Latin-1 supplement and the WIN1252_CTRL_MAP punctuation set) become `?`
 * (0x3F), matching ACE's `GetEncoding(1252).GetBytes` replacement-byte
 * behavior for unmappable codepoints.
 */
export function encodeWindows1252(s: string): Uint8Array {
  const out = new Uint8Array(s.length);  // each Unicode codepoint that maps becomes exactly 1 byte
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp < 0x80 || (cp >= 0xA0 && cp <= 0xFF)) {
      out[i] = cp;
    } else {
      const mapped = WIN1252_CTRL_MAP.get(cp);
      out[i] = mapped ?? 0x3F;
    }
  }
  return out;
}

/**
 * Decode Windows-1252 bytes to a JS string. See module-level comment for why
 * we can't rely on `new TextDecoder('windows-1252')`.
 */
export function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80 || b >= 0xA0) {
      out += String.fromCharCode(b);
    } else {
      const unicode = WIN1252_CTRL_DECODE[b - 0x80];
      out += unicode >= 0 ? String.fromCharCode(unicode) : '�';
    }
  }
  return out;
}
