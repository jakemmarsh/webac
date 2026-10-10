/**
 * GAP.calendar-date-vs-retail — the World panel's Date/Time lines, ported
 * from the retail client's GameTime (reference/client-eol decomp):
 *
 *  - GameTime::CalcDayBegin @ 005a6400 — year / day-of-year / season from the
 *    game clock (Timer::cur_time = the server's PortalYearTicks from TimeSync)
 *  - GameTime::CalcTimeOfDay @ 005a64a0 — the time-of-day slot
 *  - GameTime::GetDateTimeString @ 005a6530 — sprintf("%s %s, %s %s",
 *    season_name, day-in-season, current_year, year_spec) + time_of_day_name
 *  - gmMapUI::Update @ 004a1eb0 — prefixes "Date: " / "Time: "
 *
 * Every name and length comes from RegionDesc 0x13000000's GameTime (EoL:
 * zero_time_of_year 3600, zero_year 10, day_length 7620, 360 days, "P.Y.",
 * 16 times of day, 12 seasons Morningthaw..Wintersebb).
 *
 * This replaced a port of ACE's DerethDateTime real-world-date formula
 * (VISUAL.74), which no retail client ever showed: on 2026-10-02 at
 * 21:15:19Z retail read "Seedsow 20, 121 P.Y. / Darktide" while that
 * formula gave "HarvestGain 2, 37 P.Y. / Gloaming".
 */

/** The RegionDesc GameTime fields the calendar reads (dat-parser GameTime). */
export interface CalendarGameTime {
  zeroTimeOfYear: number;
  zeroYear: number;
  dayLength: number;
  daysPerYear: number;
  yearSpec: string;
  timesOfDay: ReadonlyArray<{ start: number; name: string }>;
  seasons: ReadonlyArray<{ startDate: number; name: string }>;
}

export interface DerethCalendar {
  /** GameTime.current_year (zero_year-based). */
  year: number;
  /** GameTime.current_day: 0-based day of the year. */
  dayOfYear: number;
  /** Index into GameTime.seasons. */
  season: number;
  /** 1-based day within the season, as printed. */
  dayInSeason: number;
  /** Index into GameTime.times_of_day. */
  timeOfDay: number;
}

/** Last index whose begin <= value, scanning from index 1 (the CalcDayBegin /
 *  CalcTimeOfDay loops: they break at the first later entry past value). */
function slotIndex(begins: number[], value: number): number {
  let i = 0;
  while (i < begins.length - 1 && !(value < begins[i + 1])) i++;
  return i;
}

/**
 * Retail CalcDayBegin + CalcTimeOfDay for a game-clock value (seconds).
 * Keeps the client's float32 casts: the year remainder and the clock are
 * truncated to float before the day start is derived, so the time-of-day
 * boundaries land where retail's do.
 */
export function calendarFromClock(ticks: number, gt: CalendarGameTime): DerethCalendar | null {
  if (!(gt.dayLength > 0) || !(gt.daysPerYear > 0) || !Number.isFinite(ticks)) return null;
  const yearLength = gt.dayLength * gt.daysPerYear; // GameTime::UnPack
  const t = ticks + gt.zeroTimeOfYear;
  const yearIdx = Math.floor(t / yearLength);
  const rem = Math.fround(t - yearIdx * yearLength);
  const dayOfYear = Math.floor(Math.fround(rem / gt.dayLength));
  const season = gt.seasons.length > 0 ? slotIndex(gt.seasons.map(s => s.startDate), dayOfYear) : 0;
  const dayBegin = Math.fround(ticks) - Math.fround(rem - Math.fround(dayOfYear * gt.dayLength));
  const phase = (ticks - dayBegin) / gt.dayLength;
  const timeOfDay = gt.timesOfDay.length > 0 ? slotIndex(gt.timesOfDay.map(s => s.start), phase) : 0;
  const seasonBegin = gt.seasons[season]?.startDate ?? 0;
  return {
    year: yearIdx + gt.zeroYear,
    dayOfYear,
    season,
    dayInSeason: dayOfYear - seasonBegin + 1,
    timeOfDay,
  };
}

/** gmMapUI's first line: "Date: <season> <day>, <year> <year_spec>". */
export function formatCalendarDate(c: DerethCalendar, gt: CalendarGameTime): string {
  return `Date: ${gt.seasons[c.season]?.name ?? ''} ${c.dayInSeason}, ${c.year} ${gt.yearSpec}`;
}

/** gmMapUI's second line: "Time: <time_of_day_name>". */
export function formatCalendarTime(c: DerethCalendar, gt: CalendarGameTime): string {
  return `Time: ${gt.timesOfDay[c.timeOfDay]?.name ?? ''}`;
}
