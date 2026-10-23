/**
 * The retail command table, assembled in InitializeCommands order
 * (ClientCommunicationSystem::InitializeCommands @ 00581970), plus the
 * Turbine-chat commands StartupTurbineChatSystem @ 0057efb0 adds once
 * Turbine chat is up. See CommandSystem.ts and docs/retail-commands/.
 */
import { CommandSystem, type CommandEntry, type CommandTableStyle } from './CommandSystem.js';
import { chatCommandEntries, turbineChatCommandEntries, type ChatCommandContext } from './ChatCommands.js';
import { deathTravelHouseCommandEntries, type DeathTravelHouseCommandContext } from './DeathTravelHouseCommands.js';
import { allegianceSocialCommandEntries, type AllegianceSocialCommandContext } from './AllegianceSocialCommands.js';
import { emoteStatusCommandEntries, type EmoteStatusCommandContext } from './EmoteStatusCommands.js';
import { textUiHelpCommandEntries, type TextUiHelpCommandContext } from './TextUiHelpCommands.js';
import { ac1999CommandEntries, type Commands1999Context } from './Commands1999.js';

export * from './CommandSystem.js';

/** Everything the retail command handlers read from the client. */
export type RetailCommandContext =
  ChatCommandContext & DeathTravelHouseCommandContext & AllegianceSocialCommandContext
  & EmoteStatusCommandContext & TextUiHelpCommandContext & Commands1999Context;

/** InitializeCommands' registration order: help, allegiance, channels, chatting, death, …, text. */
export function retailCommandEntries(): CommandEntry<RetailCommandContext>[] {
  return [
    ...textUiHelpCommandEntries().filter((e) => e.name === '?' || e.name === 'help' || e.name === 'commands'),
    ...allegianceSocialCommandEntries(),
    ...chatCommandEntries(),
    ...deathTravelHouseCommandEntries(),
    ...emoteStatusCommandEntries(),
    ...textUiHelpCommandEntries().filter((e) => e.name !== '?' && e.name !== 'help' && e.name !== 'commands'),
  ] as unknown as CommandEntry<RetailCommandContext>[];
}

export class RetailCommandSystem extends CommandSystem<RetailCommandContext> {
  private turbineStarted = false;

  /**
   * `table`: the era's command table (EraClientRules.commandTable): end of retail's
   * InitializeCommands, or the 1999 client's 38 names (Commands1999.ts) with its channel handling.
   */
  constructor(ctx: RetailCommandContext, table: CommandTableStyle = 'eor') {
    super(ctx, table === 'ac1999' ? ac1999CommandEntries() : retailCommandEntries(), table);
  }

  /**
   * StartupTurbineChatSystem: register the Turbine-chat commands (a, guild,
   * general, trade, lfg, roleplay, society, olthoi and aliases). `a`
   * replaces the allegiance-channel `a`. Idempotent.
   */
  startTurbineChat(): void {
    // The 1999 client has no Turbine chat (a 1999 world never turns it on).
    if (this.turbineStarted || this.style === 'ac1999') return;
    this.turbineStarted = true;
    for (const e of turbineChatCommandEntries()) this.register(e as unknown as CommandEntry<RetailCommandContext>, true);
  }
}
