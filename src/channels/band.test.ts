import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { InboundMessage, InboundRouteResult } from './adapter.js';
import type { InboundDeliveryKey } from '../db/index.js';

interface QueuedEvent {
  type: string;
  roomId: string | null;
  payload: Record<string, unknown>;
}

const fakeLinks: FakeBandLink[] = [];
const fakeRestClients: FakeThenvoiClient[] = [];
let fakeChats: Record<string, unknown>[] = [{ id: 'room-1', title: 'Room 1', type: 'direct' }];
let fakeParticipants: Record<string, unknown[]> = {};
let closeTestDb: (() => void) | null = null;

class FakeThenvoiClient {
  public readonly agentApiIdentity = {
    getAgentMe: vi.fn(async () => ({ data: { owner_uuid: 'owner-1' } })),
  };
  public readonly agentApiMessages = {
    createAgentChatMessage: vi.fn(async () => ({ data: { id: 'platform-out-1' } })),
  };
  public readonly agentApiContacts = {
    respondToAgentContactRequest: vi.fn(async () => ({ data: { ok: true } })),
  };
  public readonly agentApiChats = {
    createAgentChat: vi.fn(async () => ({ data: { id: 'hub-room-1', inserted_at: '', updated_at: '' } })),
  };
  public readonly agentApiParticipants = {
    addAgentChatParticipant: vi.fn(async () => ({ data: { ok: true } })),
    listAgentChatParticipants: vi.fn(async (chatId: string) => ({ data: fakeParticipants[chatId] ?? [] })),
  };
  public readonly agentApiEvents = {
    createAgentChatEvent: vi.fn(async () => ({ data: { ok: true } })),
  };
  public readonly agentApiMemories = {
    listAgentMemories: vi.fn(async (_args: { subject_id: string; scope: string }) => ({
      data: { data: [] as Array<{ type?: string; content?: string }> },
    })),
  };

  public constructor() {
    fakeRestClients.push(this);
  }
}

class FakeBandLink implements AsyncIterable<QueuedEvent> {
  public readonly rest = {
    createChatMessage: vi.fn(async () => ({ id: 'platform-out-1' })),
  };
  public readonly markProcessing = vi.fn(async (_roomId: string, _messageId: string) => {});
  public readonly markProcessed = vi.fn(async (_roomId: string, _messageId: string) => {});
  public readonly connect = vi.fn(async () => {});
  public readonly disconnect = vi.fn(async () => {});
  public readonly subscribeAgentRooms = vi.fn(async () => {});
  public readonly subscribeRoom = vi.fn(async (_roomId: string) => {});
  public readonly listAllChats = vi.fn(async () => fakeChats);
  public readonly getNextMessage = vi.fn(async (_roomId: string): Promise<Record<string, unknown> | null> => null);
  private queue: QueuedEvent[] = [];
  private waiters: Array<(event: IteratorResult<QueuedEvent>) => void> = [];

  public constructor() {
    fakeLinks.push(this);
  }

  public emit(event: QueuedEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    this.queue.push(event);
  }

  public async runForever(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }

  public [Symbol.asyncIterator](): AsyncIterator<QueuedEvent> {
    return {
      next: async () => {
        const event = this.queue.shift();
        if (event) return { done: false, value: event };
        return new Promise<IteratorResult<QueuedEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

vi.mock('@band-ai/sdk', () => ({
  BandLink: FakeBandLink,
}));

vi.mock('@thenvoi/rest-client', () => ({
  ThenvoiClient: FakeThenvoiClient,
}));

// Isolate config resolution from the real on-disk .env. band-config.ts
// captures readEnvFile() at module load and getBandConfig() uses it as the
// fallback below process.env (`process.env[name] || envConfig[name]`). Without
// this mock, a configured .env leaks real BAND_*/THENVOI_* values into tests that
// clear process.env to assert empty/default states (missing creds, disabled
// contact strategy), so those tests fail on any installed/configured host.
// With readEnvFile stubbed to {}, process.env (managed in before/afterEach) is
// the sole source of config — which is what these tests already assume.
vi.mock('../env.js', () => ({
  readEnvFile: () => ({}),
}));

function setBandEnv(): void {
  process.env.BAND_AGENT_ID = 'agent-1';
  process.env.BAND_API_KEY = 'secret';
  process.env.BAND_BASE_URL = 'https://band.example.test';
}

function clearBandEnv(): void {
  for (const suffix of [
    'AGENT_ID',
    'API_KEY',
    'BASE_URL',
    'MEMORY_TOOLS',
    'MEMORY_LOAD_ON_START',
    'MEMORY_CONSOLIDATION',
    'CONTACT_STRATEGY',
    'CONTACT_AGENT_GROUP_ID',
    'OWNER_ID',
    'INJECT_API_KEY',
  ]) {
    delete process.env[`BAND_${suffix}`];
    delete process.env[`THENVOI_${suffix}`];
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

describe('band channel adapter', () => {
  beforeEach(async () => {
    vi.resetModules();
    fakeLinks.length = 0;
    fakeRestClients.length = 0;
    fakeChats = [{ id: 'room-1', title: 'Room 1', type: 'direct' }];
    fakeParticipants = {};
    clearBandEnv();
    const { closeDb, initTestDb, runMigrations } = await import('../db/index.js');
    const db = initTestDb();
    runMigrations(db);
    closeTestDb = closeDb;
  });

  afterEach(() => {
    closeTestDb?.();
    closeTestDb = null;
    clearBandEnv();
  });

  it('skips adapter registration when credentials are missing', async () => {
    await import('./band.js');
    const { initChannelAdapters, getActiveAdapters } = await import('./channel-registry.js');

    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    expect(getActiveAdapters().some((adapter) => adapter.channelType === 'band')).toBe(false);
  });

  it('registers the adapter from legacy THENVOI_* env vars', async () => {
    process.env.THENVOI_AGENT_ID = 'agent-1';
    process.env.THENVOI_API_KEY = 'secret';
    process.env.THENVOI_BASE_URL = 'https://band.example.test';
    await import('./band.js');
    const { initChannelAdapters, getActiveAdapters } = await import('./channel-registry.js');

    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    expect(getActiveAdapters().some((adapter) => adapter.channelType === 'band')).toBe(true);
  });

  it('marks Band messages processed only after a persisted route result', async () => {
    setBandEnv();
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'msg-1',
      sessionIds: ['sess-1'],
      sessionMessageIds: ['msg-1:ag-1'],
    };
    const { beginInboundDelivery, getInboundDelivery, markInboundDeliveryPersisted } = await import('../db/index.js');
    const onInbound = vi.fn(async (platformId: string, threadId: string | null) => {
      const key: InboundDeliveryKey = { channelType: 'band', platformId, platformMessageId: 'msg-1' };
      beginInboundDelivery(key, threadId);
      markInboundDeliveryPersisted(key, {
        sessionIds: result.sessionIds,
        sessionMessageIds: result.sessionMessageIds,
      });
      return result;
    });

    await initChannelAdapters(() => ({
      onInbound,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'message_created',
      roomId: 'room-1',
      payload: {
        id: 'msg-1',
        content: 'hello',
        message_type: 'text',
        sender_id: 'user-1',
        sender_type: 'User',
        sender_name: 'User One',
        inserted_at: new Date().toISOString(),
        metadata: { mentions: [{ id: 'agent-1' }] },
      },
    });

    await waitFor(() => fakeLinks[0].markProcessed.mock.calls.length === 1);
    expect(onInbound).toHaveBeenCalledWith(
      'band:room-1',
      null,
      expect.objectContaining({
        id: 'msg-1',
        content: expect.objectContaining({ text: 'hello' }),
        isMention: true,
      }),
    );
    expect(fakeLinks[0].markProcessing).toHaveBeenCalledWith('room-1', 'msg-1');
    expect(fakeLinks[0].markProcessed).toHaveBeenCalledWith('room-1', 'msg-1');
    expect(
      getInboundDelivery({ channelType: 'band', platformId: 'band:room-1', platformMessageId: 'msg-1' })?.status,
    ).toBe('processed');
  });

  it('drains pending inbox messages on startup and routes them like live events', async () => {
    setBandEnv();
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'pending-1',
      sessionIds: ['sess-1'],
      sessionMessageIds: ['pending-1:ag-1'],
    };
    const { beginInboundDelivery, markInboundDeliveryPersisted } = await import('../db/index.js');
    const onInbound = vi.fn(async (platformId: string, threadId: string | null) => {
      const key: InboundDeliveryKey = { channelType: 'band', platformId, platformMessageId: 'pending-1' };
      beginInboundDelivery(key, threadId);
      markInboundDeliveryPersisted(key, {
        sessionIds: result.sessionIds,
        sessionMessageIds: result.sessionMessageIds,
      });
      return result;
    });

    // First poll returns a message that was sitting in the platform inbox
    // (sent while the host was down); subsequent polls return empty.
    let polled = false;
    fakeChats = [{ id: 'room-1', title: 'Room 1', type: 'direct' }];

    await initChannelAdapters(() => ({
      onInbound,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    const link = fakeLinks[0];
    link.getNextMessage.mockImplementation(async () => {
      if (polled) return null;
      polled = true;
      return {
        id: 'pending-1',
        roomId: 'room-1',
        content: 'sent while host was down',
        senderId: 'user-1',
        senderType: 'User',
        senderName: 'User One',
        messageType: 'text',
        metadata: { mentions: [{ id: 'agent-1' }] },
        createdAt: new Date(),
      };
    });

    // Trigger a drain pass via the room_added path (same code path the
    // startup drain uses).
    link.emit({ type: 'room_added', roomId: 'room-1', payload: { id: 'room-1', title: 'Room 1', type: 'direct' } });

    await waitFor(() => link.markProcessed.mock.calls.length === 1);
    expect(onInbound).toHaveBeenCalledWith(
      'band:room-1',
      null,
      expect.objectContaining({
        id: 'pending-1',
        content: expect.objectContaining({ text: 'sent while host was down' }),
        isMention: true,
      }),
    );
    expect(link.markProcessed).toHaveBeenCalledWith('room-1', 'pending-1');
  });

  it('drains past a dropped message instead of head-of-line-blocking the room', async () => {
    setBandEnv();
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');

    // The inbox is a FIFO cursor: getNextMessage returns the oldest message
    // not yet marked processed. msg-stuck routes to a deterministic drop;
    // msg-next routes successfully. Before the fix, the drop left msg-stuck
    // unmarked at the head, so the drain re-fetched it forever and msg-next
    // was never reached.
    const dropResult: InboundRouteResult = {
      status: 'dropped',
      platformMessageId: 'msg-stuck',
      reason: 'no_agent_engaged',
      audited: true,
      retryable: false,
      intentional: false,
    };
    const okResult = (id: string): InboundRouteResult => ({
      status: 'persisted',
      platformMessageId: id,
      sessionIds: ['sess-1'],
      sessionMessageIds: [`${id}:ag-1`],
    });
    const onInbound = vi.fn(async (_platformId: string, _threadId: string | null, message: InboundMessage) =>
      message.id === 'msg-stuck' ? dropResult : okResult(message.id),
    );

    fakeChats = [{ id: 'room-1', title: 'Room 1', type: 'direct' }];
    await initChannelAdapters(() => ({
      onInbound,
      onInboundEvent: async () => okResult('evt'),
      onMetadata: () => {},
      onAction: () => {},
    }));

    const link = fakeLinks[0];
    const base = {
      roomId: 'room-1',
      senderId: 'user-1',
      senderType: 'User',
      senderName: 'User One',
      messageType: 'text',
      metadata: { mentions: [{ id: 'agent-1' }] },
      createdAt: new Date(),
    };
    const inbox: Record<string, unknown>[] = [
      { ...base, id: 'msg-stuck', content: 'first (drops)' },
      { ...base, id: 'msg-next', content: 'second (routes)' },
    ];
    const drained = new Set<string>();
    link.markProcessed.mockImplementation(async (_roomId: string, id: string) => {
      drained.add(id);
    });
    link.getNextMessage.mockImplementation(async () => inbox.find((m) => !drained.has(m.id as string)) ?? null);

    link.emit({ type: 'room_added', roomId: 'room-1', payload: { id: 'room-1', title: 'Room 1', type: 'direct' } });

    // Reaching msg-next is only possible if the dropped msg-stuck was consumed
    // and the cursor advanced past it.
    await waitFor(() => drained.has('msg-next'));
    expect(link.markProcessed).toHaveBeenCalledWith('room-1', 'msg-stuck');
    expect(link.markProcessed).toHaveBeenCalledWith('room-1', 'msg-next');
    expect(onInbound).toHaveBeenCalledWith('band:room-1', null, expect.objectContaining({ id: 'msg-next' }));
  });

  it('does not mark unmentioned Band room messages as mentions', async () => {
    setBandEnv();
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'dropped',
      platformMessageId: 'msg-unmentioned',
      reason: 'no_agent_engaged',
      audited: true,
      retryable: false,
      intentional: false,
    };
    const onInbound = vi.fn(async (_platformId: string, _threadId: string | null, _message: InboundMessage) => result);

    await initChannelAdapters(() => ({
      onInbound,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'message_created',
      roomId: 'room-1',
      payload: {
        id: 'msg-unmentioned',
        content: 'room chatter',
        message_type: 'text',
        sender_id: 'user-1',
        sender_type: 'User',
        sender_name: 'User One',
        inserted_at: new Date().toISOString(),
        metadata: { mentions: [{ id: 'someone-else' }] },
      },
    });

    await waitFor(() => onInbound.mock.calls.length === 1);
    expect(onInbound.mock.calls[0][2]).toEqual(expect.objectContaining({ isMention: false }));
    // A non-retryable drop (no_agent_engaged) is terminal — the message is
    // consumed on the platform so the inbox cursor advances past it instead
    // of head-of-line-blocking every later message in the room.
    await waitFor(() => fakeLinks[0].markProcessed.mock.calls.length === 1);
    expect(fakeLinks[0].markProcessing).toHaveBeenCalledWith('room-1', 'msg-unmentioned');
    expect(fakeLinks[0].markProcessed).toHaveBeenCalledWith('room-1', 'msg-unmentioned');
  });

  it('delivers generic outbound chat rows through Band REST fallback', async () => {
    setBandEnv();
    await import('./band.js');
    const { initChannelAdapters, getChannelAdapter } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'unused',
      sessionIds: [],
      sessionMessageIds: [],
    };

    await initChannelAdapters(() => ({
      onInbound: async () => result,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    const adapter = getChannelAdapter('band');
    await expect(
      adapter!.deliver('band:room-1', null, { kind: 'chat', content: { text: 'hello from agent' } }),
    ).resolves.toBe('platform-out-1');
    // Band only notifies tagged participants, so the fallback prepends an
    // inline mention of the recipient even in direct rooms.
    expect(fakeRestClients[0].agentApiMessages.createAgentChatMessage).toHaveBeenCalledWith('room-1', {
      message: {
        content: '@[[owner-1]] hello from agent',
        mentions: [{ id: 'owner-1', name: 'Owner' }],
      },
    });
  });

  it('renders ask_question cards as tagged text and resolves slash-command replies', async () => {
    setBandEnv();
    process.env.BAND_OWNER_ID = 'owner-1';
    fakeParticipants['room-1'] = [
      { id: 'owner-1', type: 'User', role: 'member' },
      { id: 'agent-1', type: 'Agent', role: 'owner' },
    ];
    await import('./band.js');
    const { initChannelAdapters, getActiveAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'unused',
      sessionIds: [],
      sessionMessageIds: [],
    };
    const onAction = vi.fn();
    const onInbound = vi.fn(async () => result);

    await initChannelAdapters(() => ({
      onInbound,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction,
    }));

    const adapter = getActiveAdapters().find((a) => a.channelType === 'band')!;
    const msgId = await adapter.deliver('band:room-1', null, {
      kind: 'chat-sdk',
      content: JSON.stringify({
        type: 'ask_question',
        questionId: 'q-1',
        title: 'New channel',
        question: 'Wire it?',
        options: ['Approve', 'Deny'],
      }),
    });
    expect(msgId).toBe('platform-out-1');
    const calls = fakeRestClients[0].agentApiMessages.createAgentChatMessage.mock.calls as unknown as Array<
      [string, { message: { content: string } }]
    >;
    const sent = calls.at(-1)![1];
    expect(sent.message.content).toContain('@[[owner-1]]');
    expect(sent.message.content).toContain('/approve');

    // The owner replies with the slash command (Band embeds mention markup).
    fakeLinks[0].emit({
      type: 'message_created',
      roomId: 'room-1',
      payload: {
        id: 'reply-1',
        content: '@[[agent-1]] /approve',
        message_type: 'text',
        sender_id: 'owner-1',
        sender_type: 'User',
        sender_name: 'Owner',
        inserted_at: new Date().toISOString(),
        metadata: { mentions: [{ id: 'agent-1' }] },
      },
    });

    await waitFor(() => onAction.mock.calls.length === 1);
    expect(onAction).toHaveBeenCalledWith('q-1', 'Approve', 'owner-1');
    // The reply must not be forwarded to the agent as a normal message.
    expect(onInbound).not.toHaveBeenCalled();
  });

  it('injects Band env for HTTPS sessions without direct API key', async () => {
    setBandEnv();
    process.env.BAND_MEMORY_TOOLS = 'true';
    process.env.BAND_MEMORY_LOAD_ON_START = 'true';
    process.env.BAND_MEMORY_CONSOLIDATION = 'true';
    await import('./band.js');
    const { getChannelContainerConfig } = await import('./channel-container-registry.js');

    const config = await getChannelContainerConfig('band')!({
      session: {
        id: 'sess-1',
        agent_group_id: 'ag-1',
        messaging_group_id: 'mg-1',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      messagingGroup: {
        id: 'mg-1',
        channel_type: 'band',
        platform_id: 'band:room-1',
        name: 'Room 1',
        is_group: 1,
        unknown_sender_policy: 'public',
        denied_at: null,
        created_at: new Date().toISOString(),
      },
      agentGroupId: 'ag-1',
      hostEnv: process.env,
    });

    expect(config.env).toEqual(
      expect.objectContaining({
        NANOCLAW_CHANNEL: 'band',
        BAND_ROOM_ID: 'room-1',
        BAND_AGENT_ID: 'agent-1',
        BAND_REST_URL: 'https://band.example.test',
        BAND_MEMORY_TOOLS: 'true',
        BAND_MEMORY_LOAD_ON_START: 'true',
        BAND_MEMORY_CONSOLIDATION: 'true',
      }),
    );
    expect(config.env).not.toHaveProperty('BAND_API_KEY');
    expect(config.env).not.toHaveProperty('THENVOI_API_KEY');
  });

  it('injects direct Band API key for explicit live validation override', async () => {
    setBandEnv();
    process.env.BAND_INJECT_API_KEY = 'true';
    await import('./band.js');
    const { getChannelContainerConfig } = await import('./channel-container-registry.js');

    const config = await getChannelContainerConfig('band')!({
      session: {
        id: 'sess-1',
        agent_group_id: 'ag-1',
        messaging_group_id: 'mg-1',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      messagingGroup: {
        id: 'mg-1',
        channel_type: 'band',
        platform_id: 'band:room-1',
        name: 'Room 1',
        is_group: 1,
        unknown_sender_policy: 'public',
        denied_at: null,
        created_at: new Date().toISOString(),
      },
      agentGroupId: 'ag-1',
      hostEnv: process.env,
    });

    expect(config.env).toHaveProperty('BAND_API_KEY', 'secret');
    expect(config.env).toHaveProperty('THENVOI_API_KEY', 'secret');
  });

  it('injects direct Band API key only for local HTTP sessions', async () => {
    setBandEnv();
    process.env.BAND_BASE_URL = 'http://localhost:4000';
    await import('./band.js');
    const { getChannelContainerConfig } = await import('./channel-container-registry.js');

    const config = await getChannelContainerConfig('band')!({
      session: {
        id: 'sess-1',
        agent_group_id: 'ag-1',
        messaging_group_id: 'mg-1',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      messagingGroup: {
        id: 'mg-1',
        channel_type: 'band',
        platform_id: 'band:room-1',
        name: 'Room 1',
        is_group: 1,
        unknown_sender_policy: 'public',
        denied_at: null,
        created_at: new Date().toISOString(),
      },
      agentGroupId: 'ag-1',
      hostEnv: process.env,
    });

    expect(config.env).toEqual(
      expect.objectContaining({
        BAND_REST_URL: 'http://host.docker.internal:4000',
        BAND_API_KEY: 'secret',
      }),
    );
  });

  it('bootstraps the Nano Hub on install when no owner room exists', async () => {
    setBandEnv();
    process.env.BAND_OWNER_ID = 'owner-1';
    fakeChats = []; // fresh install: agent has no rooms at all
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'unused',
      sessionIds: [],
      sessionMessageIds: [],
    };

    await initChannelAdapters(() => ({
      onInbound: async () => result,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    const rest = fakeRestClients[0];
    expect(rest.agentApiChats.createAgentChat).toHaveBeenCalledTimes(1);
    expect(rest.agentApiParticipants.addAgentChatParticipant).toHaveBeenCalledWith('hub-room-1', {
      participant: { participant_id: 'owner-1', role: 'member' },
    });

    const { getModuleState, getMessagingGroupByPlatform } = await import('../db/index.js');
    expect(getModuleState('band', 'main-room')).toMatchObject({
      roomId: 'hub-room-1',
      platformId: 'band:hub-room-1',
    });
    expect(getMessagingGroupByPlatform('band', 'band:hub-room-1')).toMatchObject({
      name: 'Nano Hub',
      is_group: 0,
    });
  });

  it('openDM resolves the owner to the Nano Hub without creating a room', async () => {
    setBandEnv();
    process.env.BAND_OWNER_ID = 'owner-1';
    fakeParticipants['room-1'] = [
      { id: 'owner-1', type: 'User', role: 'member' },
      { id: 'agent-1', type: 'Agent', role: 'owner' },
    ];
    await import('./band.js');
    const { initChannelAdapters, getActiveAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'unused',
      sessionIds: [],
      sessionMessageIds: [],
    };

    await initChannelAdapters(() => ({
      onInbound: async () => result,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    const adapter = getActiveAdapters().find((a) => a.channelType === 'band')!;
    await expect(adapter.openDM!('owner-1')).resolves.toBe('band:room-1');
    expect(fakeRestClients[0].agentApiChats.createAgentChat).not.toHaveBeenCalled();
  });

  it('detects the main control room by fetching participants when the room payload has none', async () => {
    setBandEnv();
    process.env.BAND_OWNER_ID = 'owner-1';
    // Agent API room objects carry no participants — detection must fetch them.
    fakeChats = [{ id: 'room-1', title: 'New Session', type: 'group' }];
    fakeParticipants['room-1'] = [
      { id: 'owner-1', type: 'User', role: 'member' },
      { id: 'agent-1', type: 'Agent', role: 'owner' },
    ];
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'unused',
      sessionIds: [],
      sessionMessageIds: [],
    };

    await initChannelAdapters(() => ({
      onInbound: async () => result,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    const { getModuleState } = await import('../db/index.js');
    expect(getModuleState('band', 'main-room')).toMatchObject({ roomId: 'room-1', platformId: 'band:room-1' });
    // Sync detection won — the bootstrap must not have created a hub room.
    expect(fakeRestClients[0].agentApiChats.createAgentChat).not.toHaveBeenCalled();
  });

  it('marks discovered owner-agent direct Band room as the main control room for container env', async () => {
    setBandEnv();
    process.env.BAND_OWNER_ID = 'owner-1';
    fakeChats = [
      {
        id: 'room-1',
        title: 'Room 1',
        type: 'direct',
        participants: [{ id: 'agent-1' }, { id: 'owner-1' }],
      },
    ];
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'unused',
      sessionIds: [],
      sessionMessageIds: [],
    };

    await initChannelAdapters(() => ({
      onInbound: async () => result,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    const { getModuleState, getMessagingGroupByPlatform } = await import('../db/index.js');
    expect(getModuleState('band', 'main-room')).toMatchObject({ roomId: 'room-1', platformId: 'band:room-1' });

    const mg = getMessagingGroupByPlatform('band', 'band:room-1')!;
    const { getChannelContainerConfig } = await import('./channel-container-registry.js');
    const config = await getChannelContainerConfig('band')!({
      session: {
        id: 'sess-main',
        agent_group_id: 'ag-1',
        messaging_group_id: mg.id,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      messagingGroup: mg,
      agentGroupId: 'ag-1',
      hostEnv: process.env,
    });

    expect(config.env).toHaveProperty('BAND_IS_MAIN_CONTROL_ROOM', 'true');
  });

  it('does not mark a direct room as main without owner-agent participant proof', async () => {
    setBandEnv();
    process.env.BAND_OWNER_ID = 'owner-1';
    fakeChats = [
      {
        id: 'room-1',
        title: 'Room 1',
        type: 'direct',
        participants: [{ id: 'agent-1' }, { id: 'other-user' }],
      },
    ];
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'unused',
      sessionIds: [],
      sessionMessageIds: [],
    };

    await initChannelAdapters(() => ({
      onInbound: async () => result,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    const { getModuleState, getMessagingGroupByPlatform } = await import('../db/index.js');
    // room-1 lacks owner-agent proof, so the bootstrap creates a fresh Nano
    // Hub and that — not room-1 — becomes the main room.
    expect(getModuleState('band', 'main-room')).toMatchObject({ roomId: 'hub-room-1' });
    expect(getMessagingGroupByPlatform('band', 'band:room-1')).toMatchObject({
      name: 'Room 1',
      is_group: 0,
    });
  });

  it('does not rewrite room metadata from partial participant_added payloads', async () => {
    setBandEnv();
    process.env.BAND_OWNER_ID = 'owner-1';
    fakeChats = [
      {
        id: 'room-1',
        title: 'Room 1',
        type: 'direct',
        participants: [{ id: 'agent-1' }, { id: 'owner-1' }],
      },
    ];
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'unused',
      sessionIds: [],
      sessionMessageIds: [],
    };

    await initChannelAdapters(() => ({
      onInbound: async () => result,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    const { createAgentGroup, createSession, getMessagingGroupByPlatform, getModuleState, getSession } =
      await import('../db/index.js');
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent 1',
      folder: 'agent-1',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const mg = getMessagingGroupByPlatform('band', 'band:room-1')!;
    createSession({
      id: 'sess-room-1',
      agent_group_id: 'ag-1',
      messaging_group_id: mg.id,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: new Date().toISOString(),
    });

    fakeLinks[0].emit({
      type: 'participant_added',
      roomId: 'room-1',
      payload: { id: 'user-42', name: 'Jane', type: 'User', handle: 'jane' },
    });

    await waitFor(() => getSession('sess-room-1')?.status === 'closed');
    expect(getModuleState('band', 'main-room')).toBeUndefined();
    expect(getMessagingGroupByPlatform('band', 'band:room-1')).toMatchObject({
      name: 'Nano Hub',
      is_group: 0,
    });
  });

  it('closes active sessions when a Band room lifecycle event invalidates room privilege', async () => {
    setBandEnv();
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'unused',
      sessionIds: [],
      sessionMessageIds: [],
    };

    await initChannelAdapters(() => ({
      onInbound: async () => result,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    const { createAgentGroup, createSession, getMessagingGroupByPlatform, getSession } = await import('../db/index.js');
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent 1',
      folder: 'agent-1',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const mg = getMessagingGroupByPlatform('band', 'band:room-1')!;
    createSession({
      id: 'sess-room-1',
      agent_group_id: 'ag-1',
      messaging_group_id: mg.id,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: new Date().toISOString(),
    });

    fakeLinks[0].emit({ type: 'participant_removed', roomId: 'room-1', payload: { participant_id: 'agent-1' } });
    await waitFor(() => getSession('sess-room-1')?.status === 'closed');
  });

  it('consumes a retryable drop on the platform but leaves the host ledger for replay', async () => {
    setBandEnv();
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const { getInboundDelivery } = await import('../db/index.js');
    const result: InboundRouteResult = {
      status: 'dropped',
      platformMessageId: 'msg-drop',
      reason: 'no_agent_wired',
      audited: true,
      retryable: true,
      intentional: false,
    };

    await initChannelAdapters(() => ({
      onInbound: async () => result,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'message_created',
      roomId: 'room-1',
      payload: {
        id: 'msg-drop',
        content: 'hello?',
        message_type: 'text',
        sender_id: 'user-1',
        sender_type: 'User',
        inserted_at: new Date().toISOString(),
      },
    });

    // The platform cursor advances even on a retryable drop, so the drain
    // does not head-of-line-block on a channel that is awaiting approval.
    await waitFor(() => fakeLinks[0].markProcessed.mock.calls.length === 1);
    expect(fakeLinks[0].markProcessing).toHaveBeenCalledWith('room-1', 'msg-drop');
    expect(fakeLinks[0].markProcessed).toHaveBeenCalledWith('room-1', 'msg-drop');
    // But the host dedup ledger is NOT flipped to 'processed' — the channel
    // approval gate's host-side replay must be able to re-route this event.
    expect(
      getInboundDelivery({ channelType: 'band', platformId: 'band:room-1', platformMessageId: 'msg-drop' }),
    ).toBeUndefined();
  });

  it('forwards BAND_OWNER_ID into the container env when set', async () => {
    setBandEnv();
    process.env.BAND_OWNER_ID = 'owner-uuid-from-env';
    await import('./band.js');
    const { getChannelContainerConfig } = await import('./channel-container-registry.js');

    const config = await getChannelContainerConfig('band')!({
      session: {
        id: 'sess-1',
        agent_group_id: 'ag-1',
        messaging_group_id: 'mg-1',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      messagingGroup: {
        id: 'mg-1',
        channel_type: 'band',
        platform_id: 'band:room-1',
        name: 'Room 1',
        is_group: 1,
        unknown_sender_policy: 'public',
        denied_at: null,
        created_at: new Date().toISOString(),
      },
      agentGroupId: 'ag-1',
      hostEnv: process.env,
    });

    expect(config.env).toHaveProperty('BAND_OWNER_ID', 'owner-uuid-from-env');
    delete process.env.BAND_OWNER_ID;
  });

  it('rejects the removed callback contact strategy instead of auto-approving requests', async () => {
    setBandEnv();
    process.env.BAND_CONTACT_STRATEGY = 'callback';
    await import('./band.js');
    const { getChannelAdapter, initChannelAdapters } = await import('./channel-registry.js');

    await initChannelAdapters(() => ({
      onInbound: async () => undefined,
      onInboundEvent: async () => undefined,
      onMetadata: () => {},
      onAction: () => {},
    }));

    expect(getChannelAdapter('band')).toBeUndefined();
    expect(fakeRestClients).toHaveLength(0);
  });

  it('creates a hub room and routes contact events into it under hub_room strategy', async () => {
    setBandEnv();
    process.env.BAND_OWNER_ID = 'owner-1';
    // Pre-existing owner room so the Nano Hub bootstrap no-ops and the
    // contact-hub assertions only see contact-flow REST calls.
    fakeParticipants['room-1'] = [
      { id: 'owner-1', type: 'User', role: 'member' },
      { id: 'agent-1', type: 'Agent', role: 'owner' },
    ];
    process.env.BAND_CONTACT_STRATEGY = 'hub_room';
    process.env.BAND_CONTACT_AGENT_GROUP_ID = 'ag-contact';
    const { createAgentGroup } = await import('../db/index.js');
    createAgentGroup({
      id: 'ag-contact',
      name: 'Contact Agent',
      folder: 'contact-agent',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const onInbound = vi.fn(
      async (_platformId: string, _threadId: string | null) =>
        ({
          status: 'persisted',
          platformMessageId: 'unused',
          sessionIds: [],
          sessionMessageIds: [],
        }) satisfies InboundRouteResult,
    );

    await initChannelAdapters(() => ({
      onInbound,
      onInboundEvent: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'contact_request_received',
      roomId: null,
      payload: {
        id: 'req-hub-1',
        from_handle: 'jane',
        from_name: 'Jane Doe',
        status: 'pending',
        inserted_at: new Date().toISOString(),
      },
    });

    await waitFor(() => fakeRestClients[0].agentApiChats.createAgentChat.mock.calls.length === 1);
    await waitFor(() => fakeRestClients[0].agentApiParticipants.addAgentChatParticipant.mock.calls.length === 1);
    await waitFor(() => onInbound.mock.calls.some(([platformId]) => platformId === 'band:hub-room-1'));
    await waitFor(() => fakeRestClients[0].agentApiEvents.createAgentChatEvent.mock.calls.length === 1);

    expect(fakeRestClients[0].agentApiParticipants.addAgentChatParticipant).toHaveBeenCalledWith('hub-room-1', {
      participant: { participant_id: 'owner-1', role: 'member' },
    });

    const { getModuleState, getMessagingGroupByPlatform, getMessagingGroupAgentByPair } =
      await import('../db/index.js');
    expect(getModuleState('band', 'hub-room')).toMatchObject({ roomId: 'hub-room-1' });
    const mg = getMessagingGroupByPlatform('band', 'band:hub-room-1');
    expect(mg).toMatchObject({ name: 'Contact Hub', unknown_sender_policy: 'public' });
    expect(getMessagingGroupAgentByPair(mg!.id, 'ag-contact')).toMatchObject({
      agent_group_id: 'ag-contact',
      engage_mode: 'mention',
      session_mode: 'shared',
    });
  });

  it('reuses an existing hub room across contact events without recreating it', async () => {
    setBandEnv();
    process.env.BAND_OWNER_ID = 'owner-1';
    // Pre-existing owner room so the Nano Hub bootstrap no-ops and the
    // contact-hub assertions only see contact-flow REST calls.
    fakeParticipants['room-1'] = [
      { id: 'owner-1', type: 'User', role: 'member' },
      { id: 'agent-1', type: 'Agent', role: 'owner' },
    ];
    process.env.BAND_CONTACT_STRATEGY = 'hub_room';
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');

    await initChannelAdapters(() => ({
      onInbound: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onInboundEvent: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'contact_added',
      roomId: null,
      payload: {
        id: 'contact-1',
        handle: 'jane',
        name: 'Jane Doe',
        type: 'human',
        inserted_at: new Date().toISOString(),
      },
    });
    fakeLinks[0].emit({
      type: 'contact_added',
      roomId: null,
      payload: {
        id: 'contact-2',
        handle: 'bob',
        name: 'Bob Roe',
        type: 'human',
        inserted_at: new Date().toISOString(),
      },
    });

    await waitFor(() => fakeRestClients[0].agentApiEvents.createAgentChatEvent.mock.calls.length === 2);
    expect(fakeRestClients[0].agentApiChats.createAgentChat).toHaveBeenCalledTimes(1);
  });

  it('drops contact events under disabled strategy without calling REST', async () => {
    setBandEnv();
    process.env.BAND_OWNER_ID = 'owner-1';
    // Pre-existing owner room so the Nano Hub bootstrap no-ops and the
    // contact-hub assertions only see contact-flow REST calls.
    fakeParticipants['room-1'] = [
      { id: 'owner-1', type: 'User', role: 'member' },
      { id: 'agent-1', type: 'Agent', role: 'owner' },
    ];
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');

    await initChannelAdapters(() => ({
      onInbound: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onInboundEvent: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'contact_request_received',
      roomId: null,
      payload: {
        id: 'req-disabled',
        from_handle: 'jane',
        from_name: 'Jane Doe',
        status: 'pending',
        inserted_at: new Date().toISOString(),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeRestClients[0].agentApiContacts.respondToAgentContactRequest).not.toHaveBeenCalled();
    expect(fakeRestClients[0].agentApiChats.createAgentChat).not.toHaveBeenCalled();
  });

  it('injects participant memories on participant_added when memory load-on-start is enabled', async () => {
    setBandEnv();
    process.env.BAND_MEMORY_LOAD_ON_START = 'true';
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');

    const onInbound = vi.fn(
      async (_platformId: string, _threadId: string | null, _message: unknown) =>
        ({
          status: 'persisted',
          platformMessageId: 'unused',
          sessionIds: [],
          sessionMessageIds: [],
        }) satisfies InboundRouteResult,
    );
    await initChannelAdapters(() => ({
      onInbound,
      onInboundEvent: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeRestClients[0].agentApiMemories.listAgentMemories.mockResolvedValueOnce({
      data: {
        data: [
          { type: 'semantic', content: 'Prefers dark mode' },
          { type: 'episodic', content: 'Mentioned a deadline on 2026-04-01' },
        ],
      },
    });

    fakeLinks[0].emit({
      type: 'participant_added',
      roomId: 'room-1',
      payload: { id: 'user-42', name: 'Jane', type: 'User', handle: 'jane' },
    });

    await waitFor(() => fakeRestClients[0].agentApiMemories.listAgentMemories.mock.calls.length === 1);
    await waitFor(() => onInbound.mock.calls.some(([platformId]) => platformId === 'band:room-1'));

    expect(fakeRestClients[0].agentApiMemories.listAgentMemories).toHaveBeenCalledWith({
      subject_id: 'user-42',
      scope: 'subject',
    });
    const call = onInbound.mock.calls.find(([platformId]) => platformId === 'band:room-1')!;
    const message = call[2] as { content: { text: string; senderId: string } };
    expect(message.content.senderId).toBe('system');
    expect(message.content.text).toContain('Jane joined the room');
    expect(message.content.text).toContain('Prefers dark mode');
  });

  it('does not fetch participant memories when load-on-start is disabled', async () => {
    setBandEnv();
    await import('./band.js');
    const { initChannelAdapters } = await import('./channel-registry.js');

    await initChannelAdapters(() => ({
      onInbound: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onInboundEvent: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'participant_added',
      roomId: 'room-1',
      payload: { id: 'user-42', name: 'Jane', type: 'User', handle: 'jane' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeRestClients[0].agentApiMemories.listAgentMemories).not.toHaveBeenCalled();
  });
});
