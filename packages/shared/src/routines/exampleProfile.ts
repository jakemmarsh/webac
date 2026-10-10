/**
 * A worked example profile: hunt nearby monsters, loot by rules, heal and
 * rest when low, sell at a vendor when the pack fills. Shown by the agent
 * tools (`ac_routines action=example`) as a starting point to edit.
 */
import type { RoutineProfile } from './RoutineDoc.js';

export const EXAMPLE_HUNT_PROFILE: RoutineProfile = {
  name: 'Hunt drudges near Holtburg',
  description: 'Fight drudges around the lifestone, keep health up, loot gems and pyreals, sell junk when full.',
  modules: { buffs: true, vitals: true, combat: true, looting: true, navigation: true, inventory: true, service: false },
  initialState: 'Hunt',
  states: [
    {
      name: 'Hunt',
      rules: [
        { label: 'Low health', when: [{ kind: 'vital-below', vital: 'health', percent: 40 }], do: [{ kind: 'set-state', state: 'Recover' }] },
        { label: 'Pack full', when: [{ kind: 'free-slots-below', slots: 3 }], do: [{ kind: 'set-state', state: 'Sell' }] },
        { label: 'Buffs down', when: [{ kind: 'buff-missing', spell: 'Strength Self I' }], do: [{ kind: 'cast-buffs', set: 'Basics' }] },
        { label: 'Fight', when: [{ kind: 'monster-within', meters: 40, names: ['Drudge'] }], do: [{ kind: 'attack-nearest', names: ['Drudge'], meters: 40 }, { kind: 'loot-nearby', meters: 20 }] },
        { label: 'Spend XP', when: [{ kind: 'unassigned-xp-above', xp: 5000 }], do: [{ kind: 'train', plan: [{ stat: 'Strength', upTo: 100 }, { stat: 'Endurance', upTo: 100 }, { stat: 'Coordination', upTo: 100 }, { stat: 'Health', upTo: 150 }] }] },
        { label: 'Look for more', when: [{ kind: 'always' }], do: [{ kind: 'follow-route', route: 'Lifestone loop' }] },
      ],
    },
    {
      name: 'Recover',
      rules: [
        { label: 'Healed', when: [{ kind: 'vital-above', vital: 'health', percent: 90 }], do: [{ kind: 'set-state', state: 'Hunt' }] },
        { label: 'Heal', when: [{ kind: 'item-count-below', item: 'Healing Kit', count: 1 }], do: [{ kind: 'wait', seconds: 5 }] },
        { label: 'Kit', when: [{ kind: 'always' }], do: [{ kind: 'use-item', item: 'Healing Kit', on: 'self' }, { kind: 'wait', seconds: 3 }] },
      ],
    },
    {
      name: 'Sell',
      rules: [
        { label: 'Done', when: [{ kind: 'not', condition: { kind: 'free-slots-below', slots: 10 } }], do: [{ kind: 'set-state', state: 'Hunt' }] },
        { label: 'Go sell', when: [{ kind: 'always' }], do: [{ kind: 'walk-to', coords: '42.1N, 33.6E' }, { kind: 'sell-by-loot-rules', vendor: 'Shopkeeper Renald the Elder' }] },
      ],
    },
  ],
  loot: [
    { label: 'Money', action: 'keep', match: { name: '^Pyreals?$' } },
    { label: 'Gems', action: 'keep', match: { types: ['Gem'] } },
    { label: 'Healing kits', action: 'keep-up-to', count: 5, match: { name: 'Healing Kit' } },
    { label: 'Valuable junk', action: 'sell', match: { valueAtLeast: 50 } },
    { label: 'Everything else', action: 'ignore', match: {} },
  ],
  buffSets: [{ name: 'Basics', spells: [{ spell: 'Strength Self I' }, { spell: 'Endurance Self I' }], rebuffBelowSeconds: 120 }],
  routes: [{ name: 'Lifestone loop', mode: 'circular', points: ['42.0N, 33.5E', '41.6N, 33.9E', '41.2N, 33.4E'] }],
};
