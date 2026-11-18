/**
 * Fixture realism for hand-built ACE appraisals (IdentifyObjectResponse).
 *
 * ACE's AppraiseInfo sends only [AssessmentProperty] keys plus a few it computes
 * (packages/shared/src/appraisal/aceDeliveredProperties.ts). A fixture that carries a property
 * the live server never sends can keep a dead feature's tests green: summoning essences were
 * found by PetClass (266) on 2026-11-17, which ACE never appraises. Pass end-of-retail fixtures
 * through `aceAppraisal`; it throws naming any property ACE would not have sent.
 */
import { aceShapedAppraisal, foldAppraisalProfiles, type AppraisalArmorProfile, type AppraisalWeaponProfile } from '@ac/shared';
import { withPublicDescription, type AgentAppraisal, type PublicDescription } from '../../packages/renderer/src/agent/itemRecord.js';
import type { IdentifyResponseData } from '../../packages/renderer/src/network/ServerMessageHandler.js';

export function aceAppraisal<T extends Partial<IdentifyResponseData>>(d: T): T {
  aceShapedAppraisal({
    int: d.propertiesInt, int64: d.propertiesInt64, bool: d.propertiesBool,
    float: d.propertiesFloat, string: d.propertiesString, did: d.propertiesDataID,
  });
  if (d.propertiesInstanceID?.size) throw new Error('ACE never sends an InstanceId table on an appraisal (AppraiseInfo writes none)');
  return d;
}

/**
 * The automation's record of an object as an ACE server describes it (agent/itemRecord.ts): the examination's
 * tables (checked by aceShapedAppraisal: only what ACE appraises), its Weapon / ArmorProfile folded in under
 * their property ids, then the CreateObject public description where the tables have nothing. Agent / macro
 * fixtures build examined items with this instead of hand-writing `int: { … }` tables.
 */
export function aceRecord(e: {
  appraisal?: { int?: Record<number, number>; float?: Record<number, number>; bool?: Record<number, boolean>; string?: Record<number, string>; did?: Record<number, number> };
  weaponProfile?: Partial<AppraisalWeaponProfile>;
  armorProfile?: AppraisalArmorProfile;
  header?: PublicDescription;
  spells?: string[];
  spellIds?: number[];
}): AgentAppraisal {
  const t = aceShapedAppraisal(e.appraisal ?? {});
  const w = e.weaponProfile ? { damageType: 0, weaponTime: 0, weaponSkill: 0, damage: 0, damageVariance: 0, damageMod: 1, weaponOffense: 1, ...e.weaponProfile } : null;
  const folded = foldAppraisalProfiles(t.int ?? {}, t.float ?? {}, w, e.armorProfile);
  return withPublicDescription({
    int: folded.int, float: folded.float, bool: { ...t.bool }, string: { ...t.string }, did: { ...t.did },
    spells: e.spells ?? [], spellIds: e.spellIds ?? [], activeSpellIds: [],
  }, e.header);
}
