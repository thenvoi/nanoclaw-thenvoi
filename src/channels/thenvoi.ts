import { ThenvoiLink, AgentRuntime } from '@thenvoi/sdk';
import { registerChannel, ChannelOpts } from './registry.js';
import { readEnvFile } from '../env.js';
import { isValidGroupFolder } from '../group-folder.js';
import { Channel, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

import { ASSISTANT_NAME } from '../config.js';

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

  const channel: Channel = {
    name: 'thenvoi',

    async connect() {
      activeRoomIds.clear();
      link = new ThenvoiLink({
        agentId,
        apiKey,
        wsUrl,
        restUrl: baseUrl.replace(/\/$/, ''),
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
        },

        async onSessionCleanup(roomId) {
          opts.deregisterGroup?.(`thenvoi:${roomId}`);
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

  return channel;
});
