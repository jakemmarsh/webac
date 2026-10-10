/**
 * Phase 34 — UI Core (UIManager, CharacterCreate, CharacterSelect, HUD)
 *
 * Tests:
 *  - UIManager pushes/pops screens correctly
 *  - CharacterCreate wizard produces valid character (attributes=330, skills within budget)
 *  - HUD vital bars reflect PlayerState changes
 *  - Compass heading matches camera yaw
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  Heritage, Gender, SkillAdvancementClass,
  ATTRIBUTE_MIN, ATTRIBUTE_MAX, DEFAULT_ATTRIBUTE_CREDITS,
  VitalId, AttributeId, StatModType,
} from '@ac/shared';
import { UIManager } from '../packages/renderer/src/ui/UIManager.js';
import type { ScreenType, PanelType } from '../packages/renderer/src/ui/UIManager.js';
import { CharacterCreateWizard, CreateStep } from '../packages/renderer/src/ui/CharacterCreate.js';
import { CharacterSelectScreen } from '../packages/renderer/src/ui/CharacterSelect.js';
import type { CharacterSlot } from '../packages/renderer/src/ui/CharacterSelect.js';
import { HUD } from '../packages/renderer/src/ui/HUD.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import type { CharacterInfo } from '../packages/renderer/src/player/PlayerState.js';

// ============================================================
// D1: UIManager
// ============================================================
describe('Phase 34 — UI Core', () => {
  describe('UIManager', () => {
    let ui: UIManager;

    beforeEach(() => {
      ui = new UIManager();
    });

    it('should start with empty screen stack', () => {
      expect(ui.currentScreen).toBeUndefined();
      expect(ui.screenDepth).toBe(0);
    });

    it('should push and pop screens', () => {
      ui.pushScreen('loading');
      expect(ui.currentScreen).toBe('loading');
      expect(ui.screenDepth).toBe(1);

      ui.pushScreen('character-select');
      expect(ui.currentScreen).toBe('character-select');
      expect(ui.screenDepth).toBe(2);

      const popped = ui.popScreen();
      expect(popped).toBe('character-select');
      expect(ui.currentScreen).toBe('loading');
      expect(ui.screenDepth).toBe(1);
    });

    it('should set screen (replace entire stack)', () => {
      ui.pushScreen('loading');
      ui.pushScreen('character-create');
      ui.setScreen('game');
      expect(ui.currentScreen).toBe('game');
      expect(ui.screenDepth).toBe(1);
    });

    it('should emit screen-change events', () => {
      const events: any[] = [];
      ui.on('screen-change', (screen: any) => events.push(screen));

      ui.pushScreen('loading');
      ui.pushScreen('game');
      ui.popScreen();

      expect(events).toEqual(['loading', 'game', 'loading']);
    });

    it('should manage panels (open/close/toggle)', () => {
      expect(ui.isPanelOpen('inventory')).toBe(false);

      ui.openPanel('inventory');
      expect(ui.isPanelOpen('inventory')).toBe(true);
      expect(ui.activePanels).toContain('inventory');

      ui.togglePanel('inventory');
      expect(ui.isPanelOpen('inventory')).toBe(false);

      ui.togglePanel('spellbook');
      expect(ui.isPanelOpen('spellbook')).toBe(true);
    });

    it('should close all panels', () => {
      ui.openPanel('inventory');
      ui.openPanel('spellbook');
      ui.openPanel('map');
      expect(ui.activePanels.length).toBe(3);

      ui.closeAllPanels();
      expect(ui.activePanels.length).toBe(0);
    });

    it('should track input focus and game input state', () => {
      expect(ui.gameInputActive).toBe(true);

      ui.inputFocused = true;
      expect(ui.gameInputActive).toBe(false);

      ui.inputFocused = false;
      expect(ui.gameInputActive).toBe(true);

      ui.openPanel('inventory');
      expect(ui.gameInputActive).toBe(false);
    });

    it('should emit panel events', () => {
      const opened: string[] = [];
      const closed: string[] = [];
      ui.on('panel-open', (p: string) => opened.push(p));
      ui.on('panel-close', (p: string) => closed.push(p));

      ui.openPanel('inventory');
      ui.closePanel('inventory');
      expect(opened).toEqual(['inventory']);
      expect(closed).toEqual(['inventory']);
    });

    it('should support on/off for event listeners', () => {
      let count = 0;
      const handler = () => count++;
      ui.on('screen-change', handler);
      ui.pushScreen('loading');
      expect(count).toBe(1);

      ui.off('screen-change', handler);
      ui.pushScreen('game');
      expect(count).toBe(1); // not called again
    });
  });

  // ============================================================
  // D2: CharacterCreate Wizard
  // ============================================================
  describe('CharacterCreateWizard', () => {
    let wizard: CharacterCreateWizard;

    beforeEach(() => {
      wizard = new CharacterCreateWizard();
    });

    it('should start at Heritage step', () => {
      expect(wizard.currentStep).toBe(CreateStep.Heritage);
    });

    it('should have 6 total steps', () => {
      expect(wizard.totalSteps).toBe(6);
    });

    it('should initialize attributes to minimum (10 each)', () => {
      expect(wizard.attributes.strength).toBe(ATTRIBUTE_MIN);
      expect(wizard.attributeTotal).toBe(60); // 6 * 10
      expect(wizard.attributesRemaining).toBe(DEFAULT_ATTRIBUTE_CREDITS - 60); // 270
    });

    it('should navigate steps forward and backward', () => {
      // EoL order per DAT 0x21000039: Heritage → Profession → Skills →
      // Appearance → Town → Summary
      expect(wizard.canGoNext).toBe(true); // Heritage has a default
      wizard.nextStep();
      expect(wizard.currentStep).toBe(CreateStep.Profession);

      wizard.nextStep(); // Profession → Skills
      expect(wizard.currentStep).toBe(CreateStep.Skills);

      wizard.prevStep();
      expect(wizard.currentStep).toBe(CreateStep.Profession);
    });

    it('should not go back from Heritage', () => {
      expect(wizard.canGoBack).toBe(false);
      expect(wizard.prevStep()).toBe(false);
    });

    it('should set heritage and gender', () => {
      wizard.setHeritage(Heritage.Gharundim);
      expect(wizard.heritage).toBe(Heritage.Gharundim);

      wizard.setGender(Gender.Female);
      expect(wizard.gender).toBe(Gender.Female);
    });

    it('should allocate attributes within credit budget', () => {
      expect(wizard.setAttribute('strength', 100)).toBe(true);
      expect(wizard.attributes.strength).toBe(100);
      expect(wizard.attributesRemaining).toBe(DEFAULT_ATTRIBUTE_CREDITS - 60 - 90); // 180

      expect(wizard.setAttribute('endurance', 100)).toBe(true);
      expect(wizard.setAttribute('coordination', 100)).toBe(true);
      // Now used: 100 + 100 + 100 + 10 + 10 + 10 = 330 exactly
      expect(wizard.attributeTotal).toBe(330);
      expect(wizard.attributesRemaining).toBe(0);

      // CORE.17.k.b.b.a.f — CharGenState::Set<Attr>(value, 1): a rise the
      // credits cannot cover is paid by the other unlocked attributes
      // (BalanceAttributes drains Strength first), never refused while an
      // unlocked attribute above 10 remains.
      expect(wizard.setAttribute('quickness', 11)).toBe(true);
      expect(wizard.attributes.quickness).toBe(11);
      expect(wizard.attributes.strength).toBe(99);
      expect(wizard.attributesRemaining).toBe(0);

      // With every other attribute locked, GetAbsRemainingCredits is 0 and
      // the rise is refused (Set<Attr> returns the old value).
      for (const attr of ['strength', 'endurance', 'coordination', 'focus', 'self'] as const) wizard.lockAttribute(attr, true);
      expect(wizard.setAttribute('quickness', 12)).toBe(false);
      expect(wizard.attributes.quickness).toBe(11); // unchanged
    });

    it('should clamp attributes to [10, 100]', () => {
      wizard.setAttribute('strength', 5); // below min
      expect(wizard.attributes.strength).toBe(ATTRIBUTE_MIN);

      wizard.setAttribute('strength', 150); // above max
      expect(wizard.attributes.strength).toBe(ATTRIBUTE_MAX);
    });

    it('should produce valid character with attributes summing to ≤330', () => {
      wizard.setAttribute('strength', 60);
      wizard.setAttribute('endurance', 100);
      wizard.setAttribute('coordination', 50);
      wizard.setAttribute('quickness', 40);
      wizard.setAttribute('focus', 30);
      wizard.setAttribute('self', 50);

      expect(wizard.attributeTotal).toBe(330);
      expect(wizard.attributesRemaining).toBe(0);
    });

    it('should train and untrain skills within credit budget', () => {
      expect(wizard.skillCreditsRemaining).toBe(52);

      wizard.trainSkill(6, 4); // MeleeDefense costs 4
      expect(wizard.skillCreditsRemaining).toBe(48);
      expect(wizard.skills.get(6)).toBe(SkillAdvancementClass.Trained);

      // Cannot train again
      expect(wizard.trainSkill(6, 4)).toBe(false);

      // Untrain
      wizard.untrainSkill(6, 4);
      expect(wizard.skillCreditsRemaining).toBe(52);
      expect(wizard.skills.has(6)).toBe(false);
    });

    it('should specialize skills', () => {
      wizard.trainSkill(6, 4);
      wizard.specializeSkill(6, 8); // additional 8 to specialize
      expect(wizard.skills.get(6)).toBe(SkillAdvancementClass.Specialized);
      expect(wizard.skillCreditsUsed).toBe(12);
    });

    // GAP.76 — Player_Skills.cs SpecializeSkill() requires AdvancementClass
    // == Trained; retail chargen's up-arrow cycle (str 24143443) goes
    // Untrained -> Trained -> Specialized one step at a time, never a direct
    // Untrained -> Specialized jump.
    it('should reject specializing a skill that is not yet trained', () => {
      expect(wizard.skills.has(6)).toBe(false);
      expect(wizard.specializeSkill(6, 8)).toBe(false);
      expect(wizard.skills.has(6)).toBe(false);
      expect(wizard.skillCreditsUsed).toBe(0);
    });

    it('should reject re-specializing an already-specialized skill', () => {
      wizard.trainSkill(6, 4);
      wizard.specializeSkill(6, 8);
      expect(wizard.specializeSkill(6, 8)).toBe(false);
      expect(wizard.skillCreditsUsed).toBe(12);
    });

    it('should unspecialize a skill back to Trained and refund the increment', () => {
      wizard.trainSkill(6, 4);
      wizard.specializeSkill(6, 8);
      expect(wizard.skillCreditsUsed).toBe(12);

      expect(wizard.unspecializeSkill(6, 8)).toBe(true);
      expect(wizard.skills.get(6)).toBe(SkillAdvancementClass.Trained);
      expect(wizard.skillCreditsUsed).toBe(4);
    });

    it('should reject unspecializing a skill that is not specialized', () => {
      wizard.trainSkill(6, 4);
      expect(wizard.unspecializeSkill(6, 8)).toBe(false);
      expect(wizard.skills.get(6)).toBe(SkillAdvancementClass.Trained);

      expect(wizard.unspecializeSkill(1, 0)).toBe(false); // never trained at all
    });

    it('should reject skill training when over budget', () => {
      expect(wizard.trainSkill(1, 100)).toBe(false);
    });

    it('should validate name', () => {
      wizard.setName('');
      expect(wizard.nameValid).toBe(false);

      wizard.setName('TestHero');
      expect(wizard.nameValid).toBe(true);

      wizard.setName(' Leading Space');
      expect(wizard.nameValid).toBe(false);
    });

    it('should validate name on Summary step', () => {
      // Navigate to Summary step (EoL order)
      wizard.nextStep(); // Heritage → Profession
      wizard.nextStep(); // Profession → Skills
      wizard.nextStep(); // Skills → Appearance
      wizard.nextStep(); // Appearance → Town
      wizard.nextStep(); // Town → Summary
      expect(wizard.currentStep).toBe(CreateStep.Summary);

      // Summary step canGoNext is always false (last step)
      expect(wizard.canGoNext).toBe(false);

      // But validation should fail with empty name
      expect(wizard.validate().valid).toBe(false);

      wizard.setName('ValidName');
      expect(wizard.validate().valid).toBe(true);
    });

    it('should produce CharacterCreateInfo output', () => {
      wizard.setHeritage(Heritage.Sho);
      wizard.setGender(Gender.Female);
      wizard.setName('ShoHero');
      wizard.setAttribute('strength', 60);
      wizard.setAttribute('endurance', 80);
      wizard.trainSkill(6, 4);

      const info = wizard.getCharacterInfo();
      expect(info.name).toBe('ShoHero');
      expect(info.heritage).toBe(Heritage.Sho);
      expect(info.gender).toBe(Gender.Female);
      expect(info.attributes.strength).toBe(60);
      expect(info.attributes.endurance).toBe(80);
      expect(info.skills.get(6)).toBe(SkillAdvancementClass.Trained);
    });

    it('should validate complete wizard state', () => {
      // Default (invalid name) should fail
      const result1 = wizard.validate();
      expect(result1.valid).toBe(false);
      expect(result1.errors.length).toBeGreaterThan(0);

      // Set valid state
      wizard.setName('ValidChar');
      const result2 = wizard.validate();
      expect(result2.valid).toBe(true);
      expect(result2.errors.length).toBe(0);
    });
  });

  // ============================================================
  // D3: CharacterSelect
  // ============================================================
  describe('CharacterSelectScreen', () => {
    let screen: CharacterSelectScreen;

    beforeEach(() => {
      screen = new CharacterSelectScreen();
    });

    it('should start with no characters', () => {
      expect(screen.hasCharacters).toBe(false);
      expect(screen.characterCount).toBe(0);
      expect(screen.selectedIndex).toBe(-1);
    });

    it('should add and list characters', () => {
      screen.addCharacter({
        id: 'char1', name: 'Hero', level: 10,
        heritage: 1, gender: 1, location: 'Holtburg', lastPlayed: 1000,
      });
      screen.addCharacter({
        id: 'char2', name: 'Mage', level: 20,
        heritage: 2, gender: 0, location: 'Shoushi', lastPlayed: 2000,
      });

      expect(screen.hasCharacters).toBe(true);
      expect(screen.characterCount).toBe(2);
      expect(screen.slots[0].name).toBe('Hero');
      expect(screen.slots[1].name).toBe('Mage');
    });

    it('should select and deselect characters', () => {
      screen.addCharacter({
        id: 'char1', name: 'Hero', level: 10,
        heritage: 1, gender: 1, location: 'Holtburg', lastPlayed: 1000,
      });

      screen.selectCharacter(0);
      expect(screen.selectedIndex).toBe(0);
      expect(screen.selectedCharacter?.name).toBe('Hero');

      screen.clearSelection();
      expect(screen.selectedIndex).toBe(-1);
      expect(screen.selectedCharacter).toBeUndefined();
    });

    it('should remove characters and adjust selection', () => {
      screen.addCharacter({
        id: 'char1', name: 'A', level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 1,
      });
      screen.addCharacter({
        id: 'char2', name: 'B', level: 2, heritage: 1, gender: 1, location: '', lastPlayed: 2,
      });
      screen.addCharacter({
        id: 'char3', name: 'C', level: 3, heritage: 1, gender: 1, location: '', lastPlayed: 3,
      });

      screen.selectCharacter(2); // select C
      screen.removeCharacter('char1'); // remove A
      // C should still be selected, but at index 1 now
      expect(screen.selectedCharacter?.name).toBe('C');
      expect(screen.selectedIndex).toBe(1);
    });

    it('should clear selection when selected character is removed', () => {
      screen.addCharacter({
        id: 'char1', name: 'A', level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 1,
      });
      screen.selectCharacter(0);
      screen.removeCharacter('char1');
      expect(screen.selectedIndex).toBe(-1);
    });

    it('sorts by name, as retail RebuildCharacterList does (not by last played)', () => {
      screen.addCharacter({
        id: 'old', name: 'Old', level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 100,
      });
      screen.addCharacter({
        id: 'new', name: 'New', level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 999,
      });
      screen.addCharacter({
        id: 'mid', name: 'Mid', level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 500,
      });

      screen.selectCharacter(0); // select Old
      screen.sortRetailOrder();

      expect(screen.slots.map(c => c.name)).toEqual(['Mid', 'New', 'Old']);

      // Old should still be selected (now at index 2)
      expect(screen.selectedCharacter?.name).toBe('Old');
    });
  });

  // ============================================================
  // D4: HUD
  // ============================================================
  describe('HUD', () => {
    let hud: HUD;

    beforeEach(() => {
      hud = new HUD();
    });

    it('should initialize with zero vitals', () => {
      expect(hud.health.current).toBe(0);
      expect(hud.health.max).toBe(0);
      expect(hud.health.fraction).toBe(0);
    });

    it('should update from PlayerState', () => {
      const state = new PlayerState();
      state.initFromCreation({
        name: 'TestHero',
        heritage: 1,
        gender: 0,
        level: 5,
        totalXp: 10000n,
        availableXp: 5000n,
        skillCredits: 50,
        attributes: {
          strength: 60, endurance: 100, coordination: 50,
          quickness: 40, focus: 30, self: 50,
        },
        skills: new Map(),
      });

      hud.updateFromPlayerState(state);

      // Health = floor(Endurance / 2) = 50
      expect(hud.health.max).toBe(50);
      expect(hud.health.current).toBe(50);
      expect(hud.health.fraction).toBeCloseTo(1.0);

      // Stamina = Endurance = 100
      expect(hud.stamina.max).toBe(100);
      expect(hud.stamina.current).toBe(100);

      // Mana = Self = 50
      expect(hud.mana.max).toBe(50);
      expect(hud.mana.current).toBe(50);

      // Level and XP
      expect(hud.level).toBe(5);
      expect(hud.totalXp).toBe('10000');
    });

    it('should reflect damage in vital bars after update', () => {
      const state = new PlayerState();
      state.initFromCreation({
        name: 'TestHero',
        heritage: 1, gender: 0, level: 1,
        totalXp: 0n, availableXp: 0n, skillCredits: 0,
        attributes: {
          strength: 10, endurance: 100, coordination: 10,
          quickness: 10, focus: 10, self: 10,
        },
        skills: new Map(),
      });

      state.vitals.takeDamage(25); // reduce health from 50 to 25
      hud.updateFromPlayerState(state);

      expect(hud.health.current).toBe(25);
      expect(hud.health.max).toBe(50);
      expect(hud.health.fraction).toBeCloseTo(0.5);
    });

    it('vitals repaint only on updateVitals (gmVitalsUI::OnQualityChanged), never above max after a death purge', () => {
      const state = new PlayerState();
      state.initFromCreation({
        name: 'TestHero', heritage: 1, gender: 0, level: 8,
        totalXp: 0n, availableXp: 0n, skillCredits: 0,
        attributes: { strength: 10, endurance: 40, coordination: 10, quickness: 10, focus: 10, self: 10 },
        skills: new Map(),
      });
      // Endurance buffed 40 → 85: stamina max 85.
      state.enchantments.upsertRegistryEntry({
        spellId: 1001, layer: 1, spellCategory: 1001, powerLevel: 100, startTime: 0, duration: 1800, casterGuid: 0x50000001,
        statModType: StatModType.Attribute | StatModType.SingleStat | StatModType.Additive | StatModType.Beneficial,
        statModKey: AttributeId.Endurance, statModValue: 45, spellSetId: 0,
      });
      state.vitals.setCurrent(VitalId.Stamina, 83, state.attributes);
      hud.updateFromPlayerState(state);
      expect(hud.stamina.current).toBe(83);
      expect(hud.stamina.max).toBe(85);

      // Death: the server purges the enchantments; its new vitals come seconds later.
      state.enchantments.purgeRegistry();
      expect(state.stamina.max).toBe(40);
      hud.updateProgress(state); // what the game loop runs every frame
      expect(hud.stamina.current).toBe(83);
      expect(hud.stamina.max).toBe(85);

      // The server's vital update arrives: repaint with the new current and max.
      state.vitals.setCurrent(VitalId.Stamina, 28, state.attributes);
      hud.updateVitals(state);
      expect(hud.stamina.current).toBe(28);
      expect(hud.stamina.max).toBe(40);
      expect(hud.stamina.current).toBeLessThanOrEqual(hud.stamina.max);
      expect(hud.shownVitals().stamina).toEqual({ current: 28, max: 40 });
    });

    it('shownVitals reports the bar, not PlayerState\'s live max, between a purge and the server\'s update', () => {
      const state = new PlayerState();
      state.initFromCreation({
        name: 'TestHero', heritage: 1, gender: 0, level: 8,
        totalXp: 0n, availableXp: 0n, skillCredits: 0,
        attributes: { strength: 10, endurance: 40, coordination: 10, quickness: 10, focus: 10, self: 10 },
        skills: new Map(),
      });
      state.enchantments.upsertRegistryEntry({
        spellId: 1002, layer: 1, spellCategory: 1002, powerLevel: 100, startTime: 0, duration: 1800, casterGuid: 0x50000001,
        statModType: StatModType.Attribute | StatModType.SingleStat | StatModType.Additive | StatModType.Beneficial,
        statModKey: AttributeId.Endurance, statModValue: 30, spellSetId: 0,
      });
      state.vitals.setCurrent(VitalId.Stamina, 70, state.attributes);
      hud.updateVitals(state);
      state.enchantments.purgeRegistry();
      // PlayerState alone now reads current above max …
      expect(state.stamina.current).toBeGreaterThan(state.stamina.max);
      // … the bar (and so the agent's observation) keeps the last values the server set.
      const shown = hud.shownVitals();
      expect(shown.stamina).toEqual({ current: 70, max: 70 });
      expect(shown.health.current).toBeLessThanOrEqual(shown.health.max);
    });

    it('should update compass heading', () => {
      hud.updateCompass(0);
      expect(hud.compassDirection).toBe('N');
      expect(hud.headingDegrees).toBeCloseTo(0);

      hud.updateCompass(Math.PI / 2);
      expect(hud.compassDirection).toBe('E');
      expect(hud.headingDegrees).toBeCloseTo(90);

      hud.updateCompass(Math.PI);
      expect(hud.compassDirection).toBe('S');
      expect(hud.headingDegrees).toBeCloseTo(180);

      hud.updateCompass(3 * Math.PI / 2);
      expect(hud.compassDirection).toBe('W');
      expect(hud.headingDegrees).toBeCloseTo(270);
    });

    it('should handle negative heading values', () => {
      hud.updateCompass(-Math.PI / 2);
      expect(hud.compassDirection).toBe('W');
      expect(hud.headingDegrees).toBeCloseTo(270);
    });

    it('should return correct compass directions for all 8 sectors', () => {
      const cases: [number, string][] = [
        [0, 'N'],
        [Math.PI / 4, 'NE'],
        [Math.PI / 2, 'E'],
        [3 * Math.PI / 4, 'SE'],
        [Math.PI, 'S'],
        [5 * Math.PI / 4, 'SW'],
        [3 * Math.PI / 2, 'W'],
        [7 * Math.PI / 4, 'NW'],
      ];

      for (const [radians, expected] of cases) {
        expect(HUD.getCompassDirection(radians)).toBe(expected);
      }
    });

    it('should set and clear target', () => {
      expect(hud.target).toBeNull();

      hud.setTarget({
        id: 1001,
        name: 'Drudge Prowler',
        level: 5,
        healthFraction: 0.8,
        distance: 15.5,
        type: 'creature',
      });
      expect(hud.target?.name).toBe('Drudge Prowler');
      expect(hud.target?.level).toBe(5);

      hud.setTarget(null);
      expect(hud.target).toBeNull();
    });

    it('should update FPS and position', () => {
      hud.updateFPS(60);
      expect(hud.fps).toBe(60);

      hud.updatePosition(100, 50, 200);
      expect(hud.position.x).toBe(100);
      expect(hud.position.y).toBe(50);
      expect(hud.position.z).toBe(200);
    });

    it('should toggle debug display', () => {
      expect(hud.showDebug).toBe(false);
      hud.toggleDebug();
      expect(hud.showDebug).toBe(true);
      hud.toggleDebug();
      expect(hud.showDebug).toBe(false);
    });
  });
});
