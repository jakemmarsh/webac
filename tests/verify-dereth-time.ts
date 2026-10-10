/**
 * GAP.calendar-date-vs-retail — the World panel Date/Time is the retail
 * client's GameTime (decomp GameTime::CalcDayBegin @ 005a6400,
 * CalcTimeOfDay @ 005a64a0, GetDateTimeString @ 005a6530, gmMapUI::Update
 * @ 004a1eb0) on the game clock, with every name/length from RegionDesc
 * 0x13000000's GameTime. It replaced the ACE DerethDateTime wall-clock port.
 *
 * Ground truth: the retail A/B run (verification/retail-ab/world-panel) read
 * "Date: Seedsow 20, 121 P.Y." / "Time: Darktide" at 2026-10-02T21:15:19Z
 * against a local ACE (PortalYearTicks = seconds since 2017-01-31 17:00Z).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { RegionDesc, DatReader } from '../packages/dat-parser/src/index.js';
import {
  calendarFromClock, formatCalendarDate, formatCalendarTime, type CalendarGameTime,
} from '../packages/renderer/src/derethTime.js';
import { aceEmuTicksNow } from '../packages/renderer/src/effects/SkyboxRenderer.js';

/** EoL portal.dat RegionDesc 0x13000000 GameTime (dumped 2026-10-03). */
const TOD = ['Darktide', 'Foredawn', 'Dawnsong', 'Morntide', 'Midsong', 'Warmtide', 'Evensong', 'Gloaming']
  .flatMap(n => [n, `${n}-and-Half`]);
const EOL_GAME_TIME: CalendarGameTime = {
  zeroTimeOfYear: 3600, zeroYear: 10, dayLength: 7620, daysPerYear: 360, yearSpec: 'P.Y.',
  timesOfDay: TOD.map((name, i) => ({ start: i / 16, name })),
  seasons: ['Morningthaw', 'Solclaim', 'Seedsow', 'Leafdawning', 'Verdantine', 'Thistledown',
    'HarvestGain', 'Leafcull', 'Frostfell', 'Snowreap', 'Coldeve', 'Wintersebb']
    .map((name, i) => ({ startDate: i * 30, name })),
};
const DAY = 7620;
const YEAR = DAY * 360;
/** Clock value at the start of `day` (0-based) of game year `year`. */
const clockAt = (year: number, day: number, phase = 0): number =>
  (year - 10) * YEAR + day * DAY + phase * DAY - 3600;
const RETAIL_AB_TICKS = aceEmuTicksNow(Date.parse('2026-10-02T21:15:19.387Z'));

describe('GAP.calendar-date-vs-retail — retail GameTime calendar', () => {
  it('reproduces the retail A/B reading at 2026-10-02T21:15:19Z exactly', () => {
    const c = calendarFromClock(RETAIL_AB_TICKS, EOL_GAME_TIME)!;
    expect(c).toMatchObject({ year: 121, dayOfYear: 79, season: 2, dayInSeason: 20, timeOfDay: 0 });
    expect(formatCalendarDate(c, EOL_GAME_TIME)).toBe('Date: Seedsow 20, 121 P.Y.');
    expect(formatCalendarTime(c, EOL_GAME_TIME)).toBe('Time: Darktide');
  });

  it('the old ACE wall-clock reading is gone (same moment)', () => {
    const c = calendarFromClock(RETAIL_AB_TICKS, EOL_GAME_TIME)!;
    expect(formatCalendarDate(c, EOL_GAME_TIME)).not.toBe('Date: HarvestGain 2, 37 P.Y.');
  });

  it('clock 0 is zero_time_of_year seconds into year zero_year (CalcDayBegin)', () => {
    const c = calendarFromClock(0, EOL_GAME_TIME)!;
    expect(c).toMatchObject({ year: 10, dayOfYear: 0, season: 0, dayInSeason: 1 });
    // 3600 / 7620 = 0.472 of the day → slot 7 (begin 0.4375)
    expect(EOL_GAME_TIME.timesOfDay[c.timeOfDay].name).toBe('Morntide-and-Half');
  });

  it('seasons switch on their DAT begin days; day-in-season is 1-based', () => {
    const at = (day: number) => calendarFromClock(clockAt(130, day, 0.5), EOL_GAME_TIME)!;
    expect(formatCalendarDate(at(29), EOL_GAME_TIME)).toBe('Date: Morningthaw 30, 130 P.Y.');
    expect(formatCalendarDate(at(30), EOL_GAME_TIME)).toBe('Date: Solclaim 1, 130 P.Y.');
    expect(formatCalendarDate(at(359), EOL_GAME_TIME)).toBe('Date: Wintersebb 30, 130 P.Y.');
    expect(formatCalendarDate(at(360), EOL_GAME_TIME)).toBe('Date: Morningthaw 1, 131 P.Y.');
  });

  it('times of day follow the DAT begin fractions (1/16 day each)', () => {
    const name = (phase: number) =>
      formatCalendarTime(calendarFromClock(clockAt(125, 40, phase), EOL_GAME_TIME)!, EOL_GAME_TIME);
    expect(name(0.01)).toBe('Time: Darktide');
    expect(name(0.07)).toBe('Time: Darktide-and-Half');
    expect(name(0.26)).toBe('Time: Dawnsong');
    expect(name(0.51)).toBe('Time: Midsong');
    expect(name(0.99)).toBe('Time: Gloaming-and-Half');
  });

  it('no GameTime lengths → no calendar', () => {
    expect(calendarFromClock(1000, { ...EOL_GAME_TIME, dayLength: 0 })).toBeNull();
    expect(calendarFromClock(NaN, EOL_GAME_TIME)).toBeNull();
  });
});

const HAS_PORTAL = existsSync(DAT_PATHS.portal);
describe.skipIf(!HAS_PORTAL)('GAP.calendar-date-vs-retail — the DAT GameTime is what the fixture pins', () => {
  let gt: CalendarGameTime;
  beforeAll(() => {
    gt = new RegionDesc(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x13000000)!)).gameTime;
  });
  it('EoL RegionDesc GameTime matches the fixture and gives the retail reading', () => {
    expect(gt).toMatchObject(EOL_GAME_TIME);
    const c = calendarFromClock(RETAIL_AB_TICKS, gt)!;
    expect(`${formatCalendarDate(c, gt)} / ${formatCalendarTime(c, gt)}`)
      .toBe('Date: Seedsow 20, 121 P.Y. / Time: Darktide');
  });
});

describe('VISUAL.74 / GAP.calendar-date-vs-retail — map panel renders the Date/Time block (real renderMapPanel)', () => {
  let H: GameUIFixture;
  let onClose: (() => void) | null = null;
  beforeAll(async () => {
    H = await mountGameUI();
    const win = H.win;
    const renderPanel = (_layoutId: number, parent: HTMLElement, opts?: { onClose?: () => void }) => {
      onClose = opts?.onClose ?? null;
      const wrapper = win.document.createElement('div');
      parent.appendChild(wrapper);
      const root = win.document.createElement('div');
      wrapper.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const get = elements.get.bind(elements);
      elements.get = (id: number) => {
        let el = get(id);
        if (!el) { el = win.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
        return el;
      };
      return {
        root, elements, descs: new Map(),
        setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {}, setTexture: () => {},
        onClick: () => {}, close: () => wrapper.remove(),
      };
    };
    // `render` draws the panels window's frame (0x2100006e) the map mounts in;
    // it must not overwrite the panel's recorded onClose.
    const render = (_layoutId: number, parent: HTMLElement) => {
      const saved = onClose;
      const handle = renderPanel(_layoutId, parent);
      onClose = saved;
      return handle;
    };
    H.ui.layoutRenderer = { renderPanel, render, setFontResolver: () => {} };
  });
  afterAll(() => { if (H.ui.mapPanelVisible) H.ui.toggleMapPanel(); H.teardown(); });

  it('the 0x100001eb (21,4) 227x30 block shows the GameTime date + time from the game clock', () => {
    let clock = RETAIL_AB_TICKS;
    H.ui.setCalendarSource(EOL_GAME_TIME, () => clock);
    H.ui.toggleMapPanel();
    const block = [...H.ui.mapPanel.querySelectorAll('div')].find((d: HTMLElement) =>
      d.style.left === '21px' && d.style.top === '4px' && d.style.width === '227px' && d.style.height === '30px') as HTMLElement;
    expect(block).toBeTruthy();
    expect(block.textContent).toContain('Date: Seedsow 20, 121 P.Y.');
    expect(block.textContent).toContain('Time: Darktide');
    expect(H.ui.mapTimeInterval).not.toBeNull();
    // Re-render a fresh panel after the clock crosses into the next slot.
    clock += DAY / 16;
    H.ui.renderMapPanel();
    const again = [...H.ui.mapPanel.querySelectorAll('div')].find((d: HTMLElement) =>
      d.style.left === '21px' && d.style.top === '4px' && d.style.width === '227px') as HTMLElement;
    expect(again.textContent).toContain('Time: Darktide-and-Half');
  });

  it('the refresh ticker is cleared on every close path (toggle, re-render, window close)', () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    try {
      // re-render: the old ticker is cleared before a new one starts
      const first = H.ui.mapTimeInterval;
      H.ui.renderMapPanel();
      expect(clear).toHaveBeenCalledWith(first);
      // toggle close
      const second = H.ui.mapTimeInterval;
      H.ui.toggleMapPanel();
      expect(clear).toHaveBeenCalledWith(second);
      expect(H.ui.mapTimeInterval).toBeNull();
      // the panel's own close button (LayoutRenderer onClose)
      H.ui.toggleMapPanel();
      const third = H.ui.mapTimeInterval;
      expect(third).not.toBeNull();
      expect(onClose).toBeTypeOf('function');
      onClose!();
      expect(clear).toHaveBeenCalledWith(third);
      expect(H.ui.mapTimeInterval).toBeNull();
      expect(H.ui.mapPanelVisible).toBe(false);
    } finally {
      clear.mockRestore();
    }
  });
});
