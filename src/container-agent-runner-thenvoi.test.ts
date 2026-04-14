import { describe, expect, it } from 'vitest';
import {
  createThenvoiToolsProxy,
  isThenvoiMainControlRoom,
} from './thenvoi-control-room.js';

describe('agent runner Thenvoi helpers', () => {
  it('detects the stable Thenvoi main control room by folder', () => {
    expect(isThenvoiMainControlRoom('thenvoi_main_room')).toBe(true);

    expect(isThenvoiMainControlRoom('thenvoi_abcd1234')).toBe(false);
  });

  it('blocks addParticipant in the main control room', async () => {
    const proxy = createThenvoiToolsProxy(
      {
        capabilities: { peers: true, contacts: true, memory: true },
        addParticipant: async (_name: string, _role?: string) => 'added',
        createChatroom: async () => 'room',
        removeParticipant: async () => 'removed',
        getParticipants: async () => [],
        sendMessage: async () => ({ ok: true }),
        sendEvent: async () => ({ ok: true }),
        getToolSchemas: () => [],
        getAnthropicToolSchemas: () => [],
        getOpenAIToolSchemas: () => [],
        executeToolCall: async (
          _toolName: string,
          _toolArgs: Record<string, unknown>,
        ) => 'ok',
        lookupPeers: async () => ({ data: [], hasMore: false, totalCount: 0 }),
        listContacts: async () => ({ data: [], hasMore: false, totalCount: 0 }),
        addContact: async () => ({ ok: true }),
        removeContact: async () => ({ ok: true }),
        listContactRequests: async () => ({
          data: [],
          hasMore: false,
          totalCount: 0,
        }),
        respondContactRequest: async () => ({ ok: true }),
        listMemories: async () => ({ data: [], hasMore: false, totalCount: 0 }),
        storeMemory: async () => ({ id: 'm1' }),
        getMemory: async () => ({ id: 'm1' }),
        supersedeMemory: async () => ({ ok: true }),
        archiveMemory: async () => ({ ok: true }),
      },
      { blockParticipantAdds: true },
    );

    await expect(proxy.addParticipant('Weather Agent')).rejects.toThrow(
      'Cannot add participants in the Thenvoi main control room',
    );
    await expect(
      proxy.executeToolCall('thenvoi_add_participant', {
        name: 'Weather Agent',
      }),
    ).rejects.toThrow(
      'Cannot add participants in the Thenvoi main control room',
    );
  });

  it('passes through participant tools outside the main control room', async () => {
    const proxy = createThenvoiToolsProxy(
      {
        capabilities: { peers: true, contacts: true, memory: false },
        addParticipant: async (name: string) => `added:${name}`,
        createChatroom: async () => 'room',
        removeParticipant: async () => 'removed',
        getParticipants: async () => [],
        sendMessage: async () => ({ ok: true }),
        sendEvent: async () => ({ ok: true }),
        getToolSchemas: () => [],
        getAnthropicToolSchemas: () => [],
        getOpenAIToolSchemas: () => [],
        executeToolCall: async (
          toolName: string,
          _toolArgs: Record<string, unknown>,
        ) => `tool:${toolName}`,
      },
      { blockParticipantAdds: false },
    );

    await expect(proxy.addParticipant('Weather Agent')).resolves.toBe(
      'added:Weather Agent',
    );
    await expect(
      proxy.executeToolCall('thenvoi_add_participant', {
        name: 'Weather Agent',
      }),
    ).resolves.toBe('tool:thenvoi_add_participant');
  });
});
