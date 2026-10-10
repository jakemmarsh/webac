// AUTO-GENERATED from portal.dat KeyMap 0x14000000 "gmDefaultMap" + 0x14000002 "DefaultMap"
// and ActionMap 0x26000000 — do not hand-edit. Regenerate: npx tsx tools/gen-keybind-defaults.mjs
// (CORE.17.k.b.b.a.g.f — the conversion is packages/renderer/src/input/KeyMapDefaults.ts).

/** The two retail KeyMap files, in the client's merge order. */
export const RETAIL_KEYMAP_FILES: ReadonlyArray<{ id: number; name: string }> = [
  { id: 0x14000000, name: "gmDefaultMap" },
  { id: 0x14000002, name: "DefaultMap" },
];

/** actionId → canonical KeybindRegistry codes, in DAT order (Mapping 1 / 2 / 3). Keyboard + mouse devices. */
export const RETAIL_DEFAULT_KEYBINDS: Record<number, string[]> = {
  [0x29]: ["KeyW","ArrowUp"], // Move Forward
  [0x2a]: ["KeyX","ArrowDown"], // Move Backward
  [0x2b]: ["KeyS"], // Stop Moving
  [0x2c]: ["KeyC","Alt+KeyD","Alt+ArrowRight"], // Strafe Right
  [0x2d]: ["KeyZ","Alt+KeyA","Alt+ArrowLeft"], // Strafe Left
  [0x2e]: ["KeyD","ArrowRight"], // Turn Right
  [0x2f]: ["KeyA","ArrowLeft"], // Turn Left
  [0x30]: ["KeyQ"], // Autorun
  [0x31]: ["Space"], // Jump
  [0x32]: ["ShiftLeft"], // Toggle Run/Walk
  [0x33]: ["NumpadSubtract"], // Zoom Camera In
  [0x34]: ["NumpadAdd"], // Zoom Camera Out
  [0x35]: ["Numpad4"], // Rotate Camera Left
  [0x36]: ["Numpad6"], // Rotate Camera Right
  [0x37]: ["Numpad8"], // Rotate Camera Up
  [0x38]: ["Numpad2"], // Rotate Camera Down
  [0x39]: ["Numpad0"], // Move Camera to Default
  [0x3a]: ["NumpadDecimal"], // First Person Camera
  [0x3b]: ["Numpad5"], // Overhead View
  [0x3c]: ["NumpadEnter"], // Map View
  [0x3d]: ["MouseButton2"], // Toggle Mouselook
  [0x3e]: ["NumpadDivide","F2"], // Toggle Alternate Camera Mode
  [0x55]: ["NumpadMultiply"], // Take Screenshot
  [0x7b]: ["F1"], // Open Help
  [0x7c]: ["Ctrl+Shift+F1"], // Display Plugin Manager
  [0x1000000e]: ["F3"], // Show/Hide Allegiance Page
  [0x1000000f]: ["F4"], // Show/Hide Fellowship Page
  [0x10000011]: ["F5"], // Show/Hide Spellbook Page
  [0x10000012]: ["F6"], // Show/Hide Spell Components Page
  [0x10000014]: ["F8"], // Show/Hide Attributes Page
  [0x10000015]: ["F9"], // Show/Hide Skills Page
  [0x10000016]: ["F10"], // Show/Hide World Panel
  [0x10000019]: ["F12"], // Show/Hide Inventory Panel
  [0x1000001a]: ["F11"], // Show/Hide Options Panel
  [0x10000023]: ["Enter"], // Begin Chat Mode
  [0x10000024]: ["Tab"], // Enter/Exit Chat Mode
  [0x10000025]: ["KeyR"], // Use Selected Object
  [0x10000026]: ["Shift+Escape"], // End Character Session
  [0x1000002b]: ["KeyE"], // Examine Selected Object
  [0x1000002c]: ["KeyF"], // Place Selected Object in Inventory
  [0x1000002d]: ["KeyT"], // Split Selected Stack
  [0x1000002e]: ["KeyP"], // Select Previous Selection
  [0x1000002f]: ["Backspace"], // Select Closest Compass Item
  [0x10000030]: ["Minus"], // Select Previous Compass Item
  [0x10000031]: ["Equal"], // Select Next Compass Item
  [0x10000032]: ["Backslash"], // Select Closest Item
  [0x10000033]: ["BracketLeft"], // Select Previous Item
  [0x10000034]: ["BracketRight"], // Select Next Item
  [0x10000035]: ["Quote"], // Select Closest Monster
  [0x10000036]: ["KeyL"], // Select Previous Monster
  [0x10000037]: ["Semicolon"], // Select Next Monster
  [0x10000038]: ["Home"], // Select Last Attacker
  [0x10000039]: ["Slash"], // Select Closest Player
  [0x1000003a]: ["Comma"], // Select Previous Player
  [0x1000003b]: ["Period"], // Select Next Player
  [0x1000003c]: ["KeyN"], // Select Previous Fellow
  [0x1000003d]: ["KeyM"], // Select Next Fellow
  [0x10000042]: ["Digit1","Ctrl+Digit1"], // Quickslot 1
  [0x10000043]: ["Digit2","Ctrl+Digit2"], // Quickslot 2
  [0x10000044]: ["Digit3","Ctrl+Digit3"], // Quickslot 3
  [0x10000045]: ["Digit4","Ctrl+Digit4"], // Quickslot 4
  [0x10000046]: ["Digit5","Ctrl+Digit5"], // Quickslot 5
  [0x10000047]: ["Digit6","Ctrl+Digit6"], // Quickslot 6
  [0x10000048]: ["Digit7","Ctrl+Digit7"], // Quickslot 7
  [0x10000049]: ["Digit8","Ctrl+Digit8"], // Quickslot 8
  [0x1000004a]: ["Digit9","Ctrl+Digit9"], // Quickslot 9
  [0x1000004b]: ["Alt+Digit1"], // Quickslot 10
  [0x1000004c]: ["Alt+Digit2"], // Quickslot 11
  [0x1000004d]: ["Alt+Digit3"], // Quickslot 12
  [0x1000005a]: ["Backquote"], // Toggle Combat Mode
  [0x1000005b]: ["Insert"], // Decrease Power
  [0x1000005c]: ["PageUp"], // Increase Power
  [0x1000005d]: ["Delete"], // Low Attack
  [0x1000005e]: ["End"], // Medium Attack
  [0x1000005f]: ["PageDown"], // High Attack
  [0x10000060]: ["End"], // Cast Spell
  [0x10000061]: ["Delete"], // Previous Spell
  [0x10000062]: ["PageDown"], // Next Spell
  [0x10000063]: ["Insert"], // Previous Spell Tab
  [0x10000064]: ["PageUp"], // Next Spell Tab
  [0x10000065]: ["Digit1"], // Spell Slot 1
  [0x10000066]: ["Digit2"], // Spell Slot 2
  [0x10000067]: ["Digit3"], // Spell Slot 3
  [0x10000068]: ["Digit4"], // Spell Slot 4
  [0x10000069]: ["Digit5"], // Spell Slot 5
  [0x1000006a]: ["Digit6"], // Spell Slot 6
  [0x1000006b]: ["Digit7"], // Spell Slot 7
  [0x1000006c]: ["Digit8"], // Spell Slot 8
  [0x1000006d]: ["Digit9"], // Spell Slot 9
  [0x10000094]: ["KeyY"], // Ready
  [0x10000095]: ["KeyH"], // Crouch
  [0x10000096]: ["KeyG"], // Sit
  [0x10000097]: ["KeyB"], // Lay Down
  [0x100000a2]: ["KeyO"], // Cheer
  [0x100000a7]: ["KeyU"], // Cry
  [0x100000b2]: ["KeyI"], // Laugh
  [0x100000be]: ["KeyK"], // Point State
  [0x100000e5]: ["KeyJ"], // Wave
  [0x100000ef]: ["Insert"], // Decrease Accuracy
  [0x100000f0]: ["PageUp"], // Increase Accuracy
  [0x100000f1]: ["Delete"], // Low Attack
  [0x100000f2]: ["End"], // Medium Attack
  [0x100000f3]: ["PageDown"], // High Attack
  [0x10000102]: ["Ctrl+Delete"], // First Spell
  [0x10000103]: ["Ctrl+PageDown"], // Last Spell
  [0x10000104]: ["Ctrl+Insert"], // First Spell Tab
  [0x10000105]: ["Ctrl+PageUp"], // Last Spell Tab
  [0x1000010d]: ["Digit0","Ctrl+Digit0"], // Create Shortcut
  [0x10000114]: ["Alt+Digit1"], // Toggle Floating Chat Window 1
  [0x10000115]: ["Alt+Digit2"], // Toggle Floating Chat Window 2
  [0x10000116]: ["Alt+Digit3"], // Toggle Floating Chat Window 3
  [0x10000117]: ["Alt+Digit4"], // Toggle Floating Chat Window 4
  [0x10000132]: ["Alt+Digit4"], // Quickslot 13
  [0x10000133]: ["Alt+Digit5"], // Quickslot 14
  [0x10000134]: ["Alt+Digit6"], // Quickslot 15
  [0x10000135]: ["Alt+Digit7"], // Quickslot 16
  [0x10000136]: ["Alt+Digit8"], // Quickslot 17
  [0x10000137]: ["Alt+Digit9"], // Quickslot 18
};

/** actionId → the ActionMap input map (KeyMap section) that owns it. */
export const ACTION_INPUT_MAP: Record<number, number> = {
  [0x29]: 0x4,
  [0x2a]: 0x4,
  [0x2b]: 0x4,
  [0x2c]: 0x4,
  [0x2d]: 0x4,
  [0x2e]: 0x4,
  [0x2f]: 0x4,
  [0x30]: 0x4,
  [0x31]: 0x4,
  [0x32]: 0x4,
  [0x33]: 0x5,
  [0x34]: 0x5,
  [0x35]: 0x5,
  [0x36]: 0x5,
  [0x37]: 0x5,
  [0x38]: 0x5,
  [0x39]: 0x5,
  [0x3a]: 0x5,
  [0x3b]: 0x5,
  [0x3c]: 0x5,
  [0x3d]: 0x5,
  [0x3e]: 0x5,
  [0x55]: 0x10000009,
  [0x7b]: 0x10000009,
  [0x7c]: 0x10000009,
  [0x10000003]: 0x10000009,
  [0x10000005]: 0x10000009,
  [0x10000006]: 0x10000009,
  [0x10000007]: 0x10000009,
  [0x10000009]: 0x10000009,
  [0x1000000b]: 0x10000009,
  [0x1000000c]: 0x10000009,
  [0x1000000d]: 0x10000009,
  [0x1000000e]: 0x10000009,
  [0x1000000f]: 0x10000009,
  [0x10000010]: 0x10000009,
  [0x10000011]: 0x10000009,
  [0x10000012]: 0x10000009,
  [0x10000013]: 0x10000009,
  [0x10000014]: 0x10000009,
  [0x10000015]: 0x10000009,
  [0x10000016]: 0x10000009,
  [0x10000017]: 0x10000009,
  [0x10000018]: 0x10000009,
  [0x10000019]: 0x10000009,
  [0x1000001a]: 0x10000009,
  [0x1000001b]: 0x10000009,
  [0x1000001c]: 0x10000009,
  [0x1000001d]: 0x10000009,
  [0x1000001e]: 0x10000009,
  [0x1000001f]: 0x10000009,
  [0x10000020]: 0x1000000a,
  [0x10000021]: 0x1000000a,
  [0x10000022]: 0x1000000a,
  [0x10000023]: 0x1000000a,
  [0x10000024]: 0x1000000d,
  [0x10000025]: 0x10000009,
  [0x10000026]: 0x10000009,
  [0x10000028]: 0x1000000a,
  [0x1000002a]: 0x10000007,
  [0x1000002b]: 0x10000009,
  [0x1000002c]: 0x10000007,
  [0x1000002d]: 0x10000007,
  [0x1000002e]: 0x10000007,
  [0x1000002f]: 0x10000007,
  [0x10000030]: 0x10000007,
  [0x10000031]: 0x10000007,
  [0x10000032]: 0x10000007,
  [0x10000033]: 0x10000007,
  [0x10000034]: 0x10000007,
  [0x10000035]: 0x10000007,
  [0x10000036]: 0x10000007,
  [0x10000037]: 0x10000007,
  [0x10000038]: 0x10000007,
  [0x10000039]: 0x10000007,
  [0x1000003a]: 0x10000007,
  [0x1000003b]: 0x10000007,
  [0x1000003c]: 0x10000007,
  [0x1000003d]: 0x10000007,
  [0x1000003e]: 0x10000007,
  [0x1000003f]: 0x10000007,
  [0x10000040]: 0x10000007,
  [0x10000041]: 0x10000007,
  [0x10000042]: 0x1000000c,
  [0x10000043]: 0x1000000c,
  [0x10000044]: 0x1000000c,
  [0x10000045]: 0x1000000c,
  [0x10000046]: 0x1000000c,
  [0x10000047]: 0x1000000c,
  [0x10000048]: 0x1000000c,
  [0x10000049]: 0x1000000c,
  [0x1000004a]: 0x1000000c,
  [0x1000004b]: 0x1000000c,
  [0x1000004c]: 0x1000000c,
  [0x1000004d]: 0x1000000c,
  [0x1000004e]: 0x1000000c,
  [0x1000004f]: 0x1000000c,
  [0x10000050]: 0x1000000c,
  [0x10000051]: 0x1000000c,
  [0x10000052]: 0x1000000c,
  [0x10000053]: 0x1000000c,
  [0x10000054]: 0x1000000c,
  [0x10000055]: 0x1000000c,
  [0x10000056]: 0x1000000c,
  [0x1000005a]: 0x10000002,
  [0x1000005b]: 0x10000003,
  [0x1000005c]: 0x10000003,
  [0x1000005d]: 0x10000003,
  [0x1000005e]: 0x10000003,
  [0x1000005f]: 0x10000003,
  [0x10000060]: 0x10000005,
  [0x10000061]: 0x10000005,
  [0x10000062]: 0x10000005,
  [0x10000063]: 0x10000005,
  [0x10000064]: 0x10000005,
  [0x10000065]: 0x10000005,
  [0x10000066]: 0x10000005,
  [0x10000067]: 0x10000005,
  [0x10000068]: 0x10000005,
  [0x10000069]: 0x10000005,
  [0x1000006a]: 0x10000005,
  [0x1000006b]: 0x10000005,
  [0x1000006c]: 0x10000005,
  [0x1000006d]: 0x10000005,
  [0x1000006e]: 0x10000005,
  [0x1000006f]: 0x10000005,
  [0x10000070]: 0x10000005,
  [0x10000071]: 0x10000008,
  [0x10000072]: 0x10000008,
  [0x10000073]: 0x10000008,
  [0x10000074]: 0x10000008,
  [0x10000076]: 0x10000008,
  [0x10000077]: 0x10000008,
  [0x10000078]: 0x10000008,
  [0x10000079]: 0x10000008,
  [0x1000007a]: 0x10000008,
  [0x1000007b]: 0x10000008,
  [0x1000007c]: 0x10000008,
  [0x1000007d]: 0x10000008,
  [0x1000007e]: 0x10000008,
  [0x1000007f]: 0x10000008,
  [0x10000080]: 0x10000008,
  [0x10000081]: 0x10000008,
  [0x10000082]: 0x10000008,
  [0x10000083]: 0x10000008,
  [0x10000085]: 0x10000008,
  [0x10000086]: 0x10000008,
  [0x10000087]: 0x10000008,
  [0x10000088]: 0x10000008,
  [0x10000089]: 0x10000008,
  [0x1000008a]: 0x10000008,
  [0x1000008b]: 0x10000008,
  [0x1000008c]: 0x10000008,
  [0x1000008d]: 0x10000008,
  [0x1000008e]: 0x10000008,
  [0x1000008f]: 0x10000008,
  [0x10000090]: 0x10000008,
  [0x10000091]: 0x10000008,
  [0x10000092]: 0x10000008,
  [0x10000093]: 0x10000008,
  [0x10000094]: 0x4,
  [0x10000095]: 0x4,
  [0x10000096]: 0x4,
  [0x10000097]: 0x4,
  [0x10000098]: 0x10000006,
  [0x10000099]: 0x10000006,
  [0x1000009a]: 0x10000006,
  [0x1000009b]: 0x10000006,
  [0x1000009c]: 0x10000006,
  [0x1000009d]: 0x10000006,
  [0x1000009e]: 0x10000006,
  [0x1000009f]: 0x10000006,
  [0x100000a0]: 0x10000006,
  [0x100000a1]: 0x10000006,
  [0x100000a2]: 0x10000006,
  [0x100000a3]: 0x10000006,
  [0x100000a4]: 0x10000006,
  [0x100000a5]: 0x10000006,
  [0x100000a6]: 0x10000006,
  [0x100000a7]: 0x10000006,
  [0x100000a8]: 0x10000006,
  [0x100000a9]: 0x10000006,
  [0x100000aa]: 0x10000006,
  [0x100000ab]: 0x10000006,
  [0x100000ac]: 0x10000006,
  [0x100000ad]: 0x10000006,
  [0x100000ae]: 0x10000006,
  [0x100000af]: 0x10000006,
  [0x100000b0]: 0x10000006,
  [0x100000b1]: 0x10000006,
  [0x100000b2]: 0x10000006,
  [0x100000b3]: 0x10000006,
  [0x100000b4]: 0x10000006,
  [0x100000b5]: 0x10000006,
  [0x100000b6]: 0x10000006,
  [0x100000b7]: 0x10000006,
  [0x100000b8]: 0x10000006,
  [0x100000b9]: 0x10000006,
  [0x100000ba]: 0x10000006,
  [0x100000bb]: 0x10000006,
  [0x100000bc]: 0x10000006,
  [0x100000bd]: 0x10000006,
  [0x100000be]: 0x10000006,
  [0x100000bf]: 0x10000006,
  [0x100000c0]: 0x10000006,
  [0x100000c1]: 0x10000006,
  [0x100000c2]: 0x10000006,
  [0x100000c3]: 0x10000006,
  [0x100000c4]: 0x10000006,
  [0x100000c5]: 0x10000006,
  [0x100000c6]: 0x10000006,
  [0x100000c7]: 0x10000006,
  [0x100000c8]: 0x10000006,
  [0x100000c9]: 0x10000006,
  [0x100000ca]: 0x10000006,
  [0x100000cb]: 0x10000006,
  [0x100000cc]: 0x10000006,
  [0x100000cd]: 0x10000006,
  [0x100000ce]: 0x10000006,
  [0x100000cf]: 0x10000006,
  [0x100000d0]: 0x10000006,
  [0x100000d1]: 0x10000006,
  [0x100000d2]: 0x10000006,
  [0x100000d3]: 0x10000006,
  [0x100000d4]: 0x10000006,
  [0x100000d5]: 0x10000006,
  [0x100000d6]: 0x10000006,
  [0x100000d7]: 0x10000006,
  [0x100000d8]: 0x10000006,
  [0x100000d9]: 0x10000006,
  [0x100000da]: 0x10000006,
  [0x100000db]: 0x10000006,
  [0x100000dc]: 0x10000006,
  [0x100000dd]: 0x10000006,
  [0x100000de]: 0x10000006,
  [0x100000df]: 0x10000006,
  [0x100000e0]: 0x10000006,
  [0x100000e1]: 0x10000006,
  [0x100000e2]: 0x10000006,
  [0x100000e3]: 0x10000006,
  [0x100000e4]: 0x10000006,
  [0x100000e5]: 0x10000006,
  [0x100000e6]: 0x10000006,
  [0x100000e7]: 0x10000006,
  [0x100000e8]: 0x10000006,
  [0x100000e9]: 0x10000006,
  [0x100000ea]: 0x10000006,
  [0x100000eb]: 0x10000006,
  [0x100000ec]: 0x10000006,
  [0x100000ed]: 0x10000006,
  [0x100000ee]: 0x10000006,
  [0x100000ef]: 0x10000004,
  [0x100000f0]: 0x10000004,
  [0x100000f1]: 0x10000004,
  [0x100000f2]: 0x10000004,
  [0x100000f3]: 0x10000004,
  [0x10000102]: 0x10000005,
  [0x10000103]: 0x10000005,
  [0x10000104]: 0x10000005,
  [0x10000105]: 0x10000005,
  [0x1000010d]: 0x1000000c,
  [0x1000010e]: 0x10000008,
  [0x1000010f]: 0x10000008,
  [0x10000110]: 0x10000008,
  [0x10000112]: 0x10000008,
  [0x10000114]: 0x10000009,
  [0x10000115]: 0x10000009,
  [0x10000116]: 0x10000009,
  [0x10000117]: 0x10000009,
  [0x10000118]: 0x10000009,
  [0x10000119]: 0x1000000a,
  [0x1000011a]: 0x10000009,
  [0x1000011b]: 0x10000008,
  [0x1000011c]: 0x10000007,
  [0x1000011d]: 0x10000008,
  [0x1000011e]: 0x10000008,
  [0x1000011f]: 0x10000008,
  [0x10000120]: 0x10000008,
  [0x10000121]: 0x10000007,
  [0x10000122]: 0x10000007,
  [0x10000123]: 0x10000008,
  [0x10000125]: 0x10000008,
  [0x10000127]: 0x10000009,
  [0x10000128]: 0x10000009,
  [0x10000129]: 0x10000009,
  [0x1000012a]: 0x10000008,
  [0x1000012c]: 0x10000008,
  [0x1000012e]: 0x10000009,
  [0x1000012f]: 0x10000008,
  [0x10000132]: 0x1000000c,
  [0x10000133]: 0x1000000c,
  [0x10000134]: 0x1000000c,
  [0x10000135]: 0x1000000c,
  [0x10000136]: 0x1000000c,
  [0x10000137]: 0x1000000c,
  [0x1000013e]: 0x10000008,
};

/** inputMapId → the input maps the ActionMap declares co-active with it (InputMapConflicts). */
export const INPUT_MAP_COACTIVE: Record<number, number[]> = {
  [0x4]: [0x5, 0x10000002, 0x10000003, 0x10000004, 0x10000005, 0x10000006, 0x10000007, 0x1000000c, 0x10000008, 0x10000009, 0x1000000d, 0x1000000a, 0x4],
  [0x5]: [0x4, 0x10000002, 0x10000003, 0x10000004, 0x10000005, 0x10000006, 0x10000007, 0x1000000c, 0x10000008, 0x10000009, 0x1000000d, 0x1000000a, 0x5],
  [0x7]: [0x8, 0xa, 0x7],
  [0x8]: [0x7, 0xa, 0x8],
  [0xa]: [0x7, 0x8, 0xa],
  [0x10000002]: [0x4, 0x5, 0x10000003, 0x10000004, 0x10000005, 0x10000006, 0x10000007, 0x1000000c, 0x10000008, 0x10000009, 0x1000000d, 0x1000000a, 0x10000002],
  [0x10000003]: [0x4, 0x5, 0x10000002, 0x10000007, 0x1000000c, 0x10000008, 0x10000009, 0x1000000d, 0x1000000a, 0x10000003],
  [0x10000004]: [0x4, 0x5, 0x10000002, 0x10000007, 0x1000000c, 0x10000008, 0x10000009, 0x1000000d, 0x1000000a, 0x10000004],
  [0x10000005]: [0x4, 0x5, 0x10000002, 0x10000007, 0x10000008, 0x10000009, 0x1000000d, 0x1000000a, 0x10000005],
  [0x10000006]: [0x4, 0x5, 0x10000002, 0x10000007, 0x1000000c, 0x10000008, 0x10000009, 0x1000000d, 0x1000000a, 0x10000006],
  [0x10000007]: [0x4, 0x5, 0x10000002, 0x10000003, 0x10000004, 0x10000005, 0x10000006, 0x1000000c, 0x10000008, 0x10000009, 0x1000000d, 0x1000000a, 0x10000007],
  [0x10000008]: [0x4, 0x5, 0x10000002, 0x10000003, 0x10000004, 0x10000005, 0x10000006, 0x10000007, 0x1000000c, 0x10000009, 0x1000000d, 0x1000000a, 0x10000008],
  [0x10000009]: [0x4, 0x5, 0x10000002, 0x10000003, 0x10000004, 0x10000005, 0x10000006, 0x10000007, 0x1000000c, 0x10000008, 0x1000000d, 0x1000000a, 0x10000009],
  [0x1000000a]: [0x4, 0x5, 0x10000002, 0x10000003, 0x10000004, 0x10000005, 0x10000006, 0x10000007, 0x1000000c, 0x10000008, 0x10000009, 0x1000000d, 0x1000000a],
  [0x1000000c]: [0x4, 0x5, 0x10000002, 0x10000003, 0x10000004, 0x10000006, 0x10000007, 0x10000008, 0x10000009, 0x1000000d, 0x1000000a, 0x1000000c],
  [0x1000000d]: [0x4, 0x5, 0x10000002, 0x10000003, 0x10000004, 0x10000005, 0x10000006, 0x10000007, 0x1000000c, 0x10000008, 0x10000009, 0x1000000a, 0x1000000d],
};

/**
 * CORE.17.k.b.b.a.g.f.a — inputMapId → actionId → codes of every (section, action)
 * pair in the two KeyMaps (the dialog's row for an action under a map it does
 * not own — the alternate-camera map 0x6 — reads its keys here).
 */
export const RETAIL_SECTION_KEYBINDS: Record<number, Record<number, string[]>> = {
  [0x4]: {
    [0x29]: ["KeyW","ArrowUp"], // Move Forward
    [0x2a]: ["KeyX","ArrowDown"], // Move Backward
    [0x2b]: ["KeyS"], // Stop Moving
    [0x2c]: ["KeyC","Alt+KeyD","Alt+ArrowRight"], // Strafe Right
    [0x2d]: ["KeyZ","Alt+KeyA","Alt+ArrowLeft"], // Strafe Left
    [0x2e]: ["KeyD","ArrowRight"], // Turn Right
    [0x2f]: ["KeyA","ArrowLeft"], // Turn Left
    [0x30]: ["KeyQ"], // Autorun
    [0x31]: ["Space"], // Jump
    [0x32]: ["ShiftLeft"], // Toggle Run/Walk
    [0x10000094]: ["KeyY"], // Ready
    [0x10000095]: ["KeyH"], // Crouch
    [0x10000096]: ["KeyG"], // Sit
    [0x10000097]: ["KeyB"], // Lay Down
  },
  [0x5]: {
    [0x33]: ["NumpadSubtract"], // Zoom Camera In
    [0x34]: ["NumpadAdd"], // Zoom Camera Out
    [0x35]: ["Numpad4"], // Rotate Camera Left
    [0x36]: ["Numpad6"], // Rotate Camera Right
    [0x37]: ["Numpad8"], // Rotate Camera Up
    [0x38]: ["Numpad2"], // Rotate Camera Down
    [0x39]: ["Numpad0"], // Move Camera to Default
    [0x3a]: ["NumpadDecimal"], // First Person Camera
    [0x3b]: ["Numpad5"], // Overhead View
    [0x3c]: ["NumpadEnter"], // Map View
    [0x3d]: ["MouseButton2"], // Toggle Mouselook
    [0x3e]: ["NumpadDivide","F2"], // Toggle Alternate Camera Mode
  },
  [0x6]: {
    [0x35]: ["ArrowLeft"], // Rotate Camera Left
    [0x36]: ["ArrowRight"], // Rotate Camera Right
    [0x37]: ["ArrowUp"], // Rotate Camera Up
    [0x38]: ["ArrowDown"], // Rotate Camera Down
  },
  [0x10000002]: {
    [0x1000005a]: ["Backquote"], // Toggle Combat Mode
  },
  [0x10000003]: {
    [0x1000005b]: ["Insert"], // Decrease Power
    [0x1000005c]: ["PageUp"], // Increase Power
    [0x1000005d]: ["Delete"], // Low Attack
    [0x1000005e]: ["End"], // Medium Attack
    [0x1000005f]: ["PageDown"], // High Attack
  },
  [0x10000004]: {
    [0x100000ef]: ["Insert"], // Decrease Accuracy
    [0x100000f0]: ["PageUp"], // Increase Accuracy
    [0x100000f1]: ["Delete"], // Low Attack
    [0x100000f2]: ["End"], // Medium Attack
    [0x100000f3]: ["PageDown"], // High Attack
  },
  [0x10000005]: {
    [0x10000060]: ["End"], // Cast Spell
    [0x10000061]: ["Delete"], // Previous Spell
    [0x10000062]: ["PageDown"], // Next Spell
    [0x10000063]: ["Insert"], // Previous Spell Tab
    [0x10000064]: ["PageUp"], // Next Spell Tab
    [0x10000065]: ["Digit1"], // Spell Slot 1
    [0x10000066]: ["Digit2"], // Spell Slot 2
    [0x10000067]: ["Digit3"], // Spell Slot 3
    [0x10000068]: ["Digit4"], // Spell Slot 4
    [0x10000069]: ["Digit5"], // Spell Slot 5
    [0x1000006a]: ["Digit6"], // Spell Slot 6
    [0x1000006b]: ["Digit7"], // Spell Slot 7
    [0x1000006c]: ["Digit8"], // Spell Slot 8
    [0x1000006d]: ["Digit9"], // Spell Slot 9
    [0x10000102]: ["Ctrl+Delete"], // First Spell
    [0x10000103]: ["Ctrl+PageDown"], // Last Spell
    [0x10000104]: ["Ctrl+Insert"], // First Spell Tab
    [0x10000105]: ["Ctrl+PageUp"], // Last Spell Tab
  },
  [0x10000006]: {
    [0x100000a2]: ["KeyO"], // Cheer
    [0x100000a7]: ["KeyU"], // Cry
    [0x100000b2]: ["KeyI"], // Laugh
    [0x100000be]: ["KeyK"], // Point State
    [0x100000e5]: ["KeyJ"], // Wave
  },
  [0x10000007]: {
    [0x1000002c]: ["KeyF"], // Place Selected Object in Inventory
    [0x1000002d]: ["KeyT"], // Split Selected Stack
    [0x1000002e]: ["KeyP"], // Select Previous Selection
    [0x1000002f]: ["Backspace"], // Select Closest Compass Item
    [0x10000030]: ["Minus"], // Select Previous Compass Item
    [0x10000031]: ["Equal"], // Select Next Compass Item
    [0x10000032]: ["Backslash"], // Select Closest Item
    [0x10000033]: ["BracketLeft"], // Select Previous Item
    [0x10000034]: ["BracketRight"], // Select Next Item
    [0x10000035]: ["Quote"], // Select Closest Monster
    [0x10000036]: ["KeyL"], // Select Previous Monster
    [0x10000037]: ["Semicolon"], // Select Next Monster
    [0x10000038]: ["Home"], // Select Last Attacker
    [0x10000039]: ["Slash"], // Select Closest Player
    [0x1000003a]: ["Comma"], // Select Previous Player
    [0x1000003b]: ["Period"], // Select Next Player
    [0x1000003c]: ["KeyN"], // Select Previous Fellow
    [0x1000003d]: ["KeyM"], // Select Next Fellow
  },
  [0x10000009]: {
    [0x55]: ["NumpadMultiply"], // Take Screenshot
    [0x7b]: ["F1"], // Open Help
    [0x7c]: ["Ctrl+Shift+F1"], // Display Plugin Manager
    [0x1000000e]: ["F3"], // Show/Hide Allegiance Page
    [0x1000000f]: ["F4"], // Show/Hide Fellowship Page
    [0x10000011]: ["F5"], // Show/Hide Spellbook Page
    [0x10000012]: ["F6"], // Show/Hide Spell Components Page
    [0x10000014]: ["F8"], // Show/Hide Attributes Page
    [0x10000015]: ["F9"], // Show/Hide Skills Page
    [0x10000016]: ["F10"], // Show/Hide World Panel
    [0x10000019]: ["F12"], // Show/Hide Inventory Panel
    [0x1000001a]: ["F11"], // Show/Hide Options Panel
    [0x10000025]: ["KeyR"], // Use Selected Object
    [0x10000026]: ["Shift+Escape"], // End Character Session
    [0x1000002b]: ["KeyE"], // Examine Selected Object
    [0x10000114]: ["Alt+Digit1"], // Toggle Floating Chat Window 1
    [0x10000115]: ["Alt+Digit2"], // Toggle Floating Chat Window 2
    [0x10000116]: ["Alt+Digit3"], // Toggle Floating Chat Window 3
    [0x10000117]: ["Alt+Digit4"], // Toggle Floating Chat Window 4
  },
  [0x1000000a]: {
    [0x10000023]: ["Enter"], // Begin Chat Mode
  },
  [0x1000000c]: {
    [0x10000042]: ["Digit1","Ctrl+Digit1"], // Quickslot 1
    [0x10000043]: ["Digit2","Ctrl+Digit2"], // Quickslot 2
    [0x10000044]: ["Digit3","Ctrl+Digit3"], // Quickslot 3
    [0x10000045]: ["Digit4","Ctrl+Digit4"], // Quickslot 4
    [0x10000046]: ["Digit5","Ctrl+Digit5"], // Quickslot 5
    [0x10000047]: ["Digit6","Ctrl+Digit6"], // Quickslot 6
    [0x10000048]: ["Digit7","Ctrl+Digit7"], // Quickslot 7
    [0x10000049]: ["Digit8","Ctrl+Digit8"], // Quickslot 8
    [0x1000004a]: ["Digit9","Ctrl+Digit9"], // Quickslot 9
    [0x1000004b]: ["Alt+Digit1"], // Quickslot 10
    [0x1000004c]: ["Alt+Digit2"], // Quickslot 11
    [0x1000004d]: ["Alt+Digit3"], // Quickslot 12
    [0x1000010d]: ["Digit0","Ctrl+Digit0"], // Create Shortcut
    [0x10000132]: ["Alt+Digit4"], // Quickslot 13
    [0x10000133]: ["Alt+Digit5"], // Quickslot 14
    [0x10000134]: ["Alt+Digit6"], // Quickslot 15
    [0x10000135]: ["Alt+Digit7"], // Quickslot 16
    [0x10000136]: ["Alt+Digit8"], // Quickslot 17
    [0x10000137]: ["Alt+Digit9"], // Quickslot 18
  },
  [0x1000000d]: {
    [0x10000024]: ["Tab"], // Enter/Exit Chat Mode
  },
};
