/**
 * The server's death lines, as the victim, a bystander and the victim's fellows read them, and the "You've lost …"
 * line that follows a death that dropped anything. Pure text: shared by the agent (AgentApi: the death tally) and the
 * stream feed (tools/stream/feed.ts: the overlay's death callouts).
 *
 * Sources:
 * - End of retail and Dark Majesty (ACE / ClassicACE): ACE.Server/Entity/Strings.cs, each damage type's DeathMessage
 *   (Killer, Victim, Broadcast; `{0}` = the victim's name, `{1}` = the killer's). Player_Death.OnDeath sends the
 *   Victim text to the victim (GameEventVictimNotification) and the Broadcast to players nearby (PlayerKilled);
 *   Fellowship.OnDeath tells each fellow "Your fellow {name} has died!". Player_Death.DropMessage builds "You've lost
 *   1,556 Pyreals, your Bracelet, and your Necklace!" (Broadcast chat), and Creature_Death adds "Your corpse is located
 *   at (…)." only outdoors and only when something dropped, so a death in a dungeon has no corpse line.
 * - AC1999: reference/ac1999/Server/Source/WeenieObject.cpp (victimMessage / otherMessage per damage type, a few worded
 *   differently: "You were fatally punctured by …", "… stabbing pain courtesy of …", "Blistered by …'s lightning, you
 *   fall!") and Player.cpp sendLostItemMessage (the same "You've lost …" shape).
 */

/** What the victim reads (`{1}` the killer, `{0}` the victim's own name). ACE first, then AC1999's own wordings. */
export const VICTIM_DEATH_TEMPLATES: readonly string[] = [
  // ACE Strings.cs (Slash, Pierce, Bludgeon, Fire, Cold, Acid, Electric, Nether, Critical, General).
  '{1} splits you apart!', '{1} cleaves you in twain!', "You are torn to ribbons by {1}'s assault!", "{1}'s killing blow nearly turns you inside-out!",
  '{1} runs you through!', 'You are fatally punctured by {1}!', 'Your perforated corpse falls before {1}!', 'Your death is preceded by a sharp, stabbing pain, courtesy of {1}!',
  '{1} beats you to a lifeless pulp!', "Your body is shattered by {1}'s attack!", "The force of {1}'s assault flattens you!", 'The thunder of {1} crushing {0} is followed by the deafening silence of your death!',
  '{1} brings you to a fiery end!', 'You are reduced to cinders by {1}!', "You are incinerated by {1}'s assault!", 'Your seared corpse smolders before {1}!',
  "{1}'s attack stops you cold!", "{1}'s assault sends you to an icy death!", 'You suffer a frozen fate at the hands of {1}!',
  "You are liquified by {1}'s attack!", 'Your last strength dissolves before {1}!', '{1} reduces you to a sizzling, oozing mass!',
  "Blistered by {1}'s lightning, you die!", "Electricity from {1}'s attack tears you apart!", "{1}'s lightning coruscates over your mortal remains!",
  "You are dessicated by {1}'s attack!", 'Your last strength withers before {1}!', '{1} reduces you to a drained, twisted corpse!',
  '{1} obliterates you!', '{1} smites you mightily!', '{1} knocks you into next Morningthaw!', "You are utterly destroyed by {1}'s attack!",
  "You catch {1}'s attack, with dire consequences!", '{1} slays you viciously enough to impart death several times over!',
  "The deadly force of {1}'s attack is so strong that your ancestors feel it!", '{1} sends you to your death so violently that even the lifestone flinches!',
  'You were killed by {1}!', 'You died!',
  // AC1999 (WeenieObject.cpp) where it differs.
  '{1} sends you to death so violently that even the lifestone flinches!', "Your body is shattered by {1}'s assault!", "The force of {1}'s assualt flattens you!",
  'The thunder of {1} crushing you is followed by the deafening silence of death!', 'Your death is preceded by a sharp, stabbing pain courtesy of {1}!',
  'You were fatally punctured by {1}!', '{1} tears you to ribbons!', "Blistered by {1}'s lightning, you fall!", "{1}'s electricity tears you apart!",
];

/** What players nearby read of someone else's death (`{0}` the victim, `{1}` the killer). ACE, then AC1999's own. */
export const BROADCAST_DEATH_TEMPLATES: readonly string[] = [
  '{1} splits {0} apart!', '{1} cleaves {0} in twain!', "{0} is torn to ribbons by {1}'s assault!", "{1}'s killing blow nearly turns {0} inside-out!",
  '{1} runs {0} through!', '{0} is fatally punctured by {1}!', "{0}'s perforated corpse falls before {1}!", "{0}'s death is preceded by a sharp, stabbing pain, courtesy of {1}!",
  '{1} beats {0} to a lifeless pulp!', "{0}'s body is shattered by {1}'s attack!", "The force of {1}'s assault flattens {0}!", 'The thunder of {1} crushing {0} is followed by the deafening silence of death!',
  '{1} brings {0} to a fiery end!', '{1} reduced {0} to cinders!', "{0} is incinerated by {1}'s assault!", "{0}'s seared corpse smolders before {1}!",
  "{1}'s attack stops {0} cold!", "{1}'s assault sends {0} to an icy death!", '{0} suffers a frozen fate at the hands of {1}!',
  "{0} is liquified by {1}'s attack!", "{0}'s last strength dissolves before {1}!", '{1} reduces {0} to a sizzling, oozing mass!',
  "Blistered by {1}'s lightning, {0} dies!", "Electricity from {1}'s attack tears {0} apart!", "{1}'s lightning coruscates over {0}'s mortal remains!",
  "{0} is dessicated by {1}'s attack!", "{0}'s last strength withers before {1}!", '{1} reduces {0} to a drained, twisted corpse!',
  '{1} obliterates {0}!', '{1} smites {0} mightily!', '{1} knocks {0} into next Morningthaw!', "{0} is utterly destroyed by {1}'s attack!",
  "{0} catches {1}'s attack, with dire consequences!", '{1} slays {0} viciously enough to impart death several times over!',
  "The deadly force of {1}'s attack is so strong that {0}'s ancestors feel it!", '{1} sends {0} to death so violently that even the lifestone flinches!',
  '{0} was killed by {1}!',
  // AC1999 where it differs.
  "{0}'s body is shattered by {1}'s assault!", "{0}'s death is preceded by a sharp, stabbing pain courtesy of {1}!", '{0} is torn to ribbons by {1}',
  '{1} smites {0} mightily',
];

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A template as a regex; `{0}` / `{1}` become the given patterns (named groups v / k when they capture). */
function templateRe(t: string, victim: string, killer: string): RegExp {
  let out = '';
  for (const part of t.split(/(\{[01]\})/)) {
    if (part === '{0}') out += victim;
    else if (part === '{1}') out += killer;
    else out += esc(part);
  }
  return new RegExp(`^${out}$`);
}

const VICTIM_RES = VICTIM_DEATH_TEMPLATES.map((t) => ({ t, re: templateRe(t, '.+?', '(?<k>.+?)') }));

/** A killer's name as printed: "the Olthoi Harvester" reads as "Olthoi Harvester". */
const cleanName = (n: string): string => n.trim().replace(/^the /i, '');

/**
 * The victim's own death line: `{ killer }` (null for "You died!", which names no one), or null when it isn't one.
 * A quoted line (someone's speech) never is.
 */
export function parseVictimDeathLine(text: string): { killer: string | null } | null {
  const line = text.trim();
  if (line.includes('"')) return null;
  for (const { re } of VICTIM_RES) {
    const m = re.exec(line);
    if (m) return { killer: m.groups?.k ? cleanName(m.groups.k) : null };
  }
  return null;
}

/**
 * Someone else's death as a bystander reads it, for one of `victims` (names; the bystander's fellows): the victim
 * and the killer, or null. Matching against known names keeps a killer's own kill lines and other text out.
 */
export function parseDeathBroadcast(text: string, victims: readonly string[]): { victim: string; killer: string } | null {
  const line = text.trim();
  if (line.includes('"')) return null;
  for (const v of victims) {
    if (!v || !line.includes(v)) continue;
    for (const t of BROADCAST_DEATH_TEMPLATES) {
      const m = templateRe(t, `(?<v>${esc(v)})`, '(?<k>.+?)').exec(line);
      if (m?.groups?.k) return { victim: v, killer: cleanName(m.groups.k) };
    }
  }
  return null;
}

/** ACE Fellowship.OnDeath: "Your fellow Claude Arcanist has died!" (to each other fellow). The fellow's name, or null. */
export function parseFellowDied(text: string): string | null {
  const m = /^Your fellow (.+) has died!$/.exec(text.trim());
  return m ? m[1] : null;
}

/** What a death cost, from the "You've lost …" line: the pyreals and each other thing ("Necklace", "5 Mana Stones"). */
export interface DeathLoss { pyreals: number; items: string[] }

/**
 * "You've lost 1,556 Pyreals, and your Necklace!" / "You've lost 778 Pyreals, your Bracelet, and your Necklace!" /
 * "You've lost your Necklace!" (ACE Player_Death.DropMessage; AC1999 Player.cpp sendLostItemMessage), or null.
 */
export function parseDeathLoss(text: string): DeathLoss | null {
  const m = /^You've lost (.+)!$/.exec(text.trim());
  if (!m) return null;
  let pyreals = 0;
  const items: string[] = [];
  for (let part of m[1].split(/, /)) {
    part = part.replace(/^and /, '').trim();
    if (!part) continue;
    const coins = /^([\d,]+) Pyreals?$/.exec(part);
    if (coins) { pyreals += Number(coins[1].replace(/,/g, '')); continue; }
    items.push(part.replace(/^your /, ''));
  }
  return { pyreals, items };
}

/** "778 pyreals, Bracelet and Necklace", or "nothing" (a death that dropped nothing has no line). */
export function lossText(l: DeathLoss | null | undefined): string {
  if (!l) return 'nothing dropped';
  const parts = [...(l.pyreals ? [`${l.pyreals.toLocaleString('en-US')} pyreals`] : []), ...l.items];
  if (!parts.length) return 'nothing dropped';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Heavy Bracelet ×3, Steel Toed Boots": repeated names counted, first-seen order. */
export function itemsText(items: readonly string[]): string {
  const n = new Map<string, number>();
  for (const i of items) n.set(i, (n.get(i) ?? 0) + 1);
  return [...n].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name)).join(', ');
}
