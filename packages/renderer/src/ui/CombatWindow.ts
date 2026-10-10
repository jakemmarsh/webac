/**
 * The EoL combat window (gmFloatyCombatUI) that hosts the spell bar and the
 * melee combat bar (BUG.spellbar-classic-clip):
 *  - the root HUD 0x21000005 authors it as slot 0x100006b5: (0,400) 610x90,
 *    edges L3 T2 R3 B1 (horizontally centred, 800 − 610 = 190 px split
 *    evenly; the bottom gap 600 − 490 = 110 px kept), WindowID 15, base
 *    element 0x100006a4 of layout 0x21000073;
 *  - 0x100006a4: resize limits p63 410 / p62 70 / p61 3000 / p60 90, a
 *    5 px frame (locked art 0x060074bf-c6, Dragbar/Resizebar set) round the
 *    body at (5,5) 600x80, which holds the two page slots 0x10000061 →
 *    0x21000010:0x1000009f (gmSpellcastingUI's classic 800x80 subtree,
 *    reflowed by its DAT edges) and 0x1000005c → 0x21000007:0x1000004b (the
 *    classic combat bar).
 */
export const COMBAT_WINDOW = {
  hudSlot: 0x100006b5, layout: 0x21000073, root: 0x100006a4,
  pageSlots: [0x10000061, 0x1000005c] as const,
  spellPage: { layout: 0x21000010, root: 0x1000009f },
  combatPage: { layout: 0x21000007, root: 0x1000004b },
  windowId: 15,
  width: 610, height: 90,
  /** Bottom gap of the authored slot (600 − (400 + 90)). */
  bottom: 110,
  body: { x: 5, y: 5, w: 600, h: 80 },
} as const;
