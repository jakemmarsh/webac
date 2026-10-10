/**
 * Verify LayoutDesc parser works with actual client_local_English.dat and portal.dat.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { DatDatabase, DatReader, parseMasterProperty, setMasterPropertyTypes, parseLayoutDesc, parseStringTable, registerStringTable, getString, MediaType } from '@ac/dat-parser';

const PORTAL_PATH = 'dat/client_portal.dat';
const LANG_PATH = 'dat/client_local_English.dat';

const hasPortal = fs.existsSync(PORTAL_PATH);
const hasLang = fs.existsSync(LANG_PATH);

describe.skipIf(!hasPortal || !hasLang)('LayoutDesc Parser', () => {
  let portal: DatDatabase;
  let langDat: DatDatabase;
  let mpTypes: Map<number, number>;

  it('should parse MasterProperty from portal.dat', () => {
    const buf = fs.readFileSync(PORTAL_PATH);
    portal = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

    const mpData = portal.getFileData(0x39000001);
    expect(mpData).not.toBeNull();

    const reader = new DatReader(mpData!);
    mpTypes = parseMasterProperty(reader);
    expect(mpTypes.size).toBeGreaterThan(0);
    console.log(`MasterProperty: ${mpTypes.size} entries`);

    setMasterPropertyTypes(mpTypes);
  });

  it('should open language DAT', () => {
    const buf = fs.readFileSync(LANG_PATH);
    langDat = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(langDat.fileCount).toBe(118);
    expect(langDat.dataSet).toBe(3);
  });

  it('should parse LayoutDesc 0x21000000', () => {
    const data = langDat.getFileData(0x21000000);
    expect(data).not.toBeNull();

    const reader = new DatReader(data!);
    const layout = parseLayoutDesc(reader);
    expect(layout.id).toBe(0x21000000);
    expect(layout.displayWidth).toBeGreaterThan(0);
    expect(layout.displayHeight).toBeGreaterThan(0);
    expect(layout.elements.size).toBeGreaterThan(0);

    console.log(`Layout 0x21000000: ${layout.displayWidth}x${layout.displayHeight}, ${layout.elements.size} elements`);
  });

  it('should parse all 101 layout files without errors', () => {
    const layoutIds = langDat.listFileIds(0x21);
    expect(layoutIds.length).toBe(101);

    let totalElements = 0;
    let totalImages = 0;

    for (const id of layoutIds) {
      const data = langDat.getFileData(id);
      expect(data).not.toBeNull();

      const reader = new DatReader(data!);
      const layout = parseLayoutDesc(reader);
      expect(layout.id).toBe(id);

      totalElements += layout.elements.size;

      // Count image media references
      const countImages = (elements: Map<number, any>) => {
        for (const [, elem] of elements) {
          for (const m of elem.media) {
            if (m.type === MediaType.Image) totalImages++;
          }
          for (const [, state] of elem.states) {
            for (const m of state.media) {
              if (m.type === MediaType.Image) totalImages++;
            }
          }
          if (elem.children.size > 0) countImages(elem.children);
        }
      };
      countImages(layout.elements);
    }

    console.log(`Parsed all 101 layouts: ${totalElements} total elements, ${totalImages} image references`);
    expect(totalElements).toBeGreaterThan(0);
    expect(totalImages).toBeGreaterThan(0);
  });

  it('should parse StringTable 0x23000001', () => {
    const data = langDat.getFileData(0x23000001);
    expect(data).not.toBeNull();

    const reader = new DatReader(data!);
    const table = parseStringTable(reader);
    expect(table.id).toBe(0x23000001);
    expect(table.language).toBe(1); // English
    expect(table.entries.length).toBeGreaterThan(0);

    console.log(`StringTable 0x23000001: ${table.entries.length} entries, language=${table.language}`);

    // Check first entry has strings
    if (table.entries.length > 0) {
      const first = table.entries[0];
      console.log(`  First entry ID: 0x${first.id.toString(16)}, strings: ${first.strings.length}`);
      if (first.strings.length > 0) {
        console.log(`  First string: "${first.strings[0].substring(0, 80)}..."`);
      }
    }
  });

  it('should find texture/image references in layouts', () => {
    // Collect all unique texture DIDs referenced by Image media
    const textureDids = new Set<number>();
    const layoutIds = langDat.listFileIds(0x21);

    for (const id of layoutIds) {
      const data = langDat.getFileData(id);
      const reader = new DatReader(data!);
      const layout = parseLayoutDesc(reader);

      const collectTextures = (elements: Map<number, any>) => {
        for (const [, elem] of elements) {
          for (const m of elem.media) {
            if (m.type === MediaType.Image && m.file) textureDids.add(m.file);
          }
          for (const [, state] of elem.states) {
            for (const m of state.media) {
              if (m.type === MediaType.Image && m.file) textureDids.add(m.file);
            }
          }
          if (elem.children.size > 0) collectTextures(elem.children);
        }
      };
      collectTextures(layout.elements);
    }

    console.log(`\nUnique texture DIDs referenced by UI layouts: ${textureDids.size}`);
    const sorted = [...textureDids].sort((a, b) => a - b);
    for (const did of sorted.slice(0, 20)) {
      const exists = portal.hasFile(did);
      console.log(`  0x${did.toString(16).padStart(8, '0')} ${exists ? '✓ exists in portal.dat' : '✗ NOT FOUND'}`);
    }
    if (sorted.length > 20) {
      console.log(`  ... and ${sorted.length - 20} more`);
    }

    expect(textureDids.size).toBeGreaterThan(0);
  });

  it('should verify character panel frame textures (LayoutDesc 0x2100001c) exist in portal.dat', () => {
    // These are the authoritative frame/background textures for the classic
    // character info panel, referenced by LayoutDesc 0x2100001c element media:
    //   - 0x1000015e .. 0x1000015d (Attributes tab) content/edges
    //   - 0x10000141 .. 0x10000146 (Skills tab) content/edges
    //   - 0x1000012f .. 0x10000137 (Titles tab) content/edges
    // Matching textures must exist in portal.dat or the character panel will
    // fall back to a plain dark background instead of the stone-textured frame.
    const charPanelTextures: Record<string, number> = {
      stoneBody: 0x0600128a,    // 220x77 stone body fill
      bottomEdge: 0x060012bb,   // 292x4 bottom frame
      leftEdge: 0x060012bc,     // 2x337 left frame
      rightEdge: 0x060012bd,    // 4x337 right frame
      sepMain: 0x060012c5,      // 292x8 horizontal separator
      sepCap: 0x060012c4,       // 17x8 separator right cap
      titleBar: 0x06004cfa,     // 276x25 title bar (shared with other panels)
      closeBtnNormal: 0x06001393, // 24x25 close button (state 0)
      closeBtnHover: 0x06001394,  // 24x25 close button (state 1)
    };

    for (const [name, did] of Object.entries(charPanelTextures)) {
      expect(portal.hasFile(did), `Missing ${name} (0x${did.toString(16)})`).toBe(true);
    }

    // Also sanity-check: LayoutDesc 0x2100001c actually references these on
    // the tab content body elements. Walk the layout and collect media file IDs.
    const data = langDat.getFileData(0x2100001c);
    expect(data).not.toBeNull();
    const layout = parseLayoutDesc(new DatReader(data!));
    const referenced = new Set<number>();
    const walk = (elements: Map<number, any>) => {
      for (const [, elem] of elements) {
        for (const m of elem.media) {
          if (m.type === MediaType.Image && m.file) referenced.add(m.file);
        }
        for (const [, state] of elem.states) {
          for (const m of state.media) {
            if (m.type === MediaType.Image && m.file) referenced.add(m.file);
          }
        }
        if (elem.children.size > 0) walk(elem.children);
      }
    };
    walk(layout.elements);

    // Stone body, edges, and separator cap must be referenced by the layout.
    const mustReference = [0x0600128a, 0x060012bb, 0x060012bc, 0x060012bd, 0x060012c4, 0x060012c5];
    for (const did of mustReference) {
      expect(referenced.has(did), `LayoutDesc 0x2100001c should reference 0x${did.toString(16)}`).toBe(true);
    }
  });

  it('should verify shared panel frame element IDs (LayoutDesc 0x2100001a) used by examine/map/char panels', () => {
    // Multiple renderers use LayoutDesc 0x2100001a as their frame — character
    // panel (via 0x2100002e tab skeleton but borrowing 0x2100001a body), examine
    // panel, and map panel. They all read these specific element IDs by hand
    // (rootEl=0x1000011b, bodyEl=0x1000011c, close=0x100000fc, title=0x100000fe).
    // If the layout ever changes, panels will silently fail to apply stone frame.
    const data = langDat.getFileData(0x2100001a);
    expect(data).not.toBeNull();
    const layout = parseLayoutDesc(new DatReader(data!));
    const rootEl = layout.elements.get(0x1000011b);
    expect(rootEl, 'LayoutDesc 0x2100001a should have root 0x1000011b').toBeDefined();
    expect(rootEl!.children.get(0x1000011c), 'root should have body child 0x1000011c').toBeDefined();
    expect(rootEl!.children.get(0x100000fc), 'root should have close-button child 0x100000fc').toBeDefined();
    expect(rootEl!.children.get(0x100000fe), 'root should have title-bar child 0x100000fe').toBeDefined();
    // Body should itself have the inner content child 0x1000011d (262x337 content area).
    const bodyEl = rootEl!.children.get(0x1000011c)!;
    expect(bodyEl.children.get(0x1000011d), 'body should have content child 0x1000011d').toBeDefined();
  });

  it('VISUAL2.4: inventory panel (0x21000023) baked root position + 10px nudge lands on the radar dock boundary (0x21000017)', () => {
    // The right-dock column layout (0x21000017) stacks the radar frame
    // (root 0x1000017b at (491,28), radar control 0x1000003d at rel (9,0) ->
    // abs (500,28) 300x120) directly above its own body region (0x10000180
    // at rel (9,120) -> abs (500,148)) with no gap — retail's true dock
    // boundary is y=148. The inventory panel (0x21000023) has its own
    // DAT-baked root (0x100001cc) at abs (500,138), which is 10px *above*
    // that boundary, so its opaque title bar used to paint into the radar's
    // frame. GameUI.renderInventoryPanel nudges the panel wrapper down by
    // to the dock top instead (CORE.5: options.y = DOCK_TOP; CORE.5.b.b
    // moved the live dock top to 140 = the EoL floaty radar's bottom).
    // This test pins the CLASSIC family's DAT facts (layout 0x21000017 is
    // still real data even though the EoL HUD family replaced it on
    // screen) so the parser's absolute-geometry math stays honest.
    const dockData = langDat.getFileData(0x21000017);
    expect(dockData).not.toBeNull();
    const dockLayout = parseLayoutDesc(new DatReader(dockData!));
    const dockRoot = dockLayout.elements.get(0x1000017b);
    expect(dockRoot, 'radar dock root 0x1000017b missing').toBeDefined();
    const radarControl = dockRoot!.children.get(0x1000003d);
    expect(radarControl, 'radar control 0x1000003d missing').toBeDefined();
    const dockBody = dockRoot!.children.get(0x10000180);
    expect(dockBody, 'radar dock body 0x10000180 missing').toBeDefined();

    const radarAbsY = dockRoot!.y + radarControl!.y;
    const radarAbsBottom = radarAbsY + radarControl!.height;
    const dockBodyAbsY = dockRoot!.y + dockBody!.y;
    expect(radarAbsY, 'radar control abs y should be 28').toBe(28);
    expect(radarAbsBottom, 'radar control abs bottom should be 148').toBe(148);
    expect(dockBodyAbsY, 'radar dock body abs y (true stacking boundary) should be 148').toBe(radarAbsBottom);

    const invData = langDat.getFileData(0x21000023);
    expect(invData).not.toBeNull();
    const invLayout = parseLayoutDesc(new DatReader(invData!));
    const invRoot = invLayout.elements.get(0x100001cc);
    expect(invRoot, 'inventory panel root 0x100001cc missing').toBeDefined();
    expect(invRoot!.y, 'inventory panel baked root y should be 138').toBe(138);

    const INVENTORY_PANEL_Y_NUDGE = 10; // must match GameUI.ts renderInventoryPanel's renderPanel({ y: 10, ... })
    expect(invRoot!.y + INVENTORY_PANEL_Y_NUDGE, 'nudged inventory panel top should land exactly on the dock boundary').toBe(dockBodyAbsY);
  });

  it('should verify spellbook body texture (LayoutDesc 0x21000032) is 0x06004cc2', () => {
    // The spellbook uses a semi-transparent dark overlay (0x06004cc2) as its body
    // texture. The client must render this over an opaque base color or the HUD
    // behind the panel (radar, coord text) bleeds through.
    // This test pins the texture ID so a renderer change that drops the opaque
    // base is caught if it also changes the texture ID assumption.
    const data = langDat.getFileData(0x21000032);
    expect(data).not.toBeNull();
    const layout = parseLayoutDesc(new DatReader(data!));
    const root = layout.elements.get(0x10000294);
    expect(root, 'spellbook root 0x10000294 missing').toBeDefined();
    // Root's default state media is the body overlay.
    const rootMedia = root!.media.filter(m => m.type === MediaType.Image && m.file);
    expect(rootMedia.length).toBeGreaterThan(0);
    expect(rootMedia[0]!.file, 'spellbook root body texture should be 0x06004cc2').toBe(0x06004cc2);
    expect(portal.hasFile(0x06004cc2)).toBe(true);
  });

  it('should verify spell-bar tab labels (LayoutDesc 0x21000010) are Roman numerals I..VIII from StringTable 0x23000001', () => {
    // The classic_spellcasting panel (spell bar shown in Magic combat mode)
    // has 8 tabs at elements 0x100000a3..a9 + 0x100005c2. Each tab element
    // carries a p23 property ref to a StringTable entry that supplies the
    // visible tab label. In the retail client these are Roman numerals I..VIII
    // (reference: reference/images/hud/reddit-shutdown.jpg). The renderer
    // currently inlines SPELL_BAR_TAB_LABELS as a fallback until a generic
    // StringTable resolver is wired — this test pins the DAT truth so any
    // drift in string IDs or values gets caught.
    const expected = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
    const stringData = langDat.getFileData(0x23000001);
    expect(stringData).not.toBeNull();
    const table = parseStringTable(new DatReader(stringData!));
    for (let i = 0; i < 8; i++) {
      const stringId = 227814001 + i;
      const entry = table.entries.find(e => e.id === stringId);
      expect(entry, `StringTable entry ${stringId} missing`).toBeDefined();
      expect(entry!.strings.length).toBeGreaterThan(0);
      expect(entry!.strings[0], `tab ${i+1} label should be ${expected[i]}`).toBe(expected[i]);
    }
    // Cast button label (element 0x100000b2 p23 → 227743108).
    const castEntry = table.entries.find(e => e.id === 227743108);
    expect(castEntry, 'StringTable entry 227743108 (Cast) missing').toBeDefined();
    expect(castEntry!.strings[0]).toBe('Cast');
  });

  it('should pin combat-bar label string IDs (LayoutDesc 0x21000007) — Speed/Power/Accuracy', () => {
    // Combat bar renders three dynamic labels depending on combat mode:
    //   - Speed  = always shown on the left (element 0x10000051, p23=200023700)
    //   - Power  = shown on the right in Melee mode (0x10000052 state 268435459, str#199301346)
    //   - Accuracy = shown on the right in Missile mode (0x10000052 state 268435460, str#251543225)
    // If retail ever renames these, we want to catch it before shipping.
    const data = langDat.getFileData(0x23000001);
    expect(data).not.toBeNull();
    const table = parseStringTable(new DatReader(data!));
    const byId = new Map(table.entries.map(e => [e.id, e]));
    expect(byId.get(200023700)?.strings[0]).toBe('Speed');
    expect(byId.get(199301346)?.strings[0]).toBe('Power');
    expect(byId.get(251543225)?.strings[0]).toBe('Accuracy');
  });

  it('registerStringTable + getString resolve spell-bar tabs and Cast button', () => {
    // Integration test for the StringTable resolver used by GameUI.renderSpellBarPanel.
    // Loads StringTable 0x23000001, registers it, and verifies getString(id) returns
    // the expected strings for all 8 tabs plus the Cast button.
    const data = langDat.getFileData(0x23000001);
    expect(data).not.toBeNull();
    const table = parseStringTable(new DatReader(data!));
    registerStringTable(table);

    const expectedTabs = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
    for (let i = 0; i < 8; i++) {
      expect(getString(227814001 + i)).toBe(expectedTabs[i]);
    }
    expect(getString(227743108)).toBe('Cast');

    // Unknown IDs return null so callers can fall back to hardcoded defaults.
    expect(getString(0xdeadbeef)).toBeNull();
  });

  it('pins DAT button-label string IDs used by GameUI (Cancel/OK/Trade/Salvage/Create Fellowship)', () => {
    // GameUI now routes button labels through getString(id) instead of hardcoding.
    // These IDs are pinned so a DAT regeneration or rename is caught in CI rather
    // than silently flipping button text.
    const data = langDat.getFileData(0x23000001);
    expect(data).not.toBeNull();
    const table = parseStringTable(new DatReader(data!));
    registerStringTable(table);
    expect(getString(161092364)).toBe('Cancel');
    expect(getString(240826971)).toBe('OK');
    expect(getString(3474766)).toBe('Trade');
    expect(getString(243159829)).toBe('Salvage');
    expect(getString(120885742)).toBe('Create Fellowship');
  });

  it('pins DAT attribute-label string IDs used by GameUI (Strength/Endurance/Coordination/Quickness/Focus/Self)', () => {
    // GameUI ATTRIBUTE_LABELS now reads from DAT via the ATTRIBUTE_STRING_IDS map.
    // Pinned so any DAT rewording is caught in CI.
    const data = langDat.getFileData(0x23000001);
    expect(data).not.toBeNull();
    const table = parseStringTable(new DatReader(data!));
    registerStringTable(table);
    expect(getString(147524293)).toBe('Strength');
    expect(getString(30203877)).toBe('Endurance');
    expect(getString(26644053)).toBe('Coordination');
    expect(getString(92306277)).toBe('Quickness');
    expect(getString(4495749)).toBe('Focus');
    expect(getString(116081589)).toBe('Self');
  });

  it('pins DAT char-panel tab string IDs used by GameUI (Attributes/Skills/Titles)', () => {
    const data = langDat.getFileData(0x23000001);
    expect(data).not.toBeNull();
    const table = parseStringTable(new DatReader(data!));
    registerStringTable(table);
    expect(getString(123040450)).toBe('Attributes');
    expect(getString(94589922)).toBe('Skills');
    expect(getString(66110274)).toBe('Titles');
  });

  it('pins DAT vital-label and toolbar string IDs (Health/Stamina/Mana/Journal/Map)', () => {
    const data = langDat.getFileData(0x23000001);
    expect(data).not.toBeNull();
    const table = parseStringTable(new DatReader(data!));
    registerStringTable(table);
    expect(getString(163745349)).toBe('Health');
    expect(getString(252780597)).toBe('Stamina');
    expect(getString(204321781)).toBe('Mana');
    expect(getString(54441842)).toBe('Journal');
    expect(getString(148800818)).toBe('Map');
  });

  it('pins DAT char-gen slider string IDs in StringTable 0x23000002 (Eyes/Nose/Mouth)', () => {
    // Eyes/Nose/Mouth are in 0x23000002 (char-gen/heritage descriptions),
    // not the main UI 0x23000001. The renderer now loads BOTH tables at boot.
    const data = langDat.getFileData(0x23000002);
    expect(data).not.toBeNull();
    const table = parseStringTable(new DatReader(data!));
    registerStringTable(table);
    expect(getString(95516382)).toBe('Eyes');
    expect(getString(106748613)).toBe('Nose');
    expect(getString(97298888)).toBe('Mouth');
  });

  it('pins DAT vendor/fellowship/status string IDs (Buy/Fellowship/Burden/Online/Offline)', () => {
    // Vendor Buy tab, fellowship status indicator, inventory burden row,
    // fellowship member online/offline labels — all now DAT-sourced.
    const data = langDat.getFileData(0x23000001);
    expect(data).not.toBeNull();
    const table = parseStringTable(new DatReader(data!));
    registerStringTable(table);
    expect(getString(147125705)).toBe('Buy');
    expect(getString(10586626)).toBe('Fellowship');
    expect(getString(121922750)).toBe('Burden');
    expect(getString(6543900)).toBe('Online');
    expect(getString(144944252)).toBe('Offline');
  });

  it('pins DAT magic-school string IDs used by spellbook filters + getSchoolName (War/Life/Item/Creature)', () => {
    const data = langDat.getFileData(0x23000001);
    expect(data).not.toBeNull();
    const table = parseStringTable(new DatReader(data!));
    registerStringTable(table);
    expect(getString(141746946)).toBe('War');
    expect(getString(120244037)).toBe('Life');
    expect(getString(120250941)).toBe('Item');
    expect(getString(4167109)).toBe('Creature');
    // "Void" and "All"/"Cre" abbreviation are intentionally not in the DAT;
    // client-side fallback text is authoritative for those.
  });

  it('pins DAT full-phrase char-panel string IDs (Select an Attribute/Skill Credits/Unassigned Experience)', () => {
    // Three full-phrase UI strings in the char-panel attributes tab —
    // previously hardcoded, now routed through getString.
    const data = langDat.getFileData(0x23000001);
    expect(data).not.toBeNull();
    const table = parseStringTable(new DatReader(data!));
    registerStringTable(table);
    expect(getString(202231733)).toBe('Select an Attribute to Improve');
    expect(getString(230538876)).toBe('Skill Credits Available:');
    expect(getString(249332076)).toBe('Unassigned Experience:');
  });
});
