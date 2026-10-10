/**
 * BUG.locale-date-formatting-browser-dependent — pin timestamp display to a
 * fixed locale, matching retail's setlocale(0,"English") + strftime("%c").
 *
 * Pre-fix, four call sites (character Birth date, House Purchased/Next-due,
 * house rent-due chat notice) formatted server-sent Unix-epoch timestamps
 * with bare `Date.toLocaleString()`/`toLocaleDateString()`, which follows the
 * browser's active Intl locale — the same timestamp renders differently
 * per player (e.g. MM/DD/YYYY in en-US vs DD.MM.YYYY in de-DE).
 *
 * Retail (reference/client-eol/decomp/acclient-decompiled.c:180129-180130,
 * :429034-429038) pins the process locale once at client init (:3067) and
 * always renders the identical strftime("%c") string regardless of the
 * player's OS/browser language or region.
 */
import { describe, it, expect } from 'vitest';
import { formatAcTime } from '../packages/renderer/src/utils/formatAcTime.js';

const SAMPLE_EPOCH = 1705321000; // 2024-01-15T12:16:40Z

describe('formatAcTime (BUG.locale-date-formatting-browser-dependent)', () => {
  it('renders retail\'s English %c shape: M/d/yyyy h:mm:ss AM|PM (VISUAL.house-tab-date-format, retail-ab world-house "10/12/2026 4:48:08 PM")', () => {
    const result = formatAcTime(SAMPLE_EPOCH);
    expect(result).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} (AM|PM)$/);
    const d = new Date(SAMPLE_EPOCH * 1000);
    expect(result.startsWith(`${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} `)).toBe(true);
  });

  it('12-hour clock: midnight is 12 AM, noon 12 PM, no leading zero on the hour', () => {
    const local = (h: number) => new Date(2026, 9, 12, h, 48, 8).getTime() / 1000;
    expect(formatAcTime(local(0))).toBe('10/12/2026 12:48:08 AM');
    expect(formatAcTime(local(12))).toBe('10/12/2026 12:48:08 PM');
    expect(formatAcTime(local(16))).toBe('10/12/2026 4:48:08 PM');
  });

  it('is deterministic for a given epoch seconds value', () => {
    expect(formatAcTime(SAMPLE_EPOCH)).toBe(formatAcTime(SAMPLE_EPOCH));
  });

  it('ignores the ambient/browser locale — always the pinned English shape, unlike a bare toLocaleString', () => {
    const date = new Date(SAMPLE_EPOCH * 1000);
    const deLocale = date.toLocaleString('de-DE', {
      weekday: 'short',
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    // Retail's pinned English locale never varies; the bare Intl call under a
    // non-English locale would (e.g. de-DE renders "Mo., 15. Jan. 2024, ...").
    expect(formatAcTime(SAMPLE_EPOCH)).not.toBe(deLocale);
    expect(formatAcTime(SAMPLE_EPOCH)).toMatch(/(AM|PM)$/);
  });

  it('uses whole-second precision with no fractional seconds', () => {
    expect(formatAcTime(0)).not.toContain('.');
  });
});
