/**
 * AttributeSystem — 6 primary attributes with innate + raise tracking.
 *
 * Attributes: Strength, Endurance, Coordination, Quickness, Focus, Self
 * Each has an innate (creation) value and can be raised by spending XP.
 * Total = innate + raises
 *
 * Reference: ACE.Server/WorldObjects/Player_Attributes.cs
 */

/**
 * FAITHFUL.601 — values aligned to ACE PropertyAttribute.cs (the wire enum):
 * Quickness = 3, Coordination = 4 ("the order of quickness and coordination
 * corresponds to the client" per the ACE source comment). Pre-fix these two
 * were swapped (Coordination=3, Quickness=4). Most boundaries translated by
 * NAME so the swap cancelled out — but GameUI's attrIdMap fed its raw value
 * straight into GameActionRaiseAttribute's u32 (read as PropertyAttribute by
 * ACE GameActionRaiseAttribute.cs:10), so the panel's Coordination raise
 * button actually raised Quickness on the server and vice versa.
 */
export enum AttributeId {
  Strength = 1,
  Endurance = 2,
  Quickness = 3,
  Coordination = 4,
  Focus = 5,
  Self = 6,
}

export interface Attribute {
  id: AttributeId;
  innate: number;     // starting value from character creation
  raises: number;     // points added via XP spending
}

export class AttributeSystem {
  private attributes: Map<AttributeId, Attribute> = new Map();

  constructor(innateValues: {
    strength: number;
    endurance: number;
    coordination: number;
    quickness: number;
    focus: number;
    self: number;
  }) {
    this.attributes.set(AttributeId.Strength, { id: AttributeId.Strength, innate: innateValues.strength, raises: 0 });
    this.attributes.set(AttributeId.Endurance, { id: AttributeId.Endurance, innate: innateValues.endurance, raises: 0 });
    this.attributes.set(AttributeId.Coordination, { id: AttributeId.Coordination, innate: innateValues.coordination, raises: 0 });
    this.attributes.set(AttributeId.Quickness, { id: AttributeId.Quickness, innate: innateValues.quickness, raises: 0 });
    this.attributes.set(AttributeId.Focus, { id: AttributeId.Focus, innate: innateValues.focus, raises: 0 });
    this.attributes.set(AttributeId.Self, { id: AttributeId.Self, innate: innateValues.self, raises: 0 });
  }

  /** Get the current (total) value of an attribute. */
  getCurrent(id: AttributeId): number {
    const attr = this.attributes.get(id);
    if (!attr) return 0;
    return attr.innate + attr.raises;
  }

  /** Get the innate (creation) value of an attribute. */
  getInnate(id: AttributeId): number {
    return this.attributes.get(id)?.innate ?? 0;
  }

  /** Get the number of raises applied to an attribute. */
  getRaises(id: AttributeId): number {
    return this.attributes.get(id)?.raises ?? 0;
  }

  /** Set innate value for an attribute (used by save/load). */
  setInnate(id: AttributeId, innate: number): void {
    const attr = this.attributes.get(id);
    if (attr) attr.innate = innate;
  }

  /** Set raises for an attribute (used by save/load). */
  setRaises(id: AttributeId, raises: number): void {
    const attr = this.attributes.get(id);
    if (attr) attr.raises = raises;
  }

  /** Get all attribute current values. */
  getAll(): Record<string, number> {
    return {
      strength: this.getCurrent(AttributeId.Strength),
      endurance: this.getCurrent(AttributeId.Endurance),
      coordination: this.getCurrent(AttributeId.Coordination),
      quickness: this.getCurrent(AttributeId.Quickness),
      focus: this.getCurrent(AttributeId.Focus),
      self: this.getCurrent(AttributeId.Self),
    };
  }

  /**
   * Raise an attribute by spending XP.
   * @param id - attribute to raise
   * @param xpCostTable - XP costs per raise from XpTable.attributeXpList
   * @param availableXp - current available XP
   * @returns XP spent, or 0 if cannot afford
   */
  raiseAttribute(id: AttributeId, xpCostTable: number[], availableXp: number): number {
    const attr = this.attributes.get(id);
    if (!attr) return 0;

    const nextRaiseIndex = attr.raises + 1;
    if (nextRaiseIndex >= xpCostTable.length) return 0; // maxed out

    const cost = xpCostTable[nextRaiseIndex] - xpCostTable[attr.raises];
    if (cost > availableXp) return 0;

    attr.raises++;
    return cost;
  }

  /** Get the XP cost for the next raise of an attribute. */
  getNextRaiseCost(id: AttributeId, xpCostTable: number[]): number | null {
    const attr = this.attributes.get(id);
    if (!attr) return null;

    const nextRaiseIndex = attr.raises + 1;
    if (nextRaiseIndex >= xpCostTable.length) return null;

    return xpCostTable[nextRaiseIndex] - xpCostTable[attr.raises];
  }
}
