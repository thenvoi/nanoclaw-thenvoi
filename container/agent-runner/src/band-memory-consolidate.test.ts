import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';

import { runMemoryConsolidation } from './band-memory-consolidate.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

const ENV_KEYS = ['THENVOI_MEMORY_TOOLS', 'THENVOI_MEMORY_CONSOLIDATION', 'NANOCLAW_CHANNEL'];
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

function makeProvider(events: ProviderEvent[]): { provider: AgentProvider; query: ReturnType<typeof mock> } {
  const queryFn = mock((): AgentQuery => ({
    push: () => {},
    end: () => {},
    abort: () => {},
    events: (async function* () {
      for (const event of events) yield event;
    })(),
  }));
  return {
    provider: {
      supportsNativeSlashCommands: false,
      query: queryFn,
      isSessionInvalid: () => false,
    } as AgentProvider,
    query: queryFn,
  };
}

describe('runMemoryConsolidation', () => {
  test('skips when feature flag is off', async () => {
    process.env.NANOCLAW_CHANNEL = 'thenvoi';
    const { provider, query } = makeProvider([]);

    await runMemoryConsolidation({ provider, providerName: 'claude', cwd: '/workspace/agent', continuation: 'sess-1' });
    expect(query).not.toHaveBeenCalled();
  });

  test('skips when channel is not thenvoi', async () => {
    process.env.THENVOI_MEMORY_TOOLS = 'true';
    process.env.THENVOI_MEMORY_CONSOLIDATION = 'true';
    process.env.NANOCLAW_CHANNEL = 'discord';
    const { provider, query } = makeProvider([]);

    await runMemoryConsolidation({ provider, providerName: 'claude', cwd: '/workspace/agent', continuation: 'sess-1' });
    expect(query).not.toHaveBeenCalled();
  });

  test('skips when no continuation is available', async () => {
    process.env.THENVOI_MEMORY_TOOLS = 'true';
    process.env.THENVOI_MEMORY_CONSOLIDATION = 'true';
    process.env.NANOCLAW_CHANNEL = 'thenvoi';
    const { provider, query } = makeProvider([]);

    await runMemoryConsolidation({ provider, providerName: 'claude', cwd: '/workspace/agent', continuation: undefined });
    expect(query).not.toHaveBeenCalled();
  });

  test('drains events and forwards continuation to provider', async () => {
    process.env.THENVOI_MEMORY_TOOLS = 'true';
    process.env.THENVOI_MEMORY_CONSOLIDATION = 'true';
    process.env.NANOCLAW_CHANNEL = 'thenvoi';
    const events: ProviderEvent[] = [
      { type: 'init', continuation: 'sess-2' },
      { type: 'result', text: 'done' },
    ];
    const { provider, query } = makeProvider(events);

    await runMemoryConsolidation({ provider, providerName: 'claude', cwd: '/workspace/agent', continuation: 'sess-1' });
    expect(query).toHaveBeenCalledTimes(1);
    const callArg = query.mock.calls[0][0] as {
      continuation: string;
      cwd: string;
      env: Record<string, string>;
      prompt: string;
    };
    expect(callArg.continuation).toBe('sess-1');
    expect(callArg.cwd).toBe('/workspace/agent');
    expect(callArg.env.NANOCLAW_MEMORY_CONSOLIDATION_ACTIVE).toBe('true');
    expect(callArg.prompt).toContain('memory consolidation mode');
    expect(callArg.prompt).toContain('mcp__nanoclaw__band_list_memories');
    expect(callArg.prompt).toContain('Do not store user- or agent-specific memories');
  });
});
