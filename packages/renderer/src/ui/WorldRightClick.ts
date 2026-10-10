/**
 * VISUAL.item-right-click-examine — the 3D world's right mouse button, as
 * retail's UIElement_SmartBoxWrapper does it: every right release
 * (MouseUp @ 004e5820) runs the object search with sr_Examine at the
 * release point — the object under the mouse becomes the selection and is
 * examined
 * (ClientUISystem::ExamineObject → CM_Item::Event_Appraise, IdentifyObject
 * 0x00C8). Retail has NO world right-click popup; the old invented
 * Attack / Talk / Trade / Pick Up menu is gone. (The RightClickToMouseLook
 * command, 0x0900010b, is unbound in both default KeyMaps.)
 *
 * SWEEP1006B.player-input.right-click-examine-dropped-when — MouseUp never
 * compares the release with the press (m_fMouseMovementActive is only ever
 * false, ctor @ 004e5120), and MouseDown @ 004e5700 stores no position for
 * the right button, so a right release examines however far the pointer
 * moved. The old 5 px "camera drag" threshold dropped those examines; with
 * Use Mouse Turning off a right drag moves no camera in either client.
 */

export interface WorldRightClickDeps<Hit extends { guid: number }> {
  /** The world is up and picking is possible. */
  isReady: () => boolean;
  /** The object under the event's client coords. */
  pick: (event: MouseEvent) => Hit | null;
  /** Use Mouse Turning is on: the right button holds mouse-look and never examines. */
  rightButtonIsMouseLook?: () => boolean;
  /** sr_Examine found `hit`: select it and examine it. */
  onExamine: (hit: Hit) => void;
}

export class WorldRightClick<Hit extends { guid: number }> {
  constructor(private readonly deps: WorldRightClickDeps<Hit>) {}

  /** Canvas mouseup — a right release over an object examines it. */
  readonly onCanvasMouseUp = (event: MouseEvent): void => {
    if (event.button !== 2 || !this.deps.isReady()) return;
    if (this.deps.rightButtonIsMouseLook?.()) return;
    const hit = this.deps.pick(event);
    if (hit) this.deps.onExamine(hit);
  };
}
