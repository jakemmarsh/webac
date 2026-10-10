/**
 * The retail command table, assembled in InitializeCommands order
 * (ClientCommunicationSystem::InitializeCommands @ 00581970), plus the
 * Turbine-chat commands StartupTurbineChatSystem @ 0057efb0 adds once
 * Turbine chat is up. See CommandSystem.ts and docs/retail-commands/.
 */
import { CommandSystem, type CommandEntry } from './CommandSystem.js';
import { chatCommandEntries, turbineChatCommandEntries, type ChatCommandContext } from './ChatCommands.js';
import { deathTravelHouseCommandEntries, type DeathTravelHouseCommandContext } from './DeathTravelHouseCommands.js';
import { allegianceSocialCommandEntries, type AllegianceSocialCommandContext } from './AllegianceSocialCommands.js';
import { emoteStatusCommandEntries, type EmoteStatusCommandContext } from './EmoteStatusCommands.js';
import { textUiHelpCommandEntries, type TextUiHelpCommandContext } from './TextUiHelpCommands.js';

export * from './CommandSystem.js';

/** Everything the retail command handlers read from the client. */
export type RetailCommandContext =
  ChatCommandContext & DeathTravelHouseCommandContext & AllegianceSocialCommandContext
  & EmoteStatusCommandContext & TextUiHelpCommandContext;

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

  constructor(ctx: RetailCommandContext) {
    super(ctx, retailCommandEntries());
  }

  /**
   * StartupTurbineChatSystem: register the Turbine-chat commands (a, guild,
   * general, trade, lfg, roleplay, society, olthoi and aliases). `a`
   * replaces the allegiance-channel `a`. Idempotent.
   */
  startTurbineChat(): void {
    if (this.turbineStarted) return;
    this.turbineStarted = true;
    for (const e of turbineChatCommandEntries()) this.register(e as unknown as CommandEntry<RetailCommandContext>, true);
  }
}
