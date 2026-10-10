/**
 * DialogPanel -- NPC dialog panel state management.
 *
 * Pure logic layer: no DOM manipulation. Tracks the active NPC dialog,
 * dialog text, and available player responses for multi-page conversations.
 */

export interface DialogPanelResponse {
  id: number;
  text: string;
  action: string;
}

export class DialogPanel {
  private _visible = false;
  private _npcName = '';
  private _npcId = 0;
  private _dialogText = '';
  private _responses: DialogPanelResponse[] = [];

  get visible(): boolean {
    return this._visible;
  }

  get npcName(): string {
    return this._npcName;
  }

  get npcId(): number {
    return this._npcId;
  }

  get dialogText(): string {
    return this._dialogText;
  }

  get responses(): ReadonlyArray<DialogPanelResponse> {
    return this._responses;
  }

  /**
   * Open the dialog panel for a specific NPC with initial dialog content.
   */
  open(
    npcId: number,
    npcName: string,
    text: string,
    responses: DialogPanelResponse[],
  ): void {
    this._visible = true;
    this._npcId = npcId;
    this._npcName = npcName;
    this._dialogText = text;
    this._responses = responses;
  }

  /**
   * Close the dialog panel and clear all state.
   */
  close(): void {
    this._visible = false;
    this._npcName = '';
    this._npcId = 0;
    this._dialogText = '';
    this._responses = [];
  }

  /**
   * Update the dialog text and available responses (for multi-page dialogs).
   */
  setDialog(text: string, responses: DialogPanelResponse[]): void {
    this._dialogText = text;
    this._responses = responses;
  }

  /**
   * Select a response by its ID.
   * @returns the selected response, or undefined if not found
   */
  selectResponse(id: number): DialogPanelResponse | undefined {
    return this._responses.find((r) => r.id === id);
  }
}
