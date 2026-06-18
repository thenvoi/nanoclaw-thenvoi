import { readEnvFile } from '../env.js';

// The product renamed Thenvoi → Band (domain app.band.ai). BAND_* is the
// canonical env var family; the legacy THENVOI_* names are honored as a
// fallback so existing .env files keep working.
const BAND_ENV_SUFFIXES = [
  'AGENT_ID',
  'API_KEY',
  'BASE_URL',
  'OWNER_ID',
  'MEMORY_TOOLS',
  'MEMORY_LOAD_ON_START',
  'MEMORY_CONSOLIDATION',
  'CONTACT_STRATEGY',
  'CONTACT_AGENT_GROUP_ID',
] as const;

type BandEnvSuffix = (typeof BAND_ENV_SUFFIXES)[number];

const envConfig = readEnvFile(BAND_ENV_SUFFIXES.flatMap((suffix) => [`BAND_${suffix}`, `THENVOI_${suffix}`]));

function env(suffix: BandEnvSuffix): string | undefined {
  return (
    process.env[`BAND_${suffix}`] ||
    process.env[`THENVOI_${suffix}`] ||
    envConfig[`BAND_${suffix}`] ||
    envConfig[`THENVOI_${suffix}`]
  );
}

function envBool(suffix: BandEnvSuffix, fallback = false): boolean {
  const value = env(suffix);
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

export type BandContactStrategy = 'disabled' | 'hub_room';

export const DEFAULT_BAND_BASE_URL = 'https://app.band.ai';

export interface BandConfig {
  agentId: string;
  apiKey: string;
  baseUrl: string;
  ownerId: string | undefined;
  memoryTools: boolean;
  memoryLoadOnStart: boolean;
  memoryConsolidation: boolean;
  contactStrategy: BandContactStrategy;
  contactAgentGroupId: string | undefined;
}

export function getBandConfig(): BandConfig | null {
  const agentId = env('AGENT_ID');
  const apiKey = env('API_KEY');
  const baseUrl = env('BASE_URL') || DEFAULT_BAND_BASE_URL;
  if (!agentId || !apiKey) return null;

  const contactStrategy = env('CONTACT_STRATEGY') ?? 'disabled';
  if (contactStrategy !== 'disabled' && contactStrategy !== 'hub_room') {
    throw new Error(`Invalid BAND_CONTACT_STRATEGY: ${contactStrategy}`);
  }

  return {
    agentId,
    apiKey,
    baseUrl,
    ownerId: env('OWNER_ID'),
    memoryTools: envBool('MEMORY_TOOLS'),
    memoryLoadOnStart: envBool('MEMORY_LOAD_ON_START'),
    memoryConsolidation: envBool('MEMORY_CONSOLIDATION'),
    contactStrategy,
    contactAgentGroupId: env('CONTACT_AGENT_GROUP_ID'),
  };
}
