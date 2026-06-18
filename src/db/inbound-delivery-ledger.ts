import { getDb } from './connection.js';

export type InboundDeliveryStatus =
  | 'received'
  | 'persisted'
  | 'processed'
  | 'retrying'
  | 'dead_lettered'
  | 'intentionally_dropped'
  | 'terminal_failed';

export interface InboundDeliveryKey {
  channelType: string;
  platformId: string;
  platformMessageId: string;
}

export interface InboundDeliveryRow {
  channel_type: string;
  platform_id: string;
  platform_message_id: string;
  thread_id: string | null;
  status: InboundDeliveryStatus;
  reason: string | null;
  retryable: number;
  retry_count: number;
  next_retry_at: string | null;
  session_ids_json: string | null;
  session_message_ids_json: string | null;
  first_seen: string;
  last_seen: string;
  processed_at: string | null;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function params(key: InboundDeliveryKey): Record<string, string> {
  return {
    channel_type: key.channelType,
    platform_id: key.platformId,
    platform_message_id: key.platformMessageId,
  };
}

export function getInboundDelivery(key: InboundDeliveryKey): InboundDeliveryRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM inbound_delivery_ledger
       WHERE channel_type = @channel_type
         AND platform_id = @platform_id
         AND platform_message_id = @platform_message_id`,
    )
    .get(params(key)) as InboundDeliveryRow | undefined;
}

export function beginInboundDelivery(key: InboundDeliveryKey, threadId: string | null): InboundDeliveryRow {
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO inbound_delivery_ledger (
         channel_type, platform_id, platform_message_id, thread_id, status,
         retryable, retry_count, first_seen, last_seen, updated_at
       ) VALUES (
         @channel_type, @platform_id, @platform_message_id, @thread_id, 'received',
         0, 0, @now, @now, @now
       )
       ON CONFLICT(channel_type, platform_id, platform_message_id) DO UPDATE SET
         thread_id = COALESCE(excluded.thread_id, inbound_delivery_ledger.thread_id),
         last_seen = excluded.last_seen,
         retry_count = CASE
           WHEN inbound_delivery_ledger.status IN ('persisted', 'processed', 'intentionally_dropped')
             THEN inbound_delivery_ledger.retry_count
           ELSE inbound_delivery_ledger.retry_count + 1
         END,
         updated_at = excluded.updated_at`,
    )
    .run({ ...params(key), thread_id: threadId, now: ts });

  return getInboundDelivery(key)!;
}

export function markInboundDeliveryPersisted(
  key: InboundDeliveryKey,
  routed: { sessionIds: string[]; sessionMessageIds: string[] },
): InboundDeliveryRow {
  const ts = now();
  getDb()
    .prepare(
      `UPDATE inbound_delivery_ledger SET
         status = 'persisted',
         reason = NULL,
         retryable = 0,
         next_retry_at = NULL,
         session_ids_json = @session_ids_json,
         session_message_ids_json = @session_message_ids_json,
         last_seen = @now,
         updated_at = @now
       WHERE channel_type = @channel_type
         AND platform_id = @platform_id
         AND platform_message_id = @platform_message_id`,
    )
    .run({
      ...params(key),
      session_ids_json: JSON.stringify(routed.sessionIds),
      session_message_ids_json: JSON.stringify(routed.sessionMessageIds),
      now: ts,
    });

  return getInboundDelivery(key)!;
}

export function markInboundDeliveryDropped(
  key: InboundDeliveryKey,
  drop: { reason: string; intentional: boolean; retryable?: boolean },
): InboundDeliveryRow {
  const ts = now();
  const status: InboundDeliveryStatus = drop.intentional
    ? 'intentionally_dropped'
    : drop.retryable
      ? 'retrying'
      : 'dead_lettered';
  getDb()
    .prepare(
      `UPDATE inbound_delivery_ledger SET
         status = @status,
         reason = @reason,
         retryable = @retryable,
         last_seen = @now,
         updated_at = @now
       WHERE channel_type = @channel_type
         AND platform_id = @platform_id
         AND platform_message_id = @platform_message_id`,
    )
    .run({
      ...params(key),
      status,
      reason: drop.reason,
      retryable: drop.retryable ? 1 : 0,
      now: ts,
    });

  return getInboundDelivery(key)!;
}

export function markInboundDeliveryFailed(
  key: InboundDeliveryKey,
  failure: { reason: string; retryable: boolean; nextRetryAt?: string | null },
): InboundDeliveryRow {
  const ts = now();
  getDb()
    .prepare(
      `UPDATE inbound_delivery_ledger SET
         status = @status,
         reason = @reason,
         retryable = @retryable,
         next_retry_at = @next_retry_at,
         last_seen = @now,
         updated_at = @now
       WHERE channel_type = @channel_type
         AND platform_id = @platform_id
         AND platform_message_id = @platform_message_id`,
    )
    .run({
      ...params(key),
      status: failure.retryable ? 'retrying' : 'terminal_failed',
      reason: failure.reason,
      retryable: failure.retryable ? 1 : 0,
      next_retry_at: failure.nextRetryAt ?? null,
      now: ts,
    });

  return getInboundDelivery(key)!;
}

export function markInboundDeliveryProcessed(key: InboundDeliveryKey): InboundDeliveryRow {
  const ts = now();
  getDb()
    .prepare(
      `UPDATE inbound_delivery_ledger SET
         status = 'processed',
         processed_at = @now,
         last_seen = @now,
         updated_at = @now
       WHERE channel_type = @channel_type
         AND platform_id = @platform_id
         AND platform_message_id = @platform_message_id`,
    )
    .run({ ...params(key), now: ts });

  return getInboundDelivery(key)!;
}

export function canPlatformProcessFromLedger(row: InboundDeliveryRow | undefined): boolean {
  return row?.status === 'persisted' || row?.status === 'processed' || row?.status === 'intentionally_dropped';
}
