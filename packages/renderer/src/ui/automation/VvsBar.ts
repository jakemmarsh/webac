/**
 * Virindi Views' bar: the strip of icons from which VVS plugins' windows were
 * opened (VirindiTank, the Virindi Hotkey System, UtilityBelt). With VVS
 * installed these windows were on VVS's bar, not Decal's (Almar's guide:
 * "the Decal bar and the Vtank bar"; virindi.net Virindi_Views). Decal's own
 * bar listed only Decal-view plugins, of which this client has none, so it
 * isn't drawn.
 *
 * Measured from the wiki's VVS theme screenshots (reference/images/decal-ui/
 * bar/; docs/automation-vtank-window.md "Virindi Views' bar"), the Decal
 * theme: 22 px tall, a 1 px dark edge (51, 38, 19) round a tan field
 * (173, 139, 82), 16 px icons from x = 3, a plugin's icons 20 px apart, and
 * between plugins a 2 px rule (dark 70, 40, 15 then light 197, 167, 142) with
 * 2 px either side. A click opens or closes the entry's window, and an open
 * window's icon has the underlay behind it (the theme's
 * Hint_VVSBarItemUnderlay). The theme's parchment grain is drawn flat.
 *
 * Icons: UtilityBelt's own PNG (MIT), its map views' portal.dat icons
 * (icon="13249" / "7923" = 0x060033C1 / 0x06001EF3: VVS adds 0x06000000).
 * VirindiTank's tank and VHS's arrow are Virindi's art (DLL resources), which
 * we may not copy, so those entries show what VVS shows for a view without an
 * icon: its coral box (255, 127, 80; VVSOptionBox.png).
 *
 * Not drawn: VVS's own first button (the "ab" theme menu), since this client
 * has no VVS themes, and the bar's vertical layout (ctrl+click in VVS).
 */

export const VVS_BAR = {
  height: 22,
  icon: 16,
  /** The first icon's left edge, and each icon's top. */
  pad: 3,
  /** Icon to icon within a plugin. */
  pitch: 20,
  /** The rule between plugins and the gap on either side. */
  ruleW: 2,
  ruleGap: 2,
  colors: {
    edge: 'rgb(51, 38, 19)',
    field: 'rgb(173, 139, 82)',
    ruleDark: 'rgb(70, 40, 15)',
    ruleLight: 'rgb(197, 167, 142)',
    /** Behind an open window's icon: the theme's grey line colour (the "ab" button's frame). */
    underlay: 'rgb(136, 138, 133)',
    /** VVS's box for a view without an icon. */
    noIcon: 'rgb(255, 127, 80)',
  },
} as const;

export type VvsBarIcon = { dat: number } | { url: string } | null;

export interface VvsBarEntry {
  /** A stable key (the window's). */
  id: string;
  /** The plugin it belongs to: entries group by plugin, in the order given. */
  plugin: string;
  /** The window's title. */
  title: string;
  icon: VvsBarIcon;
  open: boolean;
  toggle(): void;
}

/** Each entry's left edge on the bar, and the rules' (x of the dark column), and the bar's width. */
export function vvsBarLayout(entries: ReadonlyArray<Pick<VvsBarEntry, 'plugin'>>): { icons: number[]; rules: number[]; width: number } {
  const icons: number[] = [];
  const rules: number[] = [];
  let x = VVS_BAR.pad;
  entries.forEach((e, i) => {
    if (i > 0) {
      if (e.plugin !== entries[i - 1]!.plugin) {
        const rx = icons[i - 1]! + VVS_BAR.icon + VVS_BAR.ruleGap + 1;
        rules.push(rx);
        x = rx + VVS_BAR.ruleW + VVS_BAR.ruleGap;
      } else x = icons[i - 1]! + VVS_BAR.pitch;
    }
    icons.push(x);
  });
  const last = icons.length ? icons[icons.length - 1]! + VVS_BAR.icon : 0;
  return { icons, rules, width: Math.max(VVS_BAR.pad * 2, last + VVS_BAR.pad) };
}

/** Draw the bar's entries into `host` (sized here); `iconUrl` resolves portal.dat ids. */
export function renderVvsBar(host: HTMLElement, entries: readonly VvsBarEntry[], iconUrl: (id: number) => string | null): void {
  const { icons, rules, width } = vvsBarLayout(entries);
  host.innerHTML = '';
  host.dataset.vvsBar = '1';
  Object.assign(host.style, { width: `${width}px`, height: `${VVS_BAR.height}px`, boxSizing: 'border-box', background: VVS_BAR.colors.field, border: `1px solid ${VVS_BAR.colors.edge}` });
  // Positions are measured from the bar's outer edge; children sit inside the 1 px border.
  const place = (d: HTMLElement, x: number, y: number, w: number, h: number) => {
    Object.assign(d.style, { position: 'absolute', left: `${x - 1}px`, top: `${y - 1}px`, width: `${w}px`, height: `${h}px` });
    host.appendChild(d);
    return d;
  };
  for (const rx of rules) {
    place(document.createElement('div'), rx, 1, 1, VVS_BAR.height - 2).style.background = VVS_BAR.colors.ruleDark;
    place(document.createElement('div'), rx + 1, 1, 1, VVS_BAR.height - 2).style.background = VVS_BAR.colors.ruleLight;
  }
  entries.forEach((e, i) => {
    const slot = place(document.createElement('div'), icons[i]!, VVS_BAR.pad, VVS_BAR.icon, VVS_BAR.icon);
    slot.dataset.vvsBarEntry = e.id;
    slot.dataset.open = e.open ? '1' : '0';
    slot.style.cursor = 'pointer';
    if (e.open) slot.style.background = VVS_BAR.colors.underlay;
    const url = e.icon ? ('dat' in e.icon ? iconUrl(e.icon.dat) : e.icon.url) : null;
    if (url) Object.assign(slot.style, { backgroundImage: `url(${url})`, backgroundSize: '100% 100%' });
    // An icon whose image hasn't arrived yet (streamed DATs) stays empty until the host redraws; only a view
    // with no icon at all gets VVS's coral box.
    else if (e.icon) slot.dataset.iconPending = '1';
    else {
      const box = document.createElement('div');
      Object.assign(box.style, { position: 'absolute', left: '3px', top: '3px', width: '10px', height: '10px', background: VVS_BAR.colors.noIcon, pointerEvents: 'none' });
      slot.appendChild(box);
    }
    slot.addEventListener('click', (ev) => { ev.stopPropagation(); e.toggle(); });
  });
}
