/**
 * GAP.barber-ui-retail — gmBarberUI drawn from its DAT layout
 * (LayoutDesc 0x21000068 root 0x10000599, at the smartbox slot
 * 0x2100000f:0x10000598 (20, 20)) and driven by BarberModel.ts, the port
 * of the decompiled page (reference/client-eol, gmBarberUI @ 004de1b0 ..
 * 004e0ec0).
 *
 * Every rect, texture and label is the layout's: the five face rows are
 * 0x2100004c:0x10000309 instances (arrows 0x1000030a / 0x1000030b from
 * 0x21000040:0x100002c6 / c7, ghosted art in state 0xd), the colour wheel is
 * the 0x2100004c:0x1000030c instance 0x1000059c (spots 0x1000030f..,
 * pointers 0x10000318.., disk 0x1000030e, shade scroll 0x10000321), the
 * rotate buttons 0x100005a4 / a5 are p11 toggles with state art 1 / 2 / 6 /
 * 7, Apply / Cancel the 0x21000040:0x100002cd dialog buttons and the option
 * checkboxes the 0x21000044:0x10000329 rows (gem 0x10000328). What the
 * page paints at run time — the coloured ColorBullet spots, the tinted
 * ColorRing or the GradientPlug, the lit pointer, the shade thumb, the
 * relabelled rows — is the model's, through the same ChargenColorWheel
 * helpers the chargen Appearance page uses. The 3D view 0x1000059b is a
 * gmCG3DView: the host draws the model's face into its canvas.
 */
import { datMissEpoch, noDatMissSince, onDatMissResolved } from '@ac/dat-parser/streaming/DatMiss.js';
import type { LayoutRenderer, PanelHandle } from './LayoutRenderer.js';
import type { ElementDesc } from '@ac/dat-parser/file-types/LayoutDesc.js';
import {
  BarberModel, BarberPart, BARBER_ELEMENTS, BARBER_LAYOUT, BARBER_ROOT, BARBER_SMARTBOX_SLOT,
  PART_ROW, ROW_ARROW_NEXT, ROW_ARROW_PREV, WHEEL_GRAD_CIRCLE, WHEEL_POINTER_BASE, WHEEL_SHADE_SCROLL,
  WHEEL_SPOT_BASE, STATE_GHOSTED, STATE_HIGHLIGHT, STATE_NORMAL,
  type BarberApplyResult, type BarberStringKey,
} from './BarberModel.js';
import {
  COLOR_WHEEL_SHADE_SCROLL, COLOR_WHEEL_SPOT_COUNT, colorBulletRGBA, gradDiskRGBA, rgbCss, shadeFromTrackY, shadeThumbTop,
  type ColorWheelAssets, type RgbaImage,
} from './ChargenColorWheel.js';
import {
  viewButtonStateId, headingToModelYaw, CHARGEN_VIEW_LIGHT_DIRECTION, CHARGEN_VIEW_LIGHT_INTENSITY,
} from './ChargenAppearanceView.js';
import { buildCreatureModeCamera } from './CreatureViewCamera.js';
import { buildCreatureModeScene, renderSceneToCanvas } from './CreatureViewRender.js';
import type { UIHost } from './UIHost.js';
import type * as THREE from 'three';

/** The UI state a hovered row arrow shows (0x100002c6 / c7: 1 normal, 2 rollover). */
const STATE_HOVER = 2;
/** The scroll thumb child id inside 0x10000321. */
const SHADE_THUMB = 0x1;
/** The checkbox gem child of the 0x21000044:0x10000329 rows. */
const CHECKBOX_GEM = 0x10000328;

export interface BarberPanelDeps {
  layoutRenderer: LayoutRenderer;
  /** The HUD layer the smartbox's 800x600 space maps onto. */
  parent: HTMLElement;
  model: BarberModel;
  /** DoColorSpots / DoGradDisk's UIASSET art (null without the DAT). */
  wheelAssets: ColorWheelAssets | null;
  /** `did`'s pixels through `paint` as an image URL (cached by `key`; null when it can't be drawn). */
  wheelImage(did: number, key: string, paint: (img: RgbaImage) => RgbaImage): string | null;
  /** A texture as an image URL (the empty spot / the plug). */
  textureUrl(did: number): string | null;
  /** A StringInfo token's text. */
  string(key: BarberStringKey): string | null;
  /** gmCG3DView::Update — draw the model's face at its heading into the viewport canvas. */
  renderPreview?(canvas: HTMLCanvasElement, model: BarberModel): void;
  /** Apply: the FinishBarber fields (null = nothing to send) and the local effects. */
  onApply(result: BarberApplyResult): void;
  /** The page hid (Apply or Cancel). */
  onClose?(): void;
  /** Timer::cur_time in seconds (default performance.now). */
  now?(): number;
}

/** One open gmBarberUI page. */
export class BarberPanel {
  readonly handle: PanelHandle;
  readonly model: BarberModel;
  private readonly deps: BarberPanelDeps;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly hover = { rotateClockwise: false, rotateCounterClockwise: false };
  private drawnRevision = -1;
  private drawnHeading = Number.NaN;
  private tick = 0;
  private closed = false;

  private constructor(handle: PanelHandle, deps: BarberPanelDeps) {
    this.handle = handle;
    this.deps = deps;
    this.model = deps.model;
    const viewport = handle.elements.get(BARBER_ELEMENTS.viewport);
    if (viewport) {
      const d = handle.descs.get(BARBER_ELEMENTS.viewport);
      const c = document.createElement('canvas');
      c.width = d?.width ?? 200;
      c.height = d?.height ?? 200;
      c.dataset.barberView = '1';
      Object.assign(c.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none' });
      viewport.appendChild(c);
      this.canvas = c;
    } else {
      this.canvas = null;
    }
    this.wire();
    this.paint();
  }

  /** Render the page into `deps.parent` and paint the model (RecvNotice_StartBarberNotice → SetVisible(1)). */
  static open(deps: BarberPanelDeps): BarberPanel | null {
    const handle = deps.layoutRenderer.renderPanel(BARBER_LAYOUT, deps.parent, {
      x: BARBER_SMARTBOX_SLOT.x, y: BARBER_SMARTBOX_SLOT.y, anchorLeft: true, subtreeElementId: BARBER_ROOT,
    });
    if (!handle) return null;
    const wrapper = handle.root.parentElement as HTMLElement | null;
    if (wrapper) wrapper.dataset.barber = '1';
    return new BarberPanel(handle, deps);
  }

  /** The page's root element (the rendered 0x10000599). */
  get root(): HTMLElement { return this.handle.root; }

  get isOpen(): boolean { return !this.closed; }

  /** SetVisible(0): the page goes away. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tick) cancelAnimationFrame(this.tick);
    this.tick = 0;
    this.handle.close();
    this.deps.onClose?.();
  }

  private el(id: number): HTMLElement | undefined { return this.handle.elements.get(id); }

  private desc(id: number): ElementDesc | undefined { return this.handle.descs.get(id); }

  /** A template child of one row (the arrow ids repeat under every row). */
  private rowChild(rowId: number, childId: number): HTMLElement | null {
    return (this.el(rowId)?.querySelector(`:scope > [data-element-id="0x${childId.toString(16)}"]`) as HTMLElement | null) ?? null;
  }

  private applyStateMedia(el: HTMLElement, desc: ElementDesc | undefined, state: number): void {
    const media = desc?.states.get(state)?.media;
    if (media && media.length > 0) this.deps.layoutRenderer.applyMediaToElement(el, media, 1);
    el.dataset.acState = state.toString(16);
  }

  private wire(): void {
    const E = BARBER_ELEMENTS;
    const m = this.model;
    const press = (el: HTMLElement | null | undefined, fn: () => void): void => {
      if (!el) return;
      el.style.pointerEvents = 'auto';
      el.style.cursor = 'pointer';
      el.addEventListener('click', (e) => { e.stopPropagation(); if (!this.closed) { fn(); this.paint(); } });
    };

    // The five rows (message 1 → SetSelection) and their arrows.
    for (const part of [BarberPart.Hair, BarberPart.Eyes, BarberPart.Nose, BarberPart.Mouth, BarberPart.Skin]) {
      const rowId = PART_ROW[part];
      const row = this.el(rowId);
      if (!row) continue;
      this.handle.setInteractive(rowId, () => { if (!this.closed) { m.clickRow(part); this.paint(); } });
      for (const [id, dir] of [[ROW_ARROW_PREV, -1], [ROW_ARROW_NEXT, 1]] as const) {
        const arrow = this.rowChild(rowId, id);
        if (!arrow) continue;
        const desc = this.desc(id);
        arrow.dataset.barberArrow = dir < 0 ? 'prev' : 'next';
        press(arrow, () => m.clickArrow(part, dir));
        arrow.addEventListener('mouseenter', () => { if (!m.ghostedArrowRows.has(rowId)) this.applyStateMedia(arrow, desc, STATE_HOVER); });
        arrow.addEventListener('mouseleave', () => { if (!m.ghostedArrowRows.has(rowId)) this.applyStateMedia(arrow, desc, STATE_NORMAL); });
      }
    }

    // The colour spots (0x1000030f + i, message 1 → SetColor(i) when i < iNumColors).
    for (let i = 0; i < COLOR_WHEEL_SPOT_COUNT; i++) {
      const spot = this.el(WHEEL_SPOT_BASE + i);
      if (spot) spot.dataset.barberSpot = String(i);
      press(spot, () => m.clickSpot(i));
    }

    // The shade scroll (message 10 → SetShade).
    const scroll = this.el(WHEEL_SHADE_SCROLL);
    if (scroll) {
      scroll.style.pointerEvents = 'auto';
      scroll.style.cursor = 'pointer';
      const setFromPointer = (clientY: number): void => {
        const rect = scroll.getBoundingClientRect();
        const y = ((clientY - rect.top) / (rect.height || 1)) * COLOR_WHEEL_SHADE_SCROLL.height;
        m.scrollShade(shadeFromTrackY(y));
        this.paint();
      };
      scroll.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setFromPointer(e.clientY);
        const move = (ev: MouseEvent): void => setFromPointer(ev.clientY);
        const up = (): void => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }

    // Rotate (p11 toggles: the release flips p14, then Rotate).
    const rotate = (id: number, key: 'rotateClockwise' | 'rotateCounterClockwise'): void => {
      const btn = this.el(id);
      if (!btn) return;
      btn.dataset.barberRotate = key;
      press(btn, () => {
        if (key === 'rotateClockwise') m.view.clickRotateClockwise(); else m.view.clickRotateCounterClockwise();
        this.startTicks();
      });
      btn.addEventListener('mouseenter', () => { this.hover[key] = true; this.paintRotateButtons(); });
      btn.addEventListener('mouseleave', () => { this.hover[key] = false; this.paintRotateButtons(); });
    };
    rotate(E.rotateClockwise, 'rotateClockwise');
    rotate(E.rotateCounterClockwise, 'rotateCounterClockwise');

    // The option checkbox (only 0x100005c9 is ever shown).
    press(this.el(E.option1), () => m.clickOption1());

    this.handle.setInteractive(E.apply, () => {
      if (this.closed) return;
      const result = m.apply();
      this.close();
      this.deps.onApply(result);
    });
    this.handle.setInteractive(E.cancel, () => { if (!this.closed) this.close(); });
  }

  /** Bring every element to the model's state. */
  paint(): void {
    if (this.closed) return;
    const E = BARBER_ELEMENTS;
    const m = this.model;
    // Spot colours whose palette had not streamed in yet.
    m.refreshSpotColors();
    const h = this.handle;

    // Rows: labels, visibility, the lit selection, the ghosted arrows, the Skin row's position.
    for (const part of [BarberPart.Hair, BarberPart.Eyes, BarberPart.Nose, BarberPart.Mouth, BarberPart.Skin]) {
      const rowId = PART_ROW[part];
      const row = this.el(rowId);
      if (!row) continue;
      if (m.hiddenRows.has(rowId)) { h.setVisible(rowId, false); continue; }
      const label = m.rowLabels.get(rowId);
      if (label && row.dataset.barberLabel !== label) {
        const text = this.deps.string(label);
        if (text) h.setText(rowId, text);
        row.dataset.barberLabel = label;
      }
      const want = rowId === m.selectedRow ? STATE_HIGHLIGHT : STATE_NORMAL;
      if (h.getState?.(rowId) !== want) h.setState(rowId, want);
      if (rowId === E.skinRow && m.skinRowY !== null) row.style.top = `${m.skinRowY}px`;
      if (m.ghostedArrowRows.has(rowId)) {
        for (const id of [ROW_ARROW_PREV, ROW_ARROW_NEXT]) {
          const arrow = this.rowChild(rowId, id);
          if (arrow && arrow.dataset.acState !== STATE_GHOSTED.toString(16)) {
            this.applyStateMedia(arrow, this.desc(id), STATE_GHOSTED);
            arrow.style.cursor = 'default';
          }
        }
      }
    }

    this.paintWheel();
    this.paintRotateButtons();

    // The options and the button row.
    const optIds = [E.option1, E.option2, E.option3];
    m.options.forEach((opt, i) => {
      const id = optIds[i];
      const el = this.el(id);
      if (!el) return;
      h.setVisible(id, opt.visible);
      if (!opt.visible) return;
      if (opt.label && el.dataset.barberLabel !== opt.label) {
        const text = this.deps.string(opt.label);
        if (text) h.setText(id, text);
        el.dataset.barberLabel = opt.label;
      }
      el.dataset.barberChecked = opt.checked ? '1' : '0';
      const gem = el.querySelector(`:scope > [data-element-id="0x${CHECKBOX_GEM.toString(16)}"]`) as HTMLElement | null;
      if (gem) this.applyStateMedia(gem, this.desc(CHECKBOX_GEM), opt.checked ? STATE_HIGHLIGHT : STATE_NORMAL);
    });
    const place = (id: number, p: { x: number; y: number }): void => {
      const el = this.el(id);
      if (el) { el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; }
    };
    place(E.apply, m.applyPos);
    place(E.cancel, m.cancelPos);

    this.drawPreview();
  }

  private paintWheel(): void {
    const w = this.model.wheel;
    const a = this.deps.wheelAssets;
    for (let i = 0; i < COLOR_WHEEL_SPOT_COUNT; i++) {
      const spot = this.el(WHEEL_SPOT_BASE + i);
      if (spot) {
        const c = i < w.spotCount ? w.spotColors[i] : null;
        let url: string | null = null;
        if (i < w.spotCount) {
          const col = c ?? { r: 0, g: 0, b: 0 };
          url = a ? this.deps.wheelImage(a.bullet, rgbCss(col), (img) => colorBulletRGBA(img, col)) : null;
          spot.dataset.barberSpotColor = rgbCss(col);
        } else {
          url = a ? this.deps.textureUrl(a.empty) : null;
          delete spot.dataset.barberSpotColor;
        }
        spot.dataset.barberSpotKind = i < w.spotCount ? 'bullet' : 'empty';
        spot.style.backgroundImage = url ? `url(${url})` : '';
        spot.style.backgroundRepeat = 'no-repeat';
      }
      this.handle.setVisible(WHEEL_POINTER_BASE + i, i === w.currentColor);
    }
    const disk = this.el(WHEEL_GRAD_CIRCLE);
    if (disk) {
      let url: string | null = null;
      if (w.gradPlug) {
        url = a ? this.deps.textureUrl(a.plug) : null;
        disk.dataset.barberDisk = 'plug';
        delete disk.dataset.barberDiskColor;
      } else {
        const col = w.gradColor;
        url = a && col ? this.deps.wheelImage(a.ring, `x${rgbCss(col)}`, (img) => gradDiskRGBA(img, col)) : null;
        disk.dataset.barberDisk = 'ring';
        if (col) disk.dataset.barberDiskColor = rgbCss(col); else delete disk.dataset.barberDiskColor;
      }
      disk.style.backgroundImage = url ? `url(${url})` : '';
      disk.style.backgroundRepeat = 'no-repeat';
    }
    const scroll = this.el(WHEEL_SHADE_SCROLL);
    if (scroll) {
      scroll.style.display = w.shadeVisible ? '' : 'none';
      scroll.dataset.barberShade = w.shade.toFixed(4);
      const thumb = scroll.querySelector(`:scope > [data-element-id="0x${SHADE_THUMB.toString(16)}"]`) as HTMLElement | null;
      if (thumb) thumb.style.top = `${shadeThumbTop(w.shade)}px`;
    }
  }

  private paintRotateButtons(): void {
    const v = this.model.view;
    const set = (id: number, lit: boolean, hover: boolean): void => {
      const st = viewButtonStateId(lit, hover);
      if (this.handle.getState?.(id) !== st) this.handle.setState(id, st);
    };
    set(BARBER_ELEMENTS.rotateClockwise, v.lit.rotateClockwise, this.hover.rotateClockwise);
    set(BARBER_ELEMENTS.rotateCounterClockwise, v.lit.rotateCounterClockwise, this.hover.rotateCounterClockwise);
  }

  /** gmCG3DView::Update / SetPlayerHeading — redraw when the face or the heading changed. */
  private drawPreview(): void {
    const m = this.model;
    if (!this.canvas || !this.deps.renderPreview) return;
    if (m.viewRevision === this.drawnRevision && m.view.heading === this.drawnHeading) return;
    this.drawnRevision = m.viewRevision;
    this.drawnHeading = m.view.heading;
    this.deps.renderPreview(this.canvas, m);
  }

  /** ListenToGlobalMessage(3): DoRotation every UI tick while rotating. */
  private startTicks(): void {
    if (this.tick || this.closed) return;
    const now = this.deps.now ?? ((): number => performance.now() / 1000);
    const step = (): void => {
      this.tick = 0;
      if (this.closed) return;
      if (this.model.view.tick(now())) this.drawPreview();
      this.paintRotateButtons();
      if (this.model.view.rotating) this.tick = requestAnimationFrame(step);
    };
    this.tick = requestAnimationFrame(step);
  }
}

/**
 * gmCG3DView for the barber (InitializePage @ 004e0040 → gmCG3DView::
 * Initialize / SetPlayerHeading(180) / SetCamera((0, −0.65, 1.7) or the
 * Gearknight / Olthoi (0, −0.8, 1.5), direction (0, 0, 0)) / SetLight(
 * DISTANT_LIGHT, 2.0, (0.3, 1.9, 0.65))): the CharGenState's model —
 * previewSetupId, the face over the rolled clothes — rebuilt when the face
 * changes, turned to m_fCurHeading, drawn at CreatureMode's π/4 FOV. The
 * page never calls StartAnimation: the figure keeps its placement pose.
 * No-op without the host's WebGL renderer (DOM tests).
 */
export function barberPreviewRenderer(host: Pick<UIHost, 'characterModelBuilder' | 'renderer'> | null | undefined):
  (canvas: HTMLCanvasElement, model: BarberModel) => void {
  let built: THREE.Group | null = null;
  let builtRevision = -1;
  let waitingForFiles = false;
  const render = (canvas: HTMLCanvasElement, m: BarberModel): void => {
    const builder = host?.characterModelBuilder;
    const renderer = host?.renderer;
    if (!builder || !renderer) return;
    if (!built || builtRevision !== m.viewRevision) {
      const missEpoch = datMissEpoch();
      built = builder.buildCharacterModel(m.heritage, m.gender, m.appearanceInfo(), m.previewSetupId);
      builtRevision = m.viewRevision;
      // Built while a streamed face / palette / texture file wasn't resident:
      // rebuild and redraw once it lands (the panel only redraws on a change).
      if (!noDatMissSince(missEpoch) && !waitingForFiles) {
        waitingForFiles = true;
        const unsubscribe = onDatMissResolved(() => {
          unsubscribe();
          waitingForFiles = false;
          built = null;
          if (canvas.isConnected) render(canvas, m);
        });
      }
    }
    if (!built) return;
    built.rotation.set(0, headingToModelYaw(m.view.heading), 0);
    const scene = buildCreatureModeScene(built, CHARGEN_VIEW_LIGHT_DIRECTION, CHARGEN_VIEW_LIGHT_INTENSITY);
    renderSceneToCanvas(renderer, scene, buildCreatureModeCamera(m.camera, canvas.width, canvas.height), canvas);
    scene.remove(built);
  };
  return render;
}
