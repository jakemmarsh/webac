/**
 * The help text the Edit Meta Rule window's "?" buttons show (VirindiTank
 * 0.3.1.172: "Add new '?' button for some Meta configuration pages to display
 * help text"). The text is VTank's own description of each condition and
 * action from its wiki (Virindi_Tank_Meta_System, "Conditions (Left Side)" /
 * "Actions (Right Side)"), keyed by the names the window's menus use. The
 * wiki leaves Not and None undescribed; those two lines are ours.
 */
export const VT_CONDITION_HELP: Record<string, string> = {
  'Never': 'Never act upon.',
  'Always': 'Always act upon.',
  'Any': 'Act upon any.',
  'All': 'Act upon all.',
  'Chat Message': 'Act upon Chat Message.',
  'Pack Slots <=': 'Act upon Pack Slots less than or equal to X.',
  'Seconds in State >=': 'Act upon Seconds in State greater than or equal to X. Resets when macro is turned off and on.',
  'Navroute Empty': 'Act upon an empty Navroute.',
  'Character Death': 'Act upon Character Death.',
  'Any Vendor Open': 'Act upon Any Vendor Opened.',
  'Vendor Closed': 'Act upon Any Vendor Closed.',
  'Inventory Item Count <=': 'Act upon Inventory Item Count less than or equal to X of item.',
  'Inventory Item Count >=': 'Act upon Inventory Item Count greater than or equal to X of item.',
  'Monster Name Count Within Distance': 'Act upon X number of specific monster name within range of X.',
  'Monster Priority Count Within Distance': 'Act upon X number of priority monsters within range of X.',
  'Need to Buff': 'Act upon need to buff.',
  'No Monsters Within Distance': 'Act upon no monsters within range.',
  'Landblock ==': 'Act upon specific landblock (larger area).',
  'Landcell ==': 'Act upon specific landcell (smaller area).',
  'Portalspace Entered': 'Act upon entering portalspace.',
  'Portalspace Exited': 'Act upon exiting portalspace.',
  'Not': 'Act when the condition under it is false.',
  'Seconds in state (P) >=': 'Act upon Seconds in State greater than or equal to X. Does NOT reset when macro is turned off and on.',
  'Time Left On Spell >=': 'Act if a spell on your character has greater than a certain amount of time left on it.',
  'Burden Percent >=': 'Act if Burden Percent is greater or equal to a specified value.',
  'Dist Any Route Pt >=': 'Act if your character moves a certain distance away from any point in your route.',
  'Expression': 'Act upon an expression.',
  'Chat Message Capture': 'Allows you to perform a Regular Expression match on incoming chatbox text and save matched substrings to Meta variables for later use.',
  // Beyond VTank, Jake 2026-10-12: ours (VirindiTank had none of these), worded like the wiki's.
  'Attacked By Count >=': 'Act upon X or more creatures attacking you (their hits, misses and evades in the last 10 seconds).',
  'Being Cast At': 'Act upon a spell cast at you (landed, resisted or failed), or a creature nearby speaking a spell, in the last X seconds (5 when blank).',
  'No Monsters Near Point': 'Act upon no monsters within range of a point (map coordinates), not of you.',
  'No Monsters Near Object': 'Act upon no monsters within range of the nearest object of that name. Never true while the object is out of sight.',
  'My Corpse Within Distance': 'Act upon your own corpse (Corpse of <your name>) lying within range.',
};

export const VT_ACTION_HELP: Record<string, string> = {
  'None': 'Does nothing.',
  'Set Meta State': 'Allows you to set/change Meta state after X Action has occurred.',
  'Chat Command': 'On Action do X Chat Command. (eg. On Character Death do Chat Command /f I have died =( )',
  'All': 'Allows multiple Reactions to Occur.',
  'Load Embedded Navroute': 'Allows you to embed a navroute in to a meta.',
  'Call Meta State': 'Switches to another state and adds a return state to the call stack.',
  'Return From Call': 'Switches to the last state on the call stack, and removes it from the stack. If the call stack is empty, an error is raised and meta is disabled.',
  'Expression Action': 'Perform an expression action.',
  'Chat Expression': 'Output a chat expression.',
  'Set Watchdog': 'When you enter a state, you can set a watchdog. If at any time during that state your character has not moved from where they are for a certain amount of time, a second state is called.',
  'Clear Watchdog': 'Clears the current watchdog.',
  'Get VT Option': 'Gets the current value from the specified option and stores it in an expression variable.',
  'Set VT Option': 'Sets a VT option value based on the return value of an expression.',
  'Create View': 'Creates a new Meta View using XML.',
  'Destroy View': 'Destroys the specified meta view.',
  'Destroy All Views': 'Destroys all meta views.',
  // Beyond VTank, Jake 2026-10-12: ours (VirindiTank had none of these), worded like the wiki's.
  'Pull Monster': 'Attacks the nearest monster matching the name until one swing or shot lands, then runs back to the point (not stopping when hit). Then hold > 0 also holds position there.',
  'Hold Position': 'Fight nothing farther than Range from here (or the point given): the macro and its attacks never chase past it, e.g. down a ledge.',
  'Release Position': 'Clears Hold Position.',
  'Loot Corpse': 'Loots the corpse of that name (e.g. Corpse of Azreath Lightbringer) by the loot profile, not only your own kills.',
  'Recall Unless Attacked': 'Recalls (/ls, /hr, /mp, or a recall spell). If that many creatures attack you before it takes you, jumps to break the recall and runs clear.',
  'Flee To': 'Runs to the point and keeps going while hit (moving to a point stops to fight back).',
};
