import { ZLayer, zLayer } from './ZIndexRegistry.js';

/**
 * Builds the black loading overlay shown from page load until portal.dat is
 * downloaded and parsed (main.ts's initDatSplash() then replaces its content
 * with the real DAT-driven PatchField splash, per LayoutDesc 0x21000000).
 *
 * Pre-creates #load-text-left / #load-text-right so the status callbacks
 * fired while portal.dat is still downloading (the bulk of the ~1.2GB initial
 * transfer) have somewhere to render. Before this, those callbacks targeted
 * the same element ids by document.getElementById, which initDatSplash()
 * doesn't create until portal.dat finishes — so on a slow connection the
 * overlay stayed bare black with zero feedback for the entire download
 * (reported 2026-06-12 as "kinda fucked up"; VISUAL2.6). This placeholder is
 * plain browser chrome (sans-serif, unstyled) rather than a DAT-styled
 * recreation, since no DAT assets exist yet to draw the real thing from.
 *
 * VISUAL.preworld-placeholder-before-portal-dat: retail never shows a pre-art
 * state — its first frame is the DAT splash. The splash now draws from its
 * own portal.dat files read by byte range ahead of the download, so the
 * placeholder's status line starts hidden (a black frame for the moment that
 * read takes) and revealLoadingPlaceholder() shows it only when the ranged
 * read fails and the full download is the only way to the art.
 */
export function createLoadingOverlay(): HTMLDivElement {
  const loadingOverlay = document.createElement('div');
  loadingOverlay.id = 'loading-overlay';
  Object.assign(loadingOverlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
    background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: zLayer(ZLayer.DEBUG_OVERLAY),
  });

  const preSplashColumn = document.createElement('div');
  Object.assign(preSplashColumn.style, { display: 'flex', flexDirection: 'column', gap: '8px' });
  const preSplashLeft = document.createElement('div');
  preSplashLeft.id = 'load-text-left';
  const preSplashRight = document.createElement('div');
  preSplashRight.id = 'load-text-right';
  for (const el of [preSplashLeft, preSplashRight]) {
    Object.assign(el.style, {
      fontFamily: 'sans-serif', fontSize: '14px', color: '#aaa', textAlign: 'center',
      visibility: 'hidden',
    });
  }
  preSplashColumn.appendChild(preSplashLeft);
  preSplashColumn.appendChild(preSplashRight);
  loadingOverlay.appendChild(preSplashColumn);

  return loadingOverlay;
}

/**
 * Show the placeholder's status line — only when the DAT splash cannot draw
 * before portal.dat has downloaded (the ranged splash read failed). A no-op
 * once the splash has replaced the placeholder.
 */
export function revealLoadingPlaceholder(loadingOverlay: HTMLElement): void {
  for (const el of loadingOverlay.querySelectorAll<HTMLElement>('#load-text-left, #load-text-right')) {
    if (el.style.visibility === 'hidden') el.style.visibility = 'visible';
  }
}

/**
 * Fade the overlay out and remove it. It stops taking the pointer at once: an
 * opaque-then-fading frame at DEBUG_OVERLAY still sat over the character screen
 * for the fade and swallowed the first clicks. `onRemoved` runs after removal.
 */
export function fadeOutLoadingOverlay(loadingOverlay: HTMLElement, ms: number, onRemoved?: () => void): void {
  loadingOverlay.style.pointerEvents = 'none';
  loadingOverlay.style.transition = `opacity ${ms / 1000}s`;
  loadingOverlay.style.opacity = '0';
  setTimeout(() => { loadingOverlay.remove(); onRemoved?.(); }, ms);
}
