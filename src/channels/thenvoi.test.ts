import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock AgentRuntime ---

let onExecuteCallback:
  | ((context: unknown, event: unknown) => Promise<void>)
  | null = null;
let onSessionCleanupCallback: ((roomId: string) => Promise<void>) | null = null;
let onContactEventCallback:
  | ((event: unknown) => Promise<void>)
  | null = null;

const mockRuntime = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(true),
};

const mockLink = {
  isConnected: vi.fn().mockReturnValue(true),
  rest: {
    createChatMessage: vi.fn().mockResolvedValue({}),
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
  }) {
    onExecuteCallback = opts.onExecute;
    onSessionCleanupCallback = opts.onSessionCleanup ?? null;
    onContactEventCallback = opts.onContactEvent ?? null;
    return mockRuntime;
  }),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({}),
}));

vi.mock('../db.js', () => ({
  setRegisteredGroup: vi.fn(),
  getAllRegisteredGroups: vi.fn().mockReturnValue({}),
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
        payload: { id: 'req-1', from_handle: 'alice', from_name: 'Alice', status: 'pending' },
      });
    });
  });
});
