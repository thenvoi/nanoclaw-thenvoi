import { BandLink, type PlatformEvent } from '@band-ai/sdk';
import { ThenvoiClient } from '@thenvoi/rest-client';

import type { ChannelAdapter, ChannelSetup, ConversationInfo, OutboundMessage } from './adapter.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import { registerChannelContainerConfig } from './channel-container-registry.js';
import { registerChannelAdapter } from './channel-registry.js';
import { getAllAgentGroups, getAgentGroup } from '../db/agent-groups.js';
import { markInboundDeliveryProcessed } from '../db/inbound-delivery-ledger.js';
import {
  getMessagingGroupByPlatform,
  createMessagingGroup,
  updateMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
} from '../db/messaging-groups.js';
import { closeActiveSessionsForMessagingGroup } from '../db/sessions.js';
import { getModuleState, setModuleState, deleteModuleState } from '../db/module-state.js';
import { log } from '../log.js';
import { getBandConfig, type BandConfig } from '../modules/band-config.js';

export const BAND_CHANNEL_TYPE = 'band';
export const BAND_PLATFORM_PREFIX = 'band:';

const BAND_MODULE_NAME = 'band';
const MAIN_ROOM_STATE_KEY = 'main-room';
const MAIN_ROOM_NAME = 'Nano Hub';
const HUB_ROOM_STATE_KEY = 'hub-room';
const HUB_ROOM_NAME = 'Contact Hub';
const SYNTHETIC_CONTACT_SENDER_ID = 'contact-events';
const SYNTHETIC_CONTACT_SENDER_NAME = 'Contact Events';
const MAX_CONTACT_DEDUP = 1000;
const MAX_DRAIN_PER_ROOM = 50;
const DRAIN_INTERVAL_MS = 60_000;
const PENDING_QUESTIONS_MAX = 64;

/** Normalize an option label to a slash command: "Approve" → "/approve" */
function optionToCommand(option: string): string {
  return '/' + option.toLowerCase().replace(/\s+/g, '-');
}

/** Band inline mention markup: `@[[<uuid>]]`. */
function inlineMention(participantId: string): string {
  return `@[[${participantId}]]`;
}

function stripInlineMentions(content: string): string {
  return content.replace(/@\[\[[^\]]+\]\]/g, '');
}

interface BandMainRoomState {
  roomId: string;
  platformId: string;
  updatedAt: string;
}

interface BandHubRoomState {
  roomId: string;
  platformId: string;
  createdAt: string;
}

interface BandMessageContent {
  text: string;
  sender: string;
  senderId: string;
  senderName: string | null;
  senderType: string;
  roomId: string;
  metadata?: Record<string, unknown>;
}

export function formatBandPlatformId(roomId: string): string {
  return roomId.startsWith(BAND_PLATFORM_PREFIX) ? roomId : `${BAND_PLATFORM_PREFIX}${roomId}`;
}

export function parseBandPlatformId(platformId: string): string {
  if (!platformId.startsWith(BAND_PLATFORM_PREFIX)) {
    throw new Error(`Invalid Band platform id: ${platformId}`);
  }
  return platformId.slice(BAND_PLATFORM_PREFIX.length);
}

function wsUrlFromBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/api/v1/socket';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function restUrlFromWsUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  return `${url.protocol}//${url.host}`;
}

function containerReachableRestUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    url.hostname = 'host.docker.internal';
  }
  return url.toString().replace(/\/$/, '');
}

function shouldInjectDirectApiKey(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function mentionReferencesAgent(mention: unknown, agentId: string): boolean {
  if (typeof mention === 'string') return mention === agentId;
  if (!mention || typeof mention !== 'object') return false;
  const value = mention as Record<string, unknown>;
  return [value.id, value.uuid, value.agent_id, value.agentId, value.participant_id, value.participantId].some(
    (candidate) => candidate === agentId,
  );
}

function metadataMentionsAgent(metadata: Record<string, unknown> | null | undefined, agentId: string): boolean {
  const mentions = metadata?.mentions;
  return Array.isArray(mentions) && mentions.some((mention) => mentionReferencesAgent(mention, agentId));
}

function now(): string {
  return new Date().toISOString();
}

function safeRoomTitle(room: Record<string, unknown>, fallback: string): string {
  return typeof room.title === 'string' && room.title.length > 0 ? room.title : fallback;
}

function collectParticipantIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const participant = value as Record<string, unknown>;
  const ids: string[] = [];
  for (const key of ['id', 'uuid', 'user_id', 'userId', 'agent_id', 'agentId', 'participant_id', 'participantId']) {
    const candidate = participant[key];
    if (typeof candidate === 'string') ids.push(candidate);
  }
  for (const key of ['user', 'agent', 'participant']) {
    ids.push(...collectParticipantIds(participant[key]));
  }
  return ids;
}

function isOwnerAgentDirectRoom(room: Record<string, unknown>, config: BandConfig): boolean {
  if (room.is_main === true || room.isMain === true || room.main === true) return true;

  const participants = Array.isArray(room.participants) ? room.participants : [];
  if (participants.length !== 2 || !config.ownerId) return false;

  const participantIds = participants.map((participant) => new Set(collectParticipantIds(participant)));
  return (
    participantIds.some((ids) => ids.has(config.agentId)) &&
    participantIds.some((ids) => ids.has(config.ownerId as string))
  );
}

function getMainRoomState(): BandMainRoomState | undefined {
  return getModuleState<BandMainRoomState>(BAND_MODULE_NAME, MAIN_ROOM_STATE_KEY);
}

function setMainRoom(roomId: string): void {
  setModuleState(BAND_MODULE_NAME, MAIN_ROOM_STATE_KEY, {
    roomId,
    platformId: formatBandPlatformId(roomId),
    updatedAt: now(),
  } satisfies BandMainRoomState);
}

function isMainRoomPlatformId(platformId: string): boolean {
  return getMainRoomState()?.platformId === platformId;
}

function getHubRoomState(): BandHubRoomState | undefined {
  return getModuleState<BandHubRoomState>(BAND_MODULE_NAME, HUB_ROOM_STATE_KEY);
}

function setHubRoom(roomId: string): void {
  setModuleState(BAND_MODULE_NAME, HUB_ROOM_STATE_KEY, {
    roomId,
    platformId: formatBandPlatformId(roomId),
    createdAt: now(),
  } satisfies BandHubRoomState);
}

function ensureHubMessagingGroup(roomId: string, agentGroupId: string | null): void {
  const platformId = formatBandPlatformId(roomId);
  let messagingGroupId: string;
  const existing = getMessagingGroupByPlatform(BAND_CHANNEL_TYPE, platformId);
  if (existing) {
    messagingGroupId = existing.id;
    if (existing.unknown_sender_policy !== 'public' || existing.name !== HUB_ROOM_NAME) {
      updateMessagingGroup(existing.id, {
        name: HUB_ROOM_NAME,
        is_group: 1,
        unknown_sender_policy: 'public',
      });
    }
  } else {
    messagingGroupId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createMessagingGroup({
      id: messagingGroupId,
      channel_type: BAND_CHANNEL_TYPE,
      platform_id: platformId,
      name: HUB_ROOM_NAME,
      is_group: 1,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: now(),
    });
  }

  if (!agentGroupId) return;
  if (getMessagingGroupAgentByPair(messagingGroupId, agentGroupId)) return;
  createMessagingGroupAgent({
    id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

/**
 * Resolve the agent group that newly-discovered Band rooms should auto-wire
 * to. Only unambiguous when exactly one agent group exists — with zero or
 * many, return null and let the router's channel-approval card disambiguate.
 * Mirrors wireOwnerHub's resolution rule.
 */
function resolveAutoWireAgentGroupId(): string | null {
  const agentGroups = getAllAgentGroups();
  return agentGroups.length === 1 ? agentGroups[0].id : null;
}

/**
 * Auto-approve a discovered Band room: mark it public and wire it to the
 * default agent group. Band gates both channel and participant access on the
 * platform — anyone in a room with the agent was already authorized there — so
 * the host's channel- and sender-approval cards are redundant friction. We
 * therefore mirror the hub precedents: unknown_sender_policy='public' (any
 * room member reaches the agent, like ensureHubMessagingGroup) and a
 * mention-engaged wiring with sender_scope='all' (like wireOwnerHub; Band only
 * delivers agent-mentioning messages to us, so every delivered message is
 * effectively a mention).
 *
 * No-op for denied rooms (an explicit owner denial still wins) and for
 * ambiguous multi-agent installs (the router's approval card handles those).
 */
function autoWireDiscoveredRoom(roomId: string): void {
  const agentGroupId = resolveAutoWireAgentGroupId();
  if (!agentGroupId) return;

  const mg = getMessagingGroupByPlatform(BAND_CHANNEL_TYPE, formatBandPlatformId(roomId));
  if (!mg || mg.denied_at) return;

  if (mg.unknown_sender_policy !== 'public') {
    updateMessagingGroup(mg.id, { unknown_sender_policy: 'public' });
  }

  if (getMessagingGroupAgentByPair(mg.id, agentGroupId)) return;
  createMessagingGroupAgent({
    id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
  log.info('Band.ai auto-wired discovered room', { messagingGroupId: mg.id, agentGroupId, roomId });
}

function upsertDiscoveredMessagingGroup(
  roomId: string,
  room: Record<string, unknown>,
  config: BandConfig,
  forceMain = false,
): void {
  const platformId = formatBandPlatformId(roomId);
  const isMain = forceMain || isOwnerAgentDirectRoom(room, config);
  const name = isMain ? MAIN_ROOM_NAME : safeRoomTitle(room, roomId);
  const isGroup = isMain ? 0 : room.type === 'direct' ? 0 : 1;
  const existing = getMessagingGroupByPlatform(BAND_CHANNEL_TYPE, platformId);

  if (!existing) {
    createMessagingGroup({
      id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel_type: BAND_CHANNEL_TYPE,
      platform_id: platformId,
      name,
      is_group: isGroup,
      unknown_sender_policy: 'request_approval',
      denied_at: null,
      created_at: now(),
    });
  } else {
    updateMessagingGroup(existing.id, { name, is_group: isGroup });
  }

  if (isMain) setMainRoom(roomId);

  // Band controls room ACL on the platform, so the host's approval cards are
  // redundant: auto-wire + open the room instead of escalating to the owner.
  autoWireDiscoveredRoom(roomId);
}

function closeSessionsForRoom(roomId: string, reason: string): void {
  const mg = getMessagingGroupByPlatform(BAND_CHANNEL_TYPE, formatBandPlatformId(roomId));
  if (!mg) return;
  const closed = closeActiveSessionsForMessagingGroup(mg.id);
  if (closed > 0) log.info('Band.ai closed stale room sessions', { roomId, reason, closed });
}

function clearMainRoomIfMatches(roomId: string): void {
  if (getMainRoomState()?.roomId === roomId) deleteModuleState(BAND_MODULE_NAME, MAIN_ROOM_STATE_KEY);
}

class BandChannelAdapter implements ChannelAdapter {
  public readonly name = 'Band.ai';
  public readonly channelType = BAND_CHANNEL_TYPE;
  public readonly supportsThreads = false;

  private setupConfig: ChannelSetup | null = null;
  private connected = false;
  private stopController: AbortController | null = null;
  private eventLoop: Promise<void> | null = null;
  private readonly link: BandLink;
  private readonly restClient: ThenvoiClient;
  private ownerMention: { id: string; name?: string } | null = null;
  private hubRoomInitPromise: Promise<string | null> | null = null;
  private readonly contactDedup = new Set<string>();
  private readonly contactDedupOrder: string[] = [];
  private readonly knownRoomIds = new Set<string>();
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private readonly pendingQuestions = new Map<string, { questionId: string; options: NormalizedOption[] }>();

  public constructor(private readonly config: BandConfig) {
    const wsUrl = wsUrlFromBaseUrl(config.baseUrl);
    const restUrl = restUrlFromWsUrl(wsUrl);
    this.link = new BandLink({
      agentId: config.agentId,
      apiKey: config.apiKey,
      wsUrl,
      restUrl,
      capabilities: { contacts: config.contactStrategy !== 'disabled' },
    });
    this.restClient = new ThenvoiClient({ apiKey: config.apiKey, baseUrl: restUrl });
  }

  public async setup(config: ChannelSetup): Promise<void> {
    this.setupConfig = config;
    this.stopController = new AbortController();

    await this.link.connect();
    await this.link.subscribeAgentRooms();
    await this.syncConversations();
    // Bootstrap the owner↔agent "Nano Hub" if sync didn't surface one.
    await this.ensureOwnerHub();

    this.connected = true;
    this.eventLoop = this.runEventLoop(this.stopController.signal);

    // The platform only pushes message_created over the websocket at insert
    // time — there is no replay. Anything sent while the host was down (or
    // before a room subscription completed) sits in the agent's inbox as
    // pending. Drain it now and keep draining periodically as a safety net
    // for reconnect windows.
    await this.drainAllRooms('startup');
    this.drainTimer = setInterval(() => {
      void this.drainAllRooms('interval');
    }, DRAIN_INTERVAL_MS);
  }

  public async teardown(): Promise<void> {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    this.stopController?.abort();
    try {
      await this.eventLoop;
    } catch (err) {
      log.warn('Band.ai event loop stopped with error', { err });
    }
    await this.link.disconnect();
    this.connected = false;
    this.setupConfig = null;
    this.stopController = null;
    this.eventLoop = null;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async deliver(
    platformId: string,
    _threadId: string | null,
    message: OutboundMessage,
  ): Promise<string | undefined> {
    const roomId = parseBandPlatformId(platformId);

    if (message.kind === 'chat') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : typeof (message.content as { text?: unknown }).text === 'string'
            ? (message.content as { text: string }).text
            : JSON.stringify(message.content);
      return this.sendTaggedMessage(roomId, text);
    }

    if (message.kind === 'chat-sdk') {
      const content =
        typeof message.content === 'string'
          ? (JSON.parse(message.content) as Record<string, unknown>)
          : (message.content as Record<string, unknown>);

      // Interactive question card (channel approvals, ask_user_question).
      // Rendered as text with slash-command replies, mirroring the WhatsApp
      // adapter; the reply is intercepted in handleMessageCreated.
      if (content.type === 'ask_question' && content.questionId && content.options) {
        const questionId = content.questionId as string;
        const title = content.title as string;
        if (!title) {
          log.error('Band.ai ask_question missing required title — skipping delivery', { questionId });
          return undefined;
        }
        const options = normalizeOptions(content.options as never);
        const optionLines = options.map((o) => `  ${optionToCommand(o.label)}`).join('\n');
        const text = `**${title}**\n\n${content.question ?? ''}\n\nReply with:\n${optionLines}`;
        const msgId = await this.sendTaggedMessage(roomId, text);
        if (msgId) {
          this.pendingQuestions.set(roomId, { questionId, options });
          if (this.pendingQuestions.size > PENDING_QUESTIONS_MAX) {
            const oldest = this.pendingQuestions.keys().next().value!;
            this.pendingQuestions.delete(oldest);
          }
        }
        return msgId;
      }

      // Plain chat-sdk text payloads fall through to a tagged message.
      if (typeof content.text === 'string') {
        return this.sendTaggedMessage(roomId, content.text);
      }

      log.warn('Band.ai dropping unsupported chat-sdk payload', { roomId, type: content.type ?? content.operation });
      return undefined;
    }

    log.warn('Band.ai dropping unsupported outbound kind', { roomId, kind: message.kind });
    return undefined;
  }

  /**
   * Send a message that tags the recipient. Band only notifies (and only
   * pushes to agents) messages whose metadata.mentions reference the
   * recipient — even in two-party direct rooms — so every host-side send
   * carries both the metadata mention and the inline `@[[id]]` tag.
   */
  private async sendTaggedMessage(roomId: string, text: string): Promise<string | undefined> {
    const mention = await this.getOwnerMention();
    const content = text.includes('@[[') ? text : `${inlineMention(mention.id)} ${text}`;
    const result = await this.restClient.agentApiMessages.createAgentChatMessage(roomId, {
      message: {
        content,
        mentions: [mention],
      },
    });

    const data = (result as { data?: { id?: unknown } }).data;
    return typeof data?.id === 'string' ? data.id : undefined;
  }

  private async getOwnerMention(): Promise<{ id: string; name?: string }> {
    if (this.ownerMention) return this.ownerMention;
    const response = await this.restClient.agentApiIdentity.getAgentMe();
    const data = (response as { data?: { owner_uuid?: unknown; ownerUuid?: unknown } }).data;
    const ownerId =
      typeof data?.owner_uuid === 'string'
        ? data.owner_uuid
        : typeof data?.ownerUuid === 'string'
          ? data.ownerUuid
          : null;
    if (!ownerId) throw new Error('Band.ai owner identity unavailable for fallback delivery');
    this.ownerMention = { id: ownerId, name: 'Owner' };
    return this.ownerMention;
  }

  private async fetchParticipants(roomId: string): Promise<unknown[] | null> {
    try {
      const response = await this.restClient.agentApiParticipants.listAgentChatParticipants(roomId);
      const data = (response as { data?: unknown }).data;
      return Array.isArray(data) ? data : null;
    } catch (err) {
      log.warn('Band.ai failed to fetch room participants', { roomId, err });
      return null;
    }
  }

  /**
   * The agent API's room objects carry no participant list, so owner↔agent
   * direct-room (main control room) detection can never fire from the room
   * shape alone. While no main room is known, enrich discovered rooms with
   * an explicit participants fetch; once a main room is set, skip the extra
   * call. Failure is non-fatal — the room is processed without participants.
   */
  private async withParticipants(roomId: string, room: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (getMainRoomState() || Array.isArray(room.participants)) return room;
    const participants = await this.fetchParticipants(roomId);
    return participants ? { ...room, participants } : room;
  }

  /** Create a room and add one participant; returns the room id or null. */
  private async createDirectRoomWith(participantId: string): Promise<string | null> {
    const response = await this.restClient.agentApiChats.createAgentChat({ chat: {} });
    const data = (response as { data?: { id?: unknown } }).data;
    const roomId = typeof data?.id === 'string' ? data.id : null;
    if (!roomId) {
      log.warn('Band.ai room creation returned no id');
      return null;
    }
    await this.restClient.agentApiParticipants.addAgentChatParticipant(roomId, {
      participant: { participant_id: participantId, role: 'member' },
    });
    return roomId;
  }

  /**
   * Resolve (or create) a direct room usable to DM the given Band user.
   * This is the resolution-required half of the host's two-class DM model
   * (see modules/permissions/user-dm.ts) — without it, ensureUserDm would
   * mint a messaging group whose platform_id is a raw user UUID, which is
   * not a room and can never be delivered to.
   */
  public async openDM(userHandle: string): Promise<string> {
    // Owner fast-path: the Nano Hub is the owner DM.
    const main = getMainRoomState();
    if (main) {
      const ownerId = await this.resolveOwnerId();
      if (ownerId === userHandle) return main.platformId;
    }

    // Reuse an existing two-party direct room with this user if one exists.
    const rooms = await this.link.listAllChats({ pageSize: 50 });
    for (const room of rooms) {
      const record = room as Record<string, unknown>;
      const roomId = typeof record.id === 'string' ? record.id : null;
      if (!roomId) continue;
      const participants = await this.fetchParticipants(roomId);
      if (!participants || participants.length !== 2) continue;
      const idSets = participants.map((participant) => new Set(collectParticipantIds(participant)));
      if (idSets.some((ids) => ids.has(this.config.agentId)) && idSets.some((ids) => ids.has(userHandle))) {
        return formatBandPlatformId(roomId);
      }
    }

    const roomId = await this.createDirectRoomWith(userHandle);
    if (!roomId) throw new Error('Band.ai openDM: room creation failed');
    await this.link.subscribeRoom(roomId);
    this.knownRoomIds.add(roomId);
    return formatBandPlatformId(roomId);
  }

  /**
   * Install-time bootstrap: ensure the owner↔agent "Nano Hub" room exists
   * and is registered as the main control room. Runs after the initial
   * room sync, so an existing owner↔agent direct room (detected via the
   * participants fetch) wins and nothing is created. Idempotent — no-ops
   * whenever a main room is already known.
   *
   * Note: the agent API cannot set a room title, so on the platform the
   * room keeps its default name until the owner renames it; locally the
   * messaging group is named "Nano Hub".
   */
  private async ensureOwnerHub(): Promise<void> {
    if (getMainRoomState()) return;
    const ownerId = await this.resolveOwnerId();
    if (!ownerId) {
      log.warn('Band.ai owner hub skipped — owner identity unavailable');
      return;
    }
    try {
      const roomId = await this.createDirectRoomWith(ownerId);
      if (!roomId) return;
      try {
        await this.link.subscribeRoom(roomId);
      } catch (err) {
        log.warn('Band.ai failed to subscribe to new owner hub', { err, roomId });
      }
      this.knownRoomIds.add(roomId);
      upsertDiscoveredMessagingGroup(roomId, { id: roomId, type: 'direct' }, this.config, true);
      this.wireOwnerHub(roomId);
      this.setupConfig?.onMetadata(formatBandPlatformId(roomId), MAIN_ROOM_NAME, false);
      log.info('Band.ai owner hub created and set as main room', { roomId, ownerId });
    } catch (err) {
      log.error('Band.ai failed to bootstrap owner hub', { err });
    }
  }

  /**
   * Wire the owner hub to the agent group when the choice is unambiguous.
   * With zero or multiple agent groups, leave wiring to /manage-channels.
   */
  private wireOwnerHub(roomId: string): void {
    const agentGroups = getAllAgentGroups();
    if (agentGroups.length !== 1) {
      log.warn('Band.ai owner hub left unwired — wire it via /manage-channels', {
        agentGroupCount: agentGroups.length,
      });
      return;
    }
    const mg = getMessagingGroupByPlatform(BAND_CHANNEL_TYPE, formatBandPlatformId(roomId));
    if (!mg) return;
    if (getMessagingGroupAgentByPair(mg.id, agentGroups[0].id)) return;
    createMessagingGroupAgent({
      id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messaging_group_id: mg.id,
      agent_group_id: agentGroups[0].id,
      // The platform only pushes agent-mentioning messages to agents, so
      // every message that reaches us here is effectively a mention.
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    log.info('Band.ai owner hub wired', { messagingGroupId: mg.id, agentGroupId: agentGroups[0].id });
  }

  public async syncConversations(): Promise<ConversationInfo[]> {
    const rooms = await this.link.listAllChats({ pageSize: 50 });
    const conversations: ConversationInfo[] = [];

    const seenRoomIds = new Set<string>();
    for (const room of rooms) {
      const roomRecord = room as Record<string, unknown>;
      const roomId = typeof roomRecord.id === 'string' ? roomRecord.id : undefined;
      if (!roomId) continue;
      seenRoomIds.add(roomId);
      this.knownRoomIds.add(roomId);

      await this.link.subscribeRoom(roomId);
      upsertDiscoveredMessagingGroup(
        roomId,
        await this.withParticipants(roomId, roomRecord),
        this.config,
        getMainRoomState()?.roomId === roomId,
      );
      const main = getMainRoomState()?.roomId === roomId;
      const title = main ? MAIN_ROOM_NAME : typeof roomRecord.title === 'string' ? roomRecord.title : undefined;
      const isGroup = main ? false : roomRecord.type !== 'direct';
      const platformId = formatBandPlatformId(roomId);
      conversations.push({ platformId, name: title ?? roomId, isGroup });
      this.setupConfig?.onMetadata(platformId, title, isGroup);
    }

    const state = getMainRoomState();
    if (state && !seenRoomIds.has(state.roomId)) {
      clearMainRoomIfMatches(state.roomId);
      closeSessionsForRoom(state.roomId, 'main_room_missing_during_sync');
    }

    return conversations;
  }

  public get agentId(): string {
    return this.config.agentId;
  }

  private async runEventLoop(signal: AbortSignal): Promise<void> {
    void this.link.runForever(signal).catch((err) => {
      if (!signal.aborted) log.warn('Band.ai websocket loop stopped', { err });
    });

    const iterator = this.link[Symbol.asyncIterator]();
    while (!signal.aborted) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<PlatformEvent>>((resolve) => {
          signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true });
        }),
      ]);
      if (next.done || signal.aborted) return;
      await this.handleEvent(next.value);
    }
  }

  private async handleEvent(event: PlatformEvent): Promise<void> {
    switch (event.type) {
      case 'room_added':
        await this.handleRoomAdded(event.roomId, event.payload);
        break;
      case 'room_removed':
      case 'room_deleted':
      case 'participant_removed':
        this.handleRoomInvalidated(event.roomId, event.payload, event.type);
        break;
      case 'participant_added':
        this.handleParticipantAdded(event.roomId, event.payload);
        await this.maybeInjectParticipantMemories(event.roomId, event.payload);
        break;
      case 'message_created':
        await this.handleMessageCreated(event.roomId, event.payload);
        break;
      case 'contact_request_received':
      case 'contact_request_updated':
      case 'contact_added':
      case 'contact_removed':
        await this.handleContactEvent(event);
        break;
      default:
        break;
    }
  }

  private async handleRoomAdded(roomId: string | null, payload: Record<string, unknown>): Promise<void> {
    const id = roomId ?? (typeof payload.id === 'string' ? payload.id : null);
    if (!id) return;
    await this.link.subscribeRoom(id);
    this.knownRoomIds.add(id);
    upsertDiscoveredMessagingGroup(
      id,
      await this.withParticipants(id, payload),
      this.config,
      getMainRoomState()?.roomId === id,
    );
    const main = getMainRoomState()?.roomId === id;
    const title = main ? MAIN_ROOM_NAME : typeof payload.title === 'string' ? payload.title : undefined;
    const isGroup = main ? false : payload.type !== 'direct';
    this.setupConfig?.onMetadata(formatBandPlatformId(id), title, isGroup);
    // A room's first message is often inserted before our subscription lands,
    // so its message_created push never reaches us. Pull it from the inbox.
    await this.drainPendingMessages(id);
  }

  private handleRoomInvalidated(roomId: string | null, payload: Record<string, unknown>, reason: string): void {
    const id =
      roomId ??
      (typeof payload.id === 'string'
        ? payload.id
        : typeof payload.chat_room_id === 'string'
          ? payload.chat_room_id
          : null);
    if (!id) return;
    this.knownRoomIds.delete(id);
    closeSessionsForRoom(id, reason);
    clearMainRoomIfMatches(id);
  }

  private handleParticipantAdded(roomId: string | null, payload: Record<string, unknown>): void {
    const id = roomId ?? (typeof payload.chat_room_id === 'string' ? payload.chat_room_id : null);
    if (!id) return;

    // participant_added payloads describe only the participant that joined, not the
    // full room. Do not upsert room metadata from that partial shape.
    if (getMainRoomState()?.roomId === id) {
      clearMainRoomIfMatches(id);
      closeSessionsForRoom(id, 'main_room_participant_added');
    }
  }

  /**
   * When a new participant joins a Band room, fetch up to 10 of their stored
   * memories and inject them into the room as a synthetic system message so
   * the next agent turn has context. No-op unless `BAND_MEMORY_LOAD_ON_START`
   * is enabled and the room is wired (i.e. has a messaging_group row).
   *
   * Failure is non-fatal — the room still functions without preloaded memory.
   */
  private async maybeInjectParticipantMemories(roomId: string | null, payload: Record<string, unknown>): Promise<void> {
    if (!this.config.memoryLoadOnStart || !this.setupConfig) return;
    const resolvedRoomId = roomId ?? (typeof payload.chat_room_id === 'string' ? payload.chat_room_id : null);
    if (!resolvedRoomId) return;

    const platformId = formatBandPlatformId(resolvedRoomId);
    if (!getMessagingGroupByPlatform(BAND_CHANNEL_TYPE, platformId)) return;

    const participantId = typeof payload.id === 'string' ? payload.id : null;
    const participantName = typeof payload.name === 'string' ? payload.name : 'Someone';
    if (!participantId) return;

    try {
      const response = await this.restClient.agentApiMemories.listAgentMemories({
        subject_id: participantId,
        scope: 'subject',
      });
      const data = (response as { data?: { data?: Array<{ type?: string; content?: string }> } }).data;
      const items = (data?.data ?? []).slice(0, 10);
      if (items.length === 0) return;

      const memoryLines = items.map((m) => `- [${m.type ?? 'memory'}] ${m.content ?? ''}`).join('\n');
      const text = `[System]: ${participantName} joined the room. Here's what you know about them:\n${memoryLines}`;

      const syntheticId = `participant-join-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const messageContent: BandMessageContent = {
        text,
        sender: 'system',
        senderId: 'system',
        senderName: 'System',
        senderType: 'System',
        roomId: resolvedRoomId,
        metadata: { participantJoinedId: participantId, participantJoinedName: participantName },
      };

      await this.setupConfig.onInbound(platformId, null, {
        id: syntheticId,
        kind: 'chat',
        content: messageContent,
        timestamp: now(),
        isMention: true,
        isGroup: true,
      });
      log.info('Band.ai injected participant memories', {
        roomId: resolvedRoomId,
        participantId,
        memoryCount: items.length,
      });
    } catch (err) {
      log.warn('Band.ai failed to inject participant memories', {
        err,
        roomId: resolvedRoomId,
        participantId,
      });
    }
  }

  private async handleMessageCreated(
    roomId: string | null,
    payload: {
      id: string;
      content: string;
      message_type: string;
      sender_id: string;
      sender_type: string;
      sender_name?: string | null;
      chat_room_id?: string | null;
      inserted_at: string;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    if (!this.setupConfig) return;

    const resolvedRoomId = roomId ?? payload.chat_room_id;
    if (!resolvedRoomId) return;

    // Messages we never hand to the agent — the agent's own echoes and
    // non-text payloads — must still be consumed, or the inbox drain
    // re-fetches them on every pass and head-of-line-blocks every later
    // message in the room (see markRoomMessageConsumed).
    if (payload.sender_id === this.config.agentId || payload.message_type !== 'text') {
      await this.markRoomMessageConsumed(resolvedRoomId, payload.id);
      return;
    }

    const platformId = formatBandPlatformId(resolvedRoomId);

    // Pending question reply (/approve, /deny, …) — resolve the question
    // instead of forwarding to the agent. Band content embeds inline
    // mention markup, so strip it before matching the slash command.
    const pending = this.pendingQuestions.get(resolvedRoomId);
    if (pending) {
      const cmd = stripInlineMentions(payload.content).trim().toLowerCase();
      if (cmd.startsWith('/')) {
        const matched = pending.options.find((o) => optionToCommand(o.label) === cmd);
        if (matched) {
          this.setupConfig.onAction(pending.questionId, matched.value, payload.sender_id);
          this.pendingQuestions.delete(resolvedRoomId);
          try {
            await this.sendTaggedMessage(resolvedRoomId, matched.selectedLabel);
            await this.link.markProcessing(resolvedRoomId, payload.id);
            await this.link.markProcessed(resolvedRoomId, payload.id);
          } catch (err) {
            log.warn('Band.ai failed to acknowledge question reply', {
              roomId: resolvedRoomId,
              messageId: payload.id,
              err,
            });
          }
          log.info('Band.ai question answered', { questionId: pending.questionId, value: matched.value });
          return; // Don't forward this reply to the agent
        }
      }
    }

    upsertDiscoveredMessagingGroup(
      resolvedRoomId,
      { id: resolvedRoomId, title: resolvedRoomId, type: 'group' },
      this.config,
      getMainRoomState()?.roomId === resolvedRoomId,
    );
    const content: BandMessageContent = {
      text: payload.content,
      sender: payload.sender_id,
      senderId: payload.sender_id,
      senderName: payload.sender_name ?? null,
      senderType: payload.sender_type,
      roomId: resolvedRoomId,
      metadata: payload.metadata ?? undefined,
    };

    const result = await this.setupConfig.onInbound(platformId, null, {
      id: payload.id,
      kind: 'chat',
      content,
      timestamp: payload.inserted_at,
      isMention: metadataMentionsAgent(payload.metadata, this.config.agentId),
    });

    // Forward progress is mandatory: the inbox drain is a FIFO cursor that
    // only advances when the head message is marked processed. The one
    // outcome worth re-feeding is a transient routing failure (onInbound
    // caught an exception and returned status:'failed') — leave that pending
    // so the next drain retries it. Every other outcome is terminal: routed,
    // or a deterministic drop that an identical re-feed would only reproduce.
    // Consume it. Leaving a deterministically-dropped message at the head of
    // the queue is exactly what silently kills a whole room.
    if (result?.status === 'failed' && result.retryable) return;

    await this.markRoomMessageConsumed(resolvedRoomId, payload.id);

    // Host dedup ledger: only a routed message becomes 'processed'. Drops keep
    // the status routeInbound assigned (e.g. 'retrying' while a channel awaits
    // owner approval) so the approval gate's host-side replay re-routes the
    // original event instead of short-circuiting on a 'processed' row.
    if (result?.status === 'persisted') {
      markInboundDeliveryProcessed({
        channelType: BAND_CHANNEL_TYPE,
        platformId,
        platformMessageId: payload.id,
      });
    }
  }

  /**
   * Advance the platform inbox cursor past a message we are finished with.
   * getNextMessage returns the oldest *unprocessed* message and only moves on
   * once that message is marked processed — so every terminal disposition
   * (routed, deliberately ignored, or dropped) has to be marked here. A
   * message left unmarked sits at the head of the queue and the periodic drain
   * re-fetches it forever, head-of-line-blocking every later message in the
   * room. Best-effort: a failed mark just means the next drain retries it.
   */
  private async markRoomMessageConsumed(roomId: string, messageId: string): Promise<void> {
    try {
      await this.link.markProcessing(roomId, messageId);
      await this.link.markProcessed(roomId, messageId);
    } catch (err) {
      log.warn('Band.ai failed to mark message processed', { roomId, messageId, err });
    }
  }

  /**
   * Pull pending (unprocessed) messages for a room from the platform inbox
   * and feed them through the same path as live websocket events. The router
   * dedups on platform message id, so a message that raced in via websocket
   * is a no-op here. The loop only advances when a message gets marked
   * processed; a message that fails routing stays pending for the next drain.
   */
  private async drainPendingMessages(roomId: string): Promise<void> {
    let lastMessageId: string | null = null;
    for (let i = 0; i < MAX_DRAIN_PER_ROOM; i++) {
      let message;
      try {
        message = await this.link.getNextMessage(roomId);
      } catch (err) {
        log.warn('Band.ai failed to fetch pending message', { roomId, err });
        return;
      }
      if (!message) return;
      if (message.id === lastMessageId) {
        // Not marked processed (routing failed or dropped unaudited) — leave
        // it pending rather than spin; the next drain pass retries it.
        return;
      }
      lastMessageId = message.id;
      log.info('Band.ai draining pending message', { roomId, messageId: message.id });
      await this.handleMessageCreated(roomId, {
        id: message.id,
        content: message.content,
        message_type: message.messageType,
        sender_id: message.senderId,
        sender_type: message.senderType,
        sender_name: message.senderName,
        chat_room_id: roomId,
        inserted_at: message.createdAt.toISOString(),
        metadata: message.metadata as Record<string, unknown>,
      });
    }
    log.warn('Band.ai drain hit per-room cap; more pending messages remain', { roomId, cap: MAX_DRAIN_PER_ROOM });
  }

  private async drainAllRooms(reason: string): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const roomId of this.knownRoomIds) {
        if (this.stopController?.signal.aborted) return;
        await this.drainPendingMessages(roomId);
      }
    } catch (err) {
      log.warn('Band.ai inbox drain failed', { err, reason });
    } finally {
      this.draining = false;
    }
  }

  private dedupContactEvent(event: PlatformEvent): boolean {
    const payload = event.payload as { id?: unknown; status?: unknown } | undefined;
    const id = typeof payload?.id === 'string' ? payload.id : 'unknown';
    const status = typeof payload?.status === 'string' ? `:${payload.status}` : '';
    const key = `${event.type}:${id}${status}`;
    if (this.contactDedup.has(key)) return false;
    this.contactDedup.add(key);
    this.contactDedupOrder.push(key);
    while (this.contactDedup.size > MAX_CONTACT_DEDUP) {
      const oldest = this.contactDedupOrder.shift();
      if (oldest) this.contactDedup.delete(oldest);
    }
    return true;
  }

  private async handleContactEvent(event: PlatformEvent): Promise<void> {
    if (
      event.type !== 'contact_request_received' &&
      event.type !== 'contact_request_updated' &&
      event.type !== 'contact_added' &&
      event.type !== 'contact_removed'
    ) {
      return;
    }
    if (!this.dedupContactEvent(event)) return;

    const strategy = this.config.contactStrategy;
    if (strategy === 'disabled') return;

    if (strategy === 'hub_room') {
      await this.handleContactHubRoom(event);
    }
  }

  private async handleContactHubRoom(event: PlatformEvent): Promise<void> {
    if (!this.setupConfig) return;
    const roomId = await this.ensureHubRoom();
    if (!roomId) {
      log.warn('Band.ai hub room unavailable; dropping contact event', { type: event.type });
      return;
    }
    const platformId = formatBandPlatformId(roomId);
    const content = formatContactEvent(event);

    const syntheticId = `contact-evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const messageContent: BandMessageContent = {
      text: content,
      sender: SYNTHETIC_CONTACT_SENDER_ID,
      senderId: SYNTHETIC_CONTACT_SENDER_ID,
      senderName: SYNTHETIC_CONTACT_SENDER_NAME,
      senderType: 'System',
      roomId,
      metadata: { contactEventType: event.type, contactPayload: event.payload },
    };

    try {
      await this.setupConfig.onInbound(platformId, null, {
        id: syntheticId,
        kind: 'chat',
        content: messageContent,
        timestamp: now(),
        isMention: true,
        isGroup: true,
      });
    } catch (err) {
      log.warn('Band.ai failed to inject contact event into hub room', { err, type: event.type });
    }

    try {
      await this.restClient.agentApiEvents.createAgentChatEvent(roomId, {
        event: {
          content,
          message_type: 'task',
          metadata: { contactEventType: event.type },
        },
      });
    } catch (err) {
      log.warn('Band.ai failed to persist contact event to platform', { err, roomId });
    }
  }

  private resolveHubAgentGroupId(): string | null {
    if (this.config.contactAgentGroupId) {
      if (getAgentGroup(this.config.contactAgentGroupId)) return this.config.contactAgentGroupId;
      log.warn('Band.ai contact hub agent group not found; hub messages will not wake an agent', {
        agentGroupId: this.config.contactAgentGroupId,
      });
      return null;
    }

    const agentGroups = getAllAgentGroups();
    if (agentGroups.length === 1) return agentGroups[0].id;
    log.warn('Band.ai contact hub has no unambiguous agent group; set BAND_CONTACT_AGENT_GROUP_ID', {
      agentGroupCount: agentGroups.length,
    });
    return null;
  }

  private async ensureHubRoom(): Promise<string | null> {
    const persisted = getHubRoomState();
    if (persisted) {
      ensureHubMessagingGroup(persisted.roomId, this.resolveHubAgentGroupId());
      return persisted.roomId;
    }
    if (this.hubRoomInitPromise) return this.hubRoomInitPromise;

    this.hubRoomInitPromise = (async () => {
      try {
        const response = await this.restClient.agentApiChats.createAgentChat({ chat: {} });
        const data = (response as { data?: { id?: unknown } }).data;
        const newRoomId = typeof data?.id === 'string' ? data.id : null;
        if (!newRoomId) {
          log.warn('Band.ai hub room creation returned no id');
          return null;
        }

        const ownerId = await this.resolveOwnerId();
        if (ownerId) {
          try {
            await this.restClient.agentApiParticipants.addAgentChatParticipant(newRoomId, {
              participant: { participant_id: ownerId, role: 'member' },
            });
          } catch (err) {
            log.warn('Band.ai failed to add owner to hub room', { err, ownerId, roomId: newRoomId });
          }
        } else {
          log.warn('Band.ai hub room created without owner; owner will not see it');
        }

        setHubRoom(newRoomId);
        ensureHubMessagingGroup(newRoomId, this.resolveHubAgentGroupId());
        try {
          await this.link.subscribeRoom(newRoomId);
        } catch (err) {
          log.warn('Band.ai failed to subscribe to new hub room', { err, roomId: newRoomId });
        }
        log.info('Band.ai contact hub room created', { roomId: newRoomId });
        return newRoomId;
      } catch (err) {
        log.error('Band.ai failed to create hub room', { err });
        return null;
      }
    })();

    try {
      return await this.hubRoomInitPromise;
    } finally {
      this.hubRoomInitPromise = null;
    }
  }

  private async resolveOwnerId(): Promise<string | null> {
    if (this.config.ownerId) return this.config.ownerId;
    try {
      const response = await this.restClient.agentApiIdentity.getAgentMe();
      const data = (response as { data?: { owner_uuid?: unknown; ownerUuid?: unknown } }).data;
      if (typeof data?.owner_uuid === 'string') return data.owner_uuid;
      if (typeof data?.ownerUuid === 'string') return data.ownerUuid;
    } catch (err) {
      log.warn('Band.ai failed to resolve owner UUID', { err });
    }
    return null;
  }
}

function formatContactEvent(event: PlatformEvent): string {
  switch (event.type) {
    case 'contact_request_received': {
      const p = event.payload as { id: string; from_name: string; from_handle: string; message?: string | null };
      const msg = p.message ? `\nMessage: "${p.message}"` : '';
      return `[Contact Request] ${p.from_name} (@${p.from_handle}) wants to connect.${msg}\nRequest ID: ${p.id}`;
    }
    case 'contact_request_updated': {
      const p = event.payload as { id: string; status: string };
      return `[Contact Update] Request ${p.id} status changed to: ${p.status}`;
    }
    case 'contact_added': {
      const p = event.payload as { id: string; name: string; handle: string; type: string };
      return `[Contact Added] ${p.name} (@${p.handle}), type: ${p.type}. ID: ${p.id}`;
    }
    case 'contact_removed': {
      const p = event.payload as { id: string };
      return `[Contact Removed] Contact ${p.id} was removed.`;
    }
    default:
      return `[Contact Event] ${(event as { type: string }).type}`;
  }
}

registerChannelContainerConfig(BAND_CHANNEL_TYPE, ({ messagingGroup, hostEnv }) => {
  const config = getBandConfig();
  if (!config || !messagingGroup) return {};

  // BAND_* is canonical. Each var is mirrored under the legacy THENVOI_* name
  // so container images built before the product rename keep working until
  // the next image rebuild.
  const bandEnv: Record<string, string> = {
    BAND_ROOM_ID: parseBandPlatformId(messagingGroup.platform_id),
    BAND_AGENT_ID: config.agentId,
    BAND_REST_URL: containerReachableRestUrl(config.baseUrl),
    BAND_MEMORY_TOOLS: String(config.memoryTools),
    BAND_MEMORY_LOAD_ON_START: String(config.memoryLoadOnStart),
    BAND_MEMORY_CONSOLIDATION: String(config.memoryConsolidation),
    BAND_CONTACT_STRATEGY: config.contactStrategy,
    BAND_IS_MAIN_CONTROL_ROOM: String(isMainRoomPlatformId(messagingGroup.platform_id)),
  };

  if (config.ownerId) {
    bandEnv.BAND_OWNER_ID = config.ownerId;
  }

  if (
    shouldInjectDirectApiKey(config.baseUrl) ||
    hostEnv.BAND_INJECT_API_KEY === 'true' ||
    hostEnv.THENVOI_INJECT_API_KEY === 'true'
  ) {
    bandEnv.BAND_API_KEY = config.apiKey;
  }

  const env: Record<string, string> = { NANOCLAW_CHANNEL: BAND_CHANNEL_TYPE };
  for (const [key, value] of Object.entries(bandEnv)) {
    env[key] = value;
    env[key.replace(/^BAND_/, 'THENVOI_')] = value;
  }

  return { env };
});

registerChannelAdapter('band', {
  factory: () => {
    const config = getBandConfig();
    if (!config) return null;
    return new BandChannelAdapter(config);
  },
});
