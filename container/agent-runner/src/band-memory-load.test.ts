import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

import { loadParticipantMemories } from './band-memory-load.js';

const ENV_KEYS = [
  'THENVOI_MEMORY_LOAD_ON_START',
  'NANOCLAW_CHANNEL',
  'THENVOI_AGENT_ID',
  'THENVOI_ROOM_ID',
  'THENVOI_API_KEY',
  'THENVOI_REST_URL',
];

let snapshot: Record<string, string | undefined>;

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe('loadParticipantMemories', () => {
  test('returns empty when feature flag is off', async () => {
    process.env.NANOCLAW_CHANNEL = 'thenvoi';
    process.env.THENVOI_AGENT_ID = 'agent-1';
    process.env.THENVOI_ROOM_ID = 'room-1';

    const result = await loadParticipantMemories();
    expect(result).toBe('');
  });

  test('returns empty when channel is not thenvoi', async () => {
    process.env.THENVOI_MEMORY_LOAD_ON_START = 'true';
    process.env.NANOCLAW_CHANNEL = 'discord';
    process.env.THENVOI_AGENT_ID = 'agent-1';
    process.env.THENVOI_ROOM_ID = 'room-1';

    const result = await loadParticipantMemories();
    expect(result).toBe('');
  });

  test('returns empty when AGENT_ID or ROOM_ID is missing', async () => {
    process.env.THENVOI_MEMORY_LOAD_ON_START = 'true';
    process.env.NANOCLAW_CHANNEL = 'thenvoi';
    // No AGENT_ID, no ROOM_ID

    const result = await loadParticipantMemories();
    expect(result).toBe('');
  });
});
