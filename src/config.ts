import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'THENVOI_CONTACT_STRATEGY',
  'THENVOI_OWNER_ID',
  'THENVOI_INTERNAL_AS_THOUGHTS',
  'THENVOI_MEMORY_TOOLS',
  'THENVOI_MEMORY_LOAD_ON_START',
  'THENVOI_MEMORY_CONSOLIDATION',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Thenvoi contact event strategy: disabled | callback | hub_room
export const THENVOI_CONTACT_STRATEGY =
  process.env.THENVOI_CONTACT_STRATEGY ||
  envConfig.THENVOI_CONTACT_STRATEGY ||
  'disabled';

// Thenvoi platform owner user ID (auto-derived from agent profile if not set)
export const THENVOI_OWNER_ID =
  process.env.THENVOI_OWNER_ID || envConfig.THENVOI_OWNER_ID || '';

// Publish <internal> tag content as thought events on the platform (default: false)
export const THENVOI_INTERNAL_AS_THOUGHTS =
  (process.env.THENVOI_INTERNAL_AS_THOUGHTS ||
    envConfig.THENVOI_INTERNAL_AS_THOUGHTS) === 'true';

// Memory integration (all default: false)
export const THENVOI_MEMORY_TOOLS =
  (process.env.THENVOI_MEMORY_TOOLS || envConfig.THENVOI_MEMORY_TOOLS) === 'true';
export const THENVOI_MEMORY_LOAD_ON_START =
  (process.env.THENVOI_MEMORY_LOAD_ON_START || envConfig.THENVOI_MEMORY_LOAD_ON_START) === 'true';
export const THENVOI_MEMORY_CONSOLIDATION =
  (process.env.THENVOI_MEMORY_CONSOLIDATION || envConfig.THENVOI_MEMORY_CONSOLIDATION) === 'true';

export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
