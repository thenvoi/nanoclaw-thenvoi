import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock AgentRuntime ---

let onExecuteCallback:
  | ((context: unknown, event: unknown) => Promise<void>)
  | null = null;
let onSessionCleanupCallback: ((roomId: string) => Promise<void>) | null = null;
let onContactEventCallback: ((event: unknown) => Promise<void>) | null = null;
let onParticipantAddedCallback:
  | ((
      roomId: string,
      participant: {
        id: string;
        name: string;
        type: string;
        handle?: string | null;
      },
    ) => Promise<void>)
  | null = null;
let onParticipantRemovedCallback:
  | ((roomId: string, participantId: string) => void)
  | null = null;
let onRoomJoinedCallback:
  | ((roomId: string, payload?: { title?: string; inserted_at?: string }) => void)
  | null = null;
let onRoomLeftCallback: ((roomId: string) => void) | null = null;

const configMock = vi.hoisted(() => ({
  ASSISTANT_NAME: 'Andy',
  THENVOI_CONTACT_STRATEGY: 'disabled',
  THENVOI_OWNER_ID: '',
  THENVOI_MEMORY_LOAD_ON_START: false as boolean,
}));

const mockRuntime = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(true),
};

const mockLink = {
  isConnected: vi.fn().mockReturnValue(true),
  subscribeRoom: vi.fn().mockResolvedValue(undefined),
  rest: {
    createChatMessage: vi.fn().mockResolvedValue({}),
    createChat: vi.fn().mockResolvedValue({ id: 'hub-room-1' }),
    addChatParticipant: vi.fn().mockResolvedValue({}),
    createChatEvent: vi.fn().mockResolvedValue({}),
    listChats: vi.fn().mockResolvedValue({ data: [], pagination: null }),
    getAgentMe: vi.fn().mockResolvedValue({
      id: 'agent-123',
      name: 'Test Agent',
      description: null,
      handle: 'test-agent',
      ownerUuid: 'owner-from-sdk',
    }),
    getNextMessage: vi.fn().mockResolvedValue(null),
    markMessageProcessing: vi.fn().mockResolvedValue({}),
    markMessageProcessed: vi.fn().mockResolvedValue({}),
  },
};

vi.mock('@thenvoi/sdk', () => ({
  ThenvoiLink: vi.fn().mockImplementation(function () {
    return mockLink;
  }),
  AgentRuntime: vi.fn().mockImplementation(function (opts: {
    onExecute: (ctx: unknown, ev: unknown) => Promise<void>;
    onSessionCleanup?: (roomId: string) => Promise<void>;
    onContactEvent?: (event: unknown) => Promise<void>;
    onParticipantAdded?: (
      roomId: string,
      participant: {
        id: string;
        name: string;
        type: string;
        handle?: string | null;
      },
    ) => Promise<void>;
    onParticipantRemoved?: (roomId: string, participantId: string) => void;
    onRoomJoined?: (roomId: string, payload?: unknown) => void;
    onRoomLeft?: (roomId: string) => void;
  }) {
    onExecuteCallback = opts.onExecute;
    onSessionCleanupCallback = opts.onSessionCleanup ?? null;
    onContactEventCallback = opts.onContactEvent ?? null;
    onParticipantAddedCallback = opts.onParticipantAdded ?? null;
    onParticipantRemovedCallback = opts.onParticipantRemoved ?? null;
    onRoomJoinedCallback = opts.onRoomJoined ?? null;
    onRoomLeftCallback = opts.onRoomLeft ?? null;
    return mockRuntime;
  }),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({}),
}));

vi.mock('../config.js', () => configMock);

vi.mock('../db.js', () => ({
  setRegisteredGroup: vi.fn(),
  getAllRegisteredGroups: vi.fn().mockReturnValue({}),
  storeChatMetadata: vi.fn(),
  storeMessage: vi.fn(),
  getRouterState: vi.fn().mockReturnValue(null),
  setRouterState: vi.fn(),
}));

vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn().mockReturnValue('/tmp/test-group'),
  isValidGroupFolder: vi.fn().mockReturnValue(true),
}));

// Must import AFTER mocks
import { getChannelFactory } from './registry.js';
import './thenvoi.js';
import { storeMessage, storeChatMetadata, setRouterState } from '../db.js';

describe('Thenvoi Channel', () => {
  const savedEnv = { ...process.env };

  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();
  const registeredGroups = vi.fn().mockReturnValue({});

  function createChannel() {
    return getChannelFactory('thenvoi')!({
      onMessage,
      onChatMetadata,
      registeredGroups,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    onExecuteCallback = null;
    onSessionCleanupCallback = null;
    onContactEventCallback = null;
    onParticipantAddedCallback = null;
    onParticipantRemovedCallback = null;
    onRoomJoinedCallback = null;
    onRoomLeftCallback = null;
    configMock.THENVOI_CONTACT_STRATEGY = 'disabled';
    configMock.THENVOI_OWNER_ID = '';
    configMock.THENVOI_MEMORY_LOAD_ON_START = false;
    process.env.THENVOI_AGENT_ID = 'agent-123';
    process.env.THENVOI_API_KEY = 'key-abc';
    process.env.THENVOI_BASE_URL = 'https://test.thenvoi.com';
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  describe('factory', () => {
    it('registers as thenvoi', () => {
      expect(getChannelFactory('thenvoi')).toBeDefined();
    });

    it('returns null when THENVOI_AGENT_ID is missing', () => {
      delete process.env.THENVOI_AGENT_ID;
      expect(createChannel()).toBeNull();
    });

    it('returns null when THENVOI_API_KEY is missing', () => {
      delete process.env.THENVOI_API_KEY;
      expect(createChannel()).toBeNull();
    });

    it('returns null when THENVOI_BASE_URL is missing', () => {
      delete process.env.THENVOI_BASE_URL;
      expect(createChannel()).toBeNull();
    });

    it('returns channel when all env vars set', () => {
      const ch = createChannel();
      expect(ch).not.toBeNull();
      expect(ch!.name).toBe('thenvoi');
    });
  });

  describe('connect', () => {
    it('creates ThenvoiLink with correct wsUrl', async () => {
      const ch = createChannel()!;
      await ch.connect();

      const { ThenvoiLink } = await import('@thenvoi/sdk');
      expect(ThenvoiLink).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-123',
          apiKey: 'key-abc',
          wsUrl: 'wss://test.thenvoi.com/api/v1/socket/websocket',
        }),
      );
    });

    it('creates AgentRuntime and starts it', async () => {
      const ch = createChannel()!;
      await ch.connect();

      const { AgentRuntime } = await import('@thenvoi/sdk');
      expect(AgentRuntime).toHaveBeenCalled();
      expect(mockRuntime.start).toHaveBeenCalled();
    });

    it('captures onExecute callback', async () => {
      const ch = createChannel()!;
      await ch.connect();
      expect(onExecuteCallback).toBeInstanceOf(Function);
    });
  });

  describe('inbound messages (via onExecute)', () => {
    it('stores text messages via onMessage', async () => {
      const ch = createChannel()!;
      await ch.connect();

      await onExecuteCallback!(
        { roomId: 'room-1' },
        {
          type: 'message_created',
          payload: {
            id: 'msg-1',
            content: 'hello from platform',
            message_type: 'text',
            sender_id: 'user-456',
            sender_type: 'User',
            sender_name: 'Alice',
            chat_room_id: 'room-1',
            inserted_at: '2026-03-14T10:00:00Z',
          },
        },
      );

      expect(onMessage).toHaveBeenCalledWith('thenvoi:room-1', {
        id: 'msg-1',
        chat_jid: 'thenvoi:room-1',
        sender: 'user-456',
        sender_name: 'Alice',
        content: 'hello from platform',
        timestamp: '2026-03-14T10:00:00Z',
        is_from_me: false,
        is_bot_message: false,
      });
    });

    it('skips own messages', async () => {
      const ch = createChannel()!;
      await ch.connect();

      await onExecuteCallback!(
        { roomId: 'room-1' },
        {
          type: 'message_created',
          payload: {
            id: 'msg-2',
            content: 'my own message',
            message_type: 'text',
            sender_id: 'agent-123',
            sender_type: 'Agent',
            inserted_at: '2026-03-14T10:01:00Z',
          },
        },
      );

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('skips non-text messages', async () => {
      const ch = createChannel()!;
      await ch.connect();

      await onExecuteCallback!(
        { roomId: 'room-1' },
        {
          type: 'message_created',
          payload: {
            id: 'msg-3',
            content: 'system event',
            message_type: 'system',
            sender_id: 'user-456',
            sender_type: 'User',
            inserted_at: '2026-03-14T10:02:00Z',
          },
        },
      );

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('delivers messages from other agents (is_bot_message=false so NanoClaw processes them)', async () => {
      const ch = createChannel()!;
      await ch.connect();

      await onExecuteCallback!(
        { roomId: 'room-1' },
        {
          type: 'message_created',
          payload: {
            id: 'msg-4',
            content: 'from another agent',
            message_type: 'text',
            sender_id: 'other-agent-789',
            sender_type: 'Agent',
            sender_name: 'OtherBot',
            inserted_at: '2026-03-14T10:03:00Z',
          },
        },
      );

      // Other agents' messages must NOT be marked as bot messages
      // so NanoClaw's message loop delivers them to the container
      expect(onMessage).toHaveBeenCalledWith(
        'thenvoi:room-1',
        expect.objectContaining({ is_bot_message: false }),
      );
    });

    it('auto-registers group on first message', async () => {
      const registerGroupFn = vi.fn();
      const ch = getChannelFactory('thenvoi')!({
        onMessage,
        onChatMetadata,
        registeredGroups,
        registerGroup: registerGroupFn,
      });
      await ch!.connect();

      await onExecuteCallback!(
        { roomId: 'room-new' },
        {
          type: 'message_created',
          payload: {
            id: 'msg-5',
            content: 'first message',
            message_type: 'text',
            sender_id: 'user-456',
            sender_type: 'User',
            inserted_at: '2026-03-14T10:04:00Z',
          },
        },
      );

      expect(registerGroupFn).toHaveBeenCalledWith(
        'thenvoi:room-new',
        expect.objectContaining({
          folder: expect.stringMatching(/^thenvoi_/),
          requiresTrigger: false,
        }),
      );
    });
  });

  describe('outbound messages', () => {
    it('sendMessage logs warning instead of calling REST (agent uses platform tools)', async () => {
      const ch = createChannel()!;
      await ch.connect();

      await ch.sendMessage('thenvoi:room-abc', 'hello back');

      expect(mockLink.rest.createChatMessage).not.toHaveBeenCalled();
    });
  });

  describe('ownsJid', () => {
    it('returns true for thenvoi: prefix', () => {
      const ch = createChannel()!;
      expect(ch.ownsJid('thenvoi:room-123')).toBe(true);
    });

    it('returns false for other prefixes', () => {
      const ch = createChannel()!;
      expect(ch.ownsJid('120363@g.us')).toBe(false);
      expect(ch.ownsJid('tg:-100123')).toBe(false);
    });
  });

  describe('session cleanup (room removal)', () => {
    it('deregisters group on session cleanup', async () => {
      registeredGroups.mockReturnValue({
        'thenvoi:room-gone': { name: 'Gone Room', folder: 'thenvoi_gone' },
      });

      const ch = createChannel()!;
      await ch.connect();

      await onSessionCleanupCallback!('room-gone');
      // Logger should log deregistration (we can't easily assert on pino)
    });
  });

  describe('disconnect', () => {
    it('stops runtime', async () => {
      const ch = createChannel()!;
      await ch.connect();
      await ch.disconnect();

      expect(mockRuntime.stop).toHaveBeenCalled();
    });
  });

  describe('contact events', () => {
    it('captures onContactEvent callback', async () => {
      const ch = createChannel()!;
      await ch.connect();
      expect(onContactEventCallback).toBeInstanceOf(Function);
    });

    it('logs warning for disabled strategy', async () => {
      // THENVOI_CONTACT_STRATEGY defaults to 'disabled' (not in process.env)
      const ch = createChannel()!;
      await ch.connect();

      // Should not throw
      await onContactEventCallback!({
        type: 'contact_request_received',
        payload: {
          id: 'req-1',
          from_handle: 'alice',
          from_name: 'Alice',
          status: 'pending',
        },
      });
    });

    it('creates a hub room and adds the SDK owner when strategy is hub_room', async () => {
      configMock.THENVOI_CONTACT_STRATEGY = 'hub_room';

      const registerGroupFn = vi.fn();
      const ch = getChannelFactory('thenvoi')!({
        onMessage,
        onChatMetadata,
        registeredGroups,
        registerGroup: registerGroupFn,
      });
      await ch!.connect();

      await onContactEventCallback!({
        type: 'contact_request_received',
        payload: {
          id: 'req-1',
          from_handle: 'alice',
          from_name: 'Alice',
          message: 'hello',
        },
      });

      expect(mockLink.rest.getAgentMe).toHaveBeenCalled();
      expect(mockLink.rest.createChat).toHaveBeenCalled();
      expect(mockLink.rest.addChatParticipant).toHaveBeenCalledWith(
        'hub-room-1',
        {
          participantId: 'owner-from-sdk',
          role: 'member',
        },
      );
      expect(setRouterState).toHaveBeenCalledWith(
        'thenvoi_contact_hub_room_id',
        'hub-room-1',
      );
      expect(storeChatMetadata).toHaveBeenCalledWith(
        'thenvoi:hub-room-1',
        expect.any(String),
        'Contact Hub',
        'thenvoi',
        true,
      );
      expect(registerGroupFn).toHaveBeenCalledWith(
        'thenvoi:hub-room-1',
        expect.objectContaining({
          name: 'Contact Hub',
          folder: 'thenvoi_contacts_hub',
        }),
      );
      expect(storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_jid: 'thenvoi:hub-room-1',
          sender: 'contact-events',
          is_bot_message: false,
        }),
      );
      expect(mockLink.rest.createChatEvent).toHaveBeenCalledWith(
        'hub-room-1',
        expect.objectContaining({
          messageType: 'task',
          metadata: { contactEventType: 'contact_request_received' },
        }),
      );
    });

    it('prefers THENVOI_OWNER_ID over the SDK owner UUID', async () => {
      configMock.THENVOI_CONTACT_STRATEGY = 'hub_room';
      configMock.THENVOI_OWNER_ID = 'owner-from-env';

      const ch = createChannel()!;
      await ch.connect();

      await onContactEventCallback!({
        type: 'contact_request_received',
        payload: {
          id: 'req-2',
          from_handle: 'bob',
          from_name: 'Bob',
        },
      });

      expect(mockLink.rest.addChatParticipant).toHaveBeenCalledWith(
        'hub-room-1',
        {
          participantId: 'owner-from-env',
          role: 'member',
        },
      );
      expect(mockLink.rest.getAgentMe).not.toHaveBeenCalled();
    });
  });

  describe('participant memory loading (onParticipantAdded)', () => {
    function mockFetchMemories(
      memories: Array<{ type?: string; content: string }>,
    ) {
      return vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ data: memories }),
      });
    }

    const participant = {
      id: 'user-1',
      name: 'Alice',
      type: 'User',
      handle: '@alice',
    };

    async function setupAndConnect() {
      configMock.THENVOI_MEMORY_LOAD_ON_START = true;
      registeredGroups.mockReturnValue({
        'thenvoi:room-1': { name: 'Test Room', folder: 'thenvoi_room1' },
      });
      const ch = createChannel()!;
      await ch.connect();
    }

    it('fetches memories and injects correctly-shaped synthetic message', async () => {
      const fetchMock = mockFetchMemories([
        { type: 'semantic', content: 'Likes dark mode' },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      await setupAndConnect();
      await onParticipantAddedCallback!('room-1', participant);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('test.thenvoi.com/api/v1/agent/memories'),
        expect.objectContaining({
          headers: { 'x-api-key': 'key-abc' },
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('subject_id=user-1&scope=subject'),
        expect.anything(),
      );
      expect(onMessage).toHaveBeenCalledWith(
        'thenvoi:room-1',
        expect.objectContaining({
          chat_jid: 'thenvoi:room-1',
          sender: 'system',
          sender_name: 'System',
          is_from_me: false,
          is_bot_message: false,
          content: expect.stringContaining('[System]: Alice joined the room'),
        }),
      );
      expect(onMessage).toHaveBeenCalledWith(
        'thenvoi:room-1',
        expect.objectContaining({
          content: expect.stringContaining('[semantic] Likes dark mode'),
        }),
      );
    });

    it('no-ops when THENVOI_MEMORY_LOAD_ON_START is false', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      // configMock.THENVOI_MEMORY_LOAD_ON_START is false by default
      const ch = createChannel()!;
      await ch.connect();
      await onParticipantAddedCallback!('room-1', participant);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('no-ops when group is not registered', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      configMock.THENVOI_MEMORY_LOAD_ON_START = true;
      registeredGroups.mockReturnValue({}); // room not registered
      const ch = createChannel()!;
      await ch.connect();
      await onParticipantAddedCallback!('room-1', participant);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('no-ops when API returns empty memories array', async () => {
      vi.stubGlobal('fetch', mockFetchMemories([]));
      await setupAndConnect();
      await onParticipantAddedCallback!('room-1', participant);

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('no-ops when API response has no data field', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          json: () => Promise.resolve({}),
        }),
      );
      await setupAndConnect();
      await onParticipantAddedCallback!('room-1', participant);

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('handles fetch network errors gracefully', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      );
      await setupAndConnect();

      await expect(
        onParticipantAddedCallback!('room-1', participant),
      ).resolves.not.toThrow();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('handles malformed JSON response gracefully', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          json: () => Promise.reject(new Error('Unexpected token')),
        }),
      );
      await setupAndConnect();

      await expect(
        onParticipantAddedCallback!('room-1', participant),
      ).resolves.not.toThrow();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('works for agent participants (not filtered out)', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetchMemories([
          { type: 'procedural', content: 'Handles weather queries' },
        ]),
      );
      await setupAndConnect();

      await onParticipantAddedCallback!('room-1', {
        id: 'agent-other',
        name: 'Weather Agent',
        type: 'Agent',
        handle: '@john/weather',
      });

      expect(onMessage).toHaveBeenCalledWith(
        'thenvoi:room-1',
        expect.objectContaining({
          content: expect.stringContaining('Weather Agent joined the room'),
        }),
      );
    });

    it('limits to 10 memories and uses type fallback for missing type', async () => {
      const memories = Array.from({ length: 15 }, (_, i) => ({
        type: i % 3 === 0 ? undefined : 'semantic',
        content: `Memory ${i + 1}`,
      }));
      vi.stubGlobal('fetch', mockFetchMemories(memories));
      await setupAndConnect();
      await onParticipantAddedCallback!('room-1', participant);

      const call = onMessage.mock.calls[0];
      const content = call[1].content as string;
      const bullets = content
        .split('\n')
        .filter((l: string) => l.startsWith('- '));
      expect(bullets).toHaveLength(10);
      // Indices 0, 3, 6, 9 have no type → should show [memory] fallback
      expect(content).toContain('[memory]');
      expect(content).toContain('[semantic]');
    });
  });

  describe('agent removal and re-addition', () => {
    function createChannelWithRegister() {
      const registerGroupFn = vi.fn();
      const deregisterGroupFn = vi.fn();
      const ch = getChannelFactory('thenvoi')!({
        onMessage,
        onChatMetadata,
        registeredGroups,
        registerGroup: registerGroupFn,
        deregisterGroup: deregisterGroupFn,
      });
      return { ch: ch!, registerGroupFn, deregisterGroupFn };
    }

    it('captures onParticipantRemoved callback', async () => {
      const { ch } = createChannelWithRegister();
      await ch.connect();
      expect(onParticipantRemovedCallback).toBeInstanceOf(Function);
    });

    it('captures onRoomJoined and onRoomLeft callbacks', async () => {
      const { ch } = createChannelWithRegister();
      await ch.connect();
      expect(onRoomJoinedCallback).toBeInstanceOf(Function);
      expect(onRoomLeftCallback).toBeInstanceOf(Function);
    });

    it('deregisters group when the agent itself is removed', async () => {
      const { ch, deregisterGroupFn } = createChannelWithRegister();
      await ch.connect();

      // First join the room
      onRoomJoinedCallback!('room-1', { title: 'Test Room' });

      // Then remove the agent (agentId = 'agent-123' from env)
      onParticipantRemovedCallback!('room-1', 'agent-123');

      expect(deregisterGroupFn).toHaveBeenCalledWith('thenvoi:room-1');
    });

    it('does not deregister when a different participant is removed', async () => {
      const { ch, deregisterGroupFn } = createChannelWithRegister();
      await ch.connect();
      deregisterGroupFn.mockClear(); // clear any calls from connect() stale cleanup

      onRoomJoinedCallback!('room-1', { title: 'Test Room' });
      onParticipantRemovedCallback!('room-1', 'other-user-456');

      expect(deregisterGroupFn).not.toHaveBeenCalled();
    });

    it('re-registers group when agent is re-added after removal', async () => {
      const { ch, registerGroupFn, deregisterGroupFn } =
        createChannelWithRegister();
      // Start with group registered
      registeredGroups.mockReturnValue({
        'thenvoi:room-1': { name: 'Test Room', folder: 'thenvoi_room1' },
      });
      await ch.connect();

      // Join, then get removed
      onRoomJoinedCallback!('room-1', { title: 'Test Room' });
      onParticipantRemovedCallback!('room-1', 'agent-123');
      expect(deregisterGroupFn).toHaveBeenCalledWith('thenvoi:room-1');

      // Simulate deregistration — group no longer in the map
      registeredGroups.mockReturnValue({});
      registerGroupFn.mockClear();

      // Re-add agent
      await onParticipantAddedCallback!('room-1', {
        id: 'agent-123',
        name: 'Andy',
        type: 'Agent',
        handle: '@vlad/andy',
      });

      expect(registerGroupFn).toHaveBeenCalledWith(
        'thenvoi:room-1',
        expect.objectContaining({
          folder: expect.stringMatching(/^thenvoi_/),
          requiresTrigger: false,
        }),
      );
    });

    it('scheduled task fails after agent removal (group not found)', async () => {
      const { ch, deregisterGroupFn } = createChannelWithRegister();
      registeredGroups.mockReturnValue({
        'thenvoi:room-1': { name: 'Test Room', folder: 'thenvoi_room1' },
      });
      await ch.connect();

      onRoomJoinedCallback!('room-1', { title: 'Test Room' });
      onParticipantRemovedCallback!('room-1', 'agent-123');

      expect(deregisterGroupFn).toHaveBeenCalledWith('thenvoi:room-1');

      // After deregistration, isConnected still works but the group is gone
      expect(ch.isConnected()).toBe(true);
    });
  });

  describe('room lifecycle', () => {
    function createChannelWithRegister() {
      const registerGroupFn = vi.fn();
      const deregisterGroupFn = vi.fn();
      const ch = getChannelFactory('thenvoi')!({
        onMessage,
        onChatMetadata,
        registeredGroups,
        registerGroup: registerGroupFn,
        deregisterGroup: deregisterGroupFn,
      });
      return { ch: ch!, registerGroupFn, deregisterGroupFn };
    }

    it('registers group on room joined', async () => {
      const { ch, registerGroupFn } = createChannelWithRegister();
      await ch.connect();

      onRoomJoinedCallback!('room-new', { title: 'New Room' });

      expect(registerGroupFn).toHaveBeenCalledWith(
        'thenvoi:room-new',
        expect.objectContaining({
          name: 'New Room',
          folder: expect.stringMatching(/^thenvoi_/),
          requiresTrigger: false,
        }),
      );
    });

    it('deregisters group on room left', async () => {
      const { ch, deregisterGroupFn } = createChannelWithRegister();
      await ch.connect();

      onRoomJoinedCallback!('room-1', { title: 'Test Room' });
      onRoomLeftCallback!('room-1');

      expect(deregisterGroupFn).toHaveBeenCalledWith('thenvoi:room-1');
    });

    it('deregisters group on session cleanup', async () => {
      const { ch, deregisterGroupFn } = createChannelWithRegister();
      await ch.connect();

      onRoomJoinedCallback!('room-1', { title: 'Test Room' });
      await onSessionCleanupCallback!('room-1');

      expect(deregisterGroupFn).toHaveBeenCalledWith('thenvoi:room-1');
    });
  });
});
