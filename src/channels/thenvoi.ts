import fs from 'fs';
import path from 'path';
import { ThenvoiLink, AgentRuntime } from '@thenvoi/sdk';
import type { ContactEvent } from '@thenvoi/sdk';
import { registerChannel, ChannelOpts } from './registry.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { isValidGroupFolder } from '../group-folder.js';
import {
  getRouterState,
  setRouterState,
  storeMessage,
} from '../db.js';
import { Channel, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

import {
  ASSISTANT_NAME,
  THENVOI_CONTACT_STRATEGY,
  THENVOI_OWNER_ID,
} from '../config.js';

const envKeys = ['THENVOI_AGENT_ID', 'THENVOI_API_KEY', 'THENVOI_BASE_URL'];

/** Derive a valid NanoClaw group folder name from a room ID. */
function roomFolder(roomId: string): string {
  const short = roomId.replace(/-/g, '').slice(0, 12);
  return `thenvoi_${short}`;
}

/** Register a platform room as a NanoClaw group if not already registered. */
function ensureGroupRegistered(
  jid: string,
  roomId: string,
  title: string | undefined,
  opts: ChannelOpts,
): void {
  if (opts.registeredGroups()[jid]) return;
  if (!opts.registerGroup) return;

  const folder = roomFolder(roomId);
  if (!isValidGroupFolder(folder)) {
    logger.warn(
      { jid, folder },
      'Thenvoi: invalid folder name, skipping registration',
    );
    return;
  }

  opts.registerGroup(jid, {
    name: title || `Thenvoi ${roomId.slice(0, 8)}`,
    folder,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  });
}

registerChannel('thenvoi', (opts) => {
  const env = readEnvFile(envKeys);
  const agentId = process.env.THENVOI_AGENT_ID || env.THENVOI_AGENT_ID;
  const apiKey = process.env.THENVOI_API_KEY || env.THENVOI_API_KEY;
  const baseUrl = process.env.THENVOI_BASE_URL || env.THENVOI_BASE_URL;
  if (!agentId || !apiKey || !baseUrl) return null;

  const wsUrl =
    baseUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')
      .replace(/\/$/, '') + '/api/v1/socket/websocket';

  let link: ThenvoiLink;
  let runtime: AgentRuntime;
  const activeRoomIds = new Set<string>();

  // Contact event deduplication (LRU, max 1000)
  const contactDedup = new Set<string>();
  const contactDedupOrder: string[] = [];
  const MAX_CONTACT_DEDUP = 1000;

  const channel: Channel = {
    name: 'thenvoi',

    async connect() {
      activeRoomIds.clear();
      const contactsEnabled = THENVOI_CONTACT_STRATEGY !== 'disabled';
      link = new ThenvoiLink({
        agentId,
        apiKey,
        wsUrl,
        restUrl: baseUrl.replace(/\/$/, ''),
        capabilities: contactsEnabled ? { contacts: true } : undefined,
      });

      runtime = new AgentRuntime({
        link,
        agentId,

        // Called for every message in every room
        async onExecute(context, event) {
          if (event.type !== 'message_created') return;

          const p = event.payload as {
            id: string;
            content: string;
            message_type: string;
            sender_id: string;
            sender_type: string;
            sender_name?: string | null;
            chat_room_id?: string | null;
            inserted_at: string;
          };

          // Skip own messages and non-text
          if (p.sender_id === agentId) return;
          if (p.message_type !== 'text') return;

          const roomId = context.roomId;
          const jid = `thenvoi:${roomId}`;

          // Ensure group is registered (idempotent — checks in-memory map)
          ensureGroupRegistered(jid, roomId, undefined, opts);

          // Store message — NanoClaw's message loop picks it up
          opts.onMessage(jid, {
            id: p.id,
            chat_jid: jid,
            sender: p.sender_id,
            sender_name: p.sender_name ?? p.sender_id,
            content: p.content,
            timestamp: p.inserted_at,
            is_from_me: false,
            // Never mark as bot message — own messages are already filtered above (line 91).
            // Other agents' messages (Weather Agent, etc.) must be delivered to the container.
            is_bot_message: false,
          });

          // Mark message as processed on the platform so the sync loop
          // (Execution.synchronizeWithNext) doesn't re-fetch it
          try {
            await link.rest.markMessageProcessing(roomId, p.id);
            await link.rest.markMessageProcessed(roomId, p.id);
          } catch (err) {
            logger.warn(
              { err, roomId, messageId: p.id },
              'Thenvoi: failed to mark message status',
            );
          }
        },

        onRoomJoined(roomId, payload) {
          activeRoomIds.add(roomId);
          const jid = `thenvoi:${roomId}`;
          const title =
            typeof payload?.title === 'string' ? payload.title : undefined;
          ensureGroupRegistered(jid, roomId, title, opts);
          opts.onChatMetadata(
            jid,
            typeof payload?.inserted_at === 'string'
              ? payload.inserted_at
              : new Date().toISOString(),
            title,
            'thenvoi',
            true,
          );
        },

        onRoomLeft(roomId) {
          opts.deregisterGroup?.(`thenvoi:${roomId}`);
          // If the hub room was deleted, clear persisted ID so it's re-created
          if (hubRoomId === roomId) {
            hubRoomId = null;
            hubRoomInitPromise = null;
            setRouterState(HUB_ROOM_STATE_KEY, '');
            logger.info('Thenvoi: contact hub room deleted, will re-create on next event');
          }
        },

        async onSessionCleanup(roomId) {
          opts.deregisterGroup?.(`thenvoi:${roomId}`);
        },

        async onContactEvent(event: ContactEvent) {
          await handleContactEvent(event, link, opts, agentId);
        },

        onError(error, event) {
          logger.error(
            { err: error, eventType: event.type },
            'Thenvoi runtime error',
          );
        },

        logger: {
          debug: (msg: string, meta?: unknown) =>
            logger.debug(meta, `Thenvoi: ${msg}`),
          info: (msg: string, meta?: unknown) =>
            logger.info(meta, `Thenvoi: ${msg}`),
          warn: (msg: string, meta?: unknown) =>
            logger.warn(meta, `Thenvoi: ${msg}`),
          error: (msg: string, meta?: unknown) =>
            logger.error(meta, `Thenvoi: ${msg}`),
        },
      });

      await runtime.start();

      // Clean up stale Thenvoi groups that no longer exist on the platform
      const groups = opts.registeredGroups();
      for (const jid of Object.keys(groups)) {
        if (!jid.startsWith('thenvoi:')) continue;
        const roomId = jid.replace('thenvoi:', '');
        if (!activeRoomIds.has(roomId)) {
          opts.deregisterGroup?.(jid);
        }
      }

      logger.info(
        { baseUrl, activeRooms: activeRoomIds.size },
        'Thenvoi channel connected',
      );
    },

    async sendMessage(jid: string, _text: string) {
      // Thenvoi agents communicate via platform tools (thenvoi_send_message)
      // inside the container. Stdout is suppressed for Thenvoi groups, so this
      // should never be called. If it is, log a warning.
      logger.warn(
        { jid },
        'Thenvoi: sendMessage called unexpectedly — agent should use platform tools',
      );
    },

    isConnected: () => link?.isConnected?.() ?? false,
    ownsJid: (jid: string) => jid.startsWith('thenvoi:'),

    async syncGroups() {
      // AgentRuntime handles room discovery automatically
    },

    async disconnect() {
      await runtime?.stop();
      logger.info('Thenvoi channel disconnected');
    },
  };

  /** Handle contact events based on configured strategy. */
  async function handleContactEvent(
    event: ContactEvent,
    _link: ThenvoiLink,
    _opts: ChannelOpts,
    _agentId: string,
  ): Promise<void> {
    // Deduplication
    const payload = event.payload as { id?: string; status?: string } | undefined;
    const dedupKey = `${event.type}:${payload?.id ?? 'unknown'}${payload?.status ? ':' + payload.status : ''}`;
    if (contactDedup.has(dedupKey)) {
      logger.debug({ dedupKey }, 'Thenvoi: duplicate contact event skipped');
      return;
    }
    contactDedup.add(dedupKey);
    contactDedupOrder.push(dedupKey);
    while (contactDedup.size > MAX_CONTACT_DEDUP) {
      const oldest = contactDedupOrder.shift();
      if (oldest) contactDedup.delete(oldest);
    }

    // Route based on strategy
    const strategy = THENVOI_CONTACT_STRATEGY;

    if (strategy === 'disabled') {
      logger.warn({ type: event.type, payload: event.payload }, 'Thenvoi: contact event received (strategy=disabled)');
      return;
    }

    if (strategy === 'callback') {
      await handleCallbackStrategy(event, _link);
      return;
    }

    if (strategy === 'hub_room') {
      await handleHubRoomStrategy(event, _link, _opts, _agentId);
      return;
    }

    logger.warn({ strategy }, 'Thenvoi: unknown contact strategy');
  }

  // --- Hub room state ---
  let hubRoomId: string | null = null;
  let hubRoomInitPromise: Promise<string> | null = null;

  const HUB_ROOM_FOLDER = 'thenvoi_contacts_hub';
  const HUB_ROOM_STATE_KEY = 'thenvoi_contact_hub_room_id';

  /** Ensure hub room exists — create if needed, reuse across restarts. */
  async function ensureHubRoom(
    thenvoiLink: ThenvoiLink,
    channelOpts: ChannelOpts,
    thenvoiAgentId: string,
  ): Promise<string> {
    if (hubRoomId) return hubRoomId;

    // Promise lock to prevent concurrent creation
    if (hubRoomInitPromise) return hubRoomInitPromise;

    hubRoomInitPromise = (async () => {
      // Check persisted ID
      const persisted = getRouterState(HUB_ROOM_STATE_KEY);
      if (persisted && channelOpts.registeredGroups()[`thenvoi:${persisted}`]) {
        hubRoomId = persisted;
        logger.info({ hubRoomId }, 'Thenvoi: reusing existing contact hub room');
        return persisted;
      }

      // Create new hub room
      logger.info('Thenvoi: creating contact hub room');
      const result = await thenvoiLink.rest.createChat!();
      const newRoomId = result.id;

      // Auto-derive owner ID if not configured
      let ownerId = THENVOI_OWNER_ID;
      if (!ownerId) {
        try {
          const profile = await thenvoiLink.rest.getAgentMe();
          ownerId = (profile as { owner_uuid?: string }).owner_uuid ?? '';
        } catch {
          logger.warn('Thenvoi: could not auto-derive owner ID from agent profile');
        }
      }

      // Add owner as participant so they can see the hub room
      if (ownerId) {
        try {
          await thenvoiLink.rest.addChatParticipant(newRoomId, {
            participantId: ownerId,
            role: 'member',
          });
          logger.info({ ownerId, hubRoomId: newRoomId }, 'Thenvoi: owner added to contact hub room');
        } catch (err) {
          logger.warn({ err, ownerId }, 'Thenvoi: failed to add owner to contact hub room');
        }
      } else {
        logger.warn('Thenvoi: THENVOI_OWNER_ID not set and auto-derive failed — owner will not see hub room');
      }

      // Persist hub room ID
      setRouterState(HUB_ROOM_STATE_KEY, newRoomId);

      // Register as NanoClaw group
      const jid = `thenvoi:${newRoomId}`;
      if (channelOpts.registerGroup && isValidGroupFolder(HUB_ROOM_FOLDER)) {
        channelOpts.registerGroup(jid, {
          name: 'Contact Hub',
          folder: HUB_ROOM_FOLDER,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });
      }

      // Write specialized CLAUDE.md
      writeHubRoomClaudeMd();

      // Subscribe to the room
      await thenvoiLink.subscribeRoom(newRoomId);

      hubRoomId = newRoomId;
      logger.info({ hubRoomId: newRoomId }, 'Thenvoi: contact hub room created');
      return newRoomId;
    })();

    try {
      return await hubRoomInitPromise;
    } catch (err) {
      hubRoomInitPromise = null;
      throw err;
    }
  }

  /** Write the hub room's CLAUDE.md. */
  function writeHubRoomClaudeMd(): void {
    try {
      const groupDir = resolveGroupFolderPath(HUB_ROOM_FOLDER);
      const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) return;

      fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
      fs.writeFileSync(claudeMdPath, `# Contact Management Hub

You manage contact requests for this agent. When you receive messages
about contact events, evaluate them and take action.

## Tools
- \`thenvoi_respond_contact_request(action, request_id)\` — approve/reject requests
- \`thenvoi_list_contact_requests()\` — see pending requests
- \`thenvoi_list_contacts()\` — see current contacts

## Rules
- Evaluate each request based on the sender and their message
- When in doubt, approve — the owner can remove contacts later
- Report your decisions via \`thenvoi_send_message\`
- Do NOT add/remove participants in this room
- Do NOT delegate to other agents
`);
    } catch (err) {
      logger.warn({ err }, 'Thenvoi: failed to write hub room CLAUDE.md');
    }
  }

  /** Format a contact event as a human-readable message. */
  function formatContactEvent(event: ContactEvent): string {
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
      case 'contact_request_received': {
        const msg = p.message ? `\nMessage: "${p.message}"` : '';
        return `[Contact Request] ${p.from_name} (@${p.from_handle}) wants to connect.${msg}\nRequest ID: ${p.id}`;
      }
      case 'contact_request_updated':
        return `[Contact Update] Request ${p.id} status changed to: ${p.status}`;
      case 'contact_added':
        return `[Contact Added] ${p.name} (@${p.handle}), type: ${p.type}. ID: ${p.id}`;
      case 'contact_removed':
        return `[Contact Removed] Contact ${p.id} was removed.`;
      default:
        return `[Contact Event] ${(event as { type: string }).type}`;
    }
  }

  /** Hub room strategy: route contact events to dedicated room for LLM reasoning. */
  async function handleHubRoomStrategy(
    event: ContactEvent,
    thenvoiLink: ThenvoiLink,
    channelOpts: ChannelOpts,
    thenvoiAgentId: string,
  ): Promise<void> {
    try {
      const roomId = await ensureHubRoom(thenvoiLink, channelOpts, thenvoiAgentId);
      const jid = `thenvoi:${roomId}`;
      const content = formatContactEvent(event);

      // Local: store in SQLite so NanoClaw's message loop processes it
      storeMessage({
        id: `contact-evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: jid,
        sender: 'contact-events',
        sender_name: 'Contact Events',
        content,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });

      // Platform: persist as chat event so owner sees it in UI
      try {
        await thenvoiLink.rest.createChatEvent(roomId, {
          content,
          messageType: 'contact_event',
          metadata: { contactEventType: event.type },
        });
      } catch (err) {
        logger.warn({ err, roomId }, 'Thenvoi: failed to persist contact event to platform');
      }

      logger.info({ type: event.type, hubRoomId: roomId }, 'Thenvoi: contact event injected into hub room');
    } catch (err) {
      logger.error({ err, type: event.type }, 'Thenvoi: hub room strategy failed');
    }
  }

  /** Callback strategy: auto-approve contact requests. */
  async function handleCallbackStrategy(
    event: ContactEvent,
    thenvoiLink: ThenvoiLink,
  ): Promise<void> {
    if (event.type === 'contact_request_received') {
      const payload = event.payload as { id: string; from_handle?: string; from_name?: string };
      logger.info(
        { requestId: payload.id, from: payload.from_handle },
        'Thenvoi: auto-approving contact request (callback strategy)',
      );
      try {
        await thenvoiLink.rest.respondContactRequest!(
          { action: 'approve', target: 'requestId', requestId: payload.id },
        );
        logger.info({ requestId: payload.id }, 'Thenvoi: contact request auto-approved');
      } catch (err) {
        logger.error({ err, requestId: payload.id }, 'Thenvoi: failed to auto-approve contact request');
      }
    } else {
      logger.info({ type: event.type }, 'Thenvoi: contact event (callback strategy)');
    }
  }

  return channel;
});
