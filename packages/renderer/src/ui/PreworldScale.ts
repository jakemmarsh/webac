/**
 * CORE.13.a / CORE.17.k.b.b.a.a — uniform 4:3 letterbox scaling for every
 * pre-world screen, the loading (patch) screen included.
 *
 * Retail never renders a widescreen pre-world frame: gmClient::Init
 * (@ 004047a0) calls Device::ForceDisplayResolution(true, 800, 600)
 * (@ 0043a750) at startup — before gmDataPatchUI, the first framework
 * UIFlow creates, draws anything — and the force is only released when the
 * in-game UI comes up (gmGamePlayUI ctor), then re-applied on logout
 * (gmGamePlayUI dtor). The whole patch / connecting / char-select /
 * char-create flow therefore always draws a 4:3 800x600 frame, and the DAT
 * pre-world layout roots agree: edge modes are fixed (0) or centered (3)
 * (UIElement::UpdateForParentSizeChange @ 00462640) — never proportional,
 * so nothing stretches. The browser equivalent of that 800x600 display mode
 * on a modern screen is the whole frame scaled UNIFORMLY to fit the
 * viewport, centered, with black bars filling the remainder (what an
 * aspect-preserving monitor shows for a 4:3 mode).
 */

export const PREWORLD_WIDTH = 800;
export const PREWORLD_HEIGHT = 600;

export interface PreworldPlacement {
  /** The uniform scale factor: min(viewportW / 800, viewportH / 600). */
  scale: number;
  /** The frame's top-left in viewport pixels (the bars split evenly). */
  left: number;
  top: number;
}

/** Where an 800x600 frame sits in a viewport of the given size. */
export function preworldPlacement(viewportWidth: number, viewportHeight: number): PreworldPlacement {
  const scale = Math.min(viewportWidth / PREWORLD_WIDTH, viewportHeight / PREWORLD_HEIGHT);
  return {
    scale,
    left: (viewportWidth - PREWORLD_WIDTH * scale) / 2,
    top: (viewportHeight - PREWORLD_HEIGHT * scale) / 2,
  };
}

/**
 * Fix `inner` as an 800x600 frame scaled and centred in the window; keeps it
 * placed across resizes until the returned cleanup runs. The caller paints
 * the bars (its host's background) black.
 */
export function attachPreworldScale(inner: HTMLElement, win: Window = window): () => void {
  Object.assign(inner.style, {
    width: `${PREWORLD_WIDTH}px`, height: `${PREWORLD_HEIGHT}px`,
    position: 'fixed', overflow: 'hidden',
    transformOrigin: 'left top',
  });
  const update = (): void => {
    const p = preworldPlacement(win.innerWidth, win.innerHeight);
    inner.style.left = `${p.left}px`;
    inner.style.top = `${p.top}px`;
    inner.style.transform = `scale(${p.scale})`;
  };
  update();
  // Deferred second pass in case viewport dimensions settle after layout.
  if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(update);
  win.addEventListener('resize', update);
  return () => win.removeEventListener('resize', update);
}
