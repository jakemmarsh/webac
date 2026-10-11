/**
 * Where an agent plays each era locally: the server's UDP ports, the
 * bridge's era (AC1999 needs it: its session protocol differs), and how to
 * keep the auto-created account at player level. Sources: the start
 * scripts tools/classicace/start-classicace.sh, tools/gdle/start-gdl-classic.sh,
 * tools/ac1999/start-ac1999.sh; docs/dark-majesty-support.md,
 * docs/ac1999-support.md.
 */

export interface AgentEra {
  /** The client's era id (`?era=`), or null for end of retail (the default boot). */
  id: string | null;
  label: string;
  /** Local server UDP ports the bridge targets. */
  ports: [number, number];
  /** BRIDGE_ERA for the pinned bridge (required for AC1999's protocol; informative otherwise). */
  bridgeEra?: string;
  /**
   * The account's access level, read and demoted, through `docker exec`.
   * null where the server auto-creates accounts at a player level already
   * (GDL and the 1999 server insert access 1, BASIC_ACCESS).
   */
  access: {
    container: string;
    client: string[];
    table: string;
    column: string;
    nameColumn: string;
    player: number;
  } | null;
  /**
   * Suffix on the profile's account name, so each local server keeps its own
   * accounts (defaults by client era id).
   */
  accountTag?: string;
  /** Account-name limits (GDL wants lower case; the 1999 login packs user:password into 19 chars). */
  maxAccountLength?: number;
  notes?: string;
}

const ACE_ROOT = ['mysql', '-uroot', '-p1999asheron2017', '-N', '-B', '-e'];
const CLASSICACE_ROOT = ['mysql', '-uroot', '-pclassicace', '-N', '-B', '-e'];

export const AGENT_ERAS: Record<string, AgentEra> = {
  eor: {
    id: null, label: 'End of retail (local ACE)', ports: [9000, 9001],
    access: { container: 'ace-db', client: ACE_ROOT, table: 'ace_auth.account', column: 'accessLevel', nameColumn: 'accountName', player: 0 },
  },
  'classicace-customdm': {
    id: 'classicace-customdm', label: 'Dark Majesty era: ClassicACE CustomDM', ports: [9200, 9201], bridgeEra: 'classicace-customdm',
    access: { container: 'classicace-db', client: CLASSICACE_ROOT, table: 'ace_auth_customdm.account', column: 'accessLevel', nameColumn: 'accountName', player: 0 },
    notes: 'ClassicACE crashes if the first action after entering is a ranged attack/use before any movement: move first.',
  },
  'classicace-infiltration': {
    id: 'classicace-infiltration', label: 'Infiltration era: ClassicACE', ports: [9220, 9221], bridgeEra: 'classicace-infiltration',
    access: { container: 'classicace-infiltration-db', client: CLASSICACE_ROOT, table: 'ace_auth_infiltration.account', column: 'accessLevel', nameColumn: 'accountName', player: 0 },
    notes: 'ClassicACE crashes if the first action after entering is a ranged attack/use before any movement: move first.',
  },
  'classic-dereth': {
    id: 'classic-dereth', label: 'Dark Majesty era: GDL Classic Dereth', ports: [9210, 9211], bridgeEra: 'classic-dereth',
    access: null,
  },
  'classic-dereth-1-0': {
    // The same local GDL-Classic, started on Classic Dereth 1.0 data:
    // GDL_CLASSIC_DAT_DIR=dat-sets/classic-dereth-1.0 (Snowreap's set; no Salvaging).
    id: 'classic-dereth-1-0', label: 'Dark Majesty era: GDL Classic Dereth 1.0 data (Snowreap)', ports: [9210, 9211], bridgeEra: 'classic-dereth-1-0',
    access: null, accountTag: 'c10',
  },
  gdle: {
    // End-of-retail client against vanilla GDLE 1.34 (tools/gdle/, docs/gdle-compat.md):
    // the client boots its default era; only the server differs.
    id: null, label: 'End of retail on GDLE 1.34 (local tools/gdle server)', ports: [9110, 9111],
    access: null, accountTag: 'gd',
    notes: 'GDLE wants lower-case account names and auto-creates them at a player level.',
  },
  'ac1999-retail': {
    id: 'ac1999-retail', label: 'Retail November 1999 (local 1999 server)', ports: [9310, 9311], bridgeEra: 'ac1999-retail',
    access: null, maxAccountLength: 8,
    notes: 'Characters start in the 1999 start areas (not Holtburg). Some panels and actions do not exist in 1999 and are dropped.',
  },
};

export const ERA_IDS = Object.keys(AGENT_ERAS);

export function agentEra(id: string | undefined | null): AgentEra {
  const key = !id || id === 'end-of-retail' ? 'eor' : id;
  const era = AGENT_ERAS[key];
  if (!era) throw new Error(`unknown era "${id}" (have: ${ERA_IDS.join(', ')})`);
  return era;
}

/**
 * The account for a profile on an era: lower case letters and digits (GDL),
 * within the era's length limit, distinct per era so each era keeps its own
 * character list.
 */
export function eraAccount(base: string, era: AgentEra): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tag = era.accountTag ?? (era.id ? { 'classicace-customdm': 'dm', 'classicace-infiltration': 'in', 'classic-dereth': 'cd', 'ac1999-retail': '99' }[era.id] ?? '' : '');
  const max = era.maxAccountLength ?? 20;
  return `${slug.slice(0, max - tag.length)}${tag}`;
}
