/** Which Mag-Tools options this client runs (kept apart from the runtime so the window's GameUI side imports no agent code). */
import type { MtOptionDef } from '@ac/shared';

/**
 * The options whose feature runs in this client (the window shows only these; no dead-end UI):
 * item info on identify (not its clipboard / left-click parts), the chat filters, auto trade
 * add / accept, open main pack on login, log out on death, the corpse and player trackers and the
 * chat logger's Keep Persistent Logs.
 */
export function mtOptionWired(d: Pick<MtOptionDef, 'path'>): boolean {
  if (/^ItemInfoOnIdent\./.test(d.path)) return !/AutoClipboard|LeftClickIdent/.test(d.path);
  return /^Filters\./.test(d.path) || /^(CorpseTracker|PlayerTracker)\./.test(d.path) || [
    'AutoTradeAdd.Enabled', 'AutoTradeAccept.Enabled', 'Misc.OpenMainPackOnLogin', 'Misc.LogOutOnDeath', 'ChatLogger.Persistent',
  ].includes(d.path);
}
