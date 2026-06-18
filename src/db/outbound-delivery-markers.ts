import { getDb } from './connection.js';

export interface OutboundDeliveryMarker {
  marker_key: string;
  session_id: string;
  outbound_message_id: string | null;
  channel_type: string;
  platform_id: string;
  tool_call_id: string | null;
  platform_message_id: string | null;
  delivered_at: string;
}

function markerKey(marker: {
  sessionId: string;
  outboundMessageId: string | null;
  channelType: string;
  platformId: string;
  toolCallId?: string | null;
}): string {
  return [
    marker.sessionId,
    marker.outboundMessageId ?? `tool:${marker.toolCallId ?? 'unknown'}`,
    marker.channelType,
    marker.platformId,
  ].join('|');
}

export function recordOutboundDeliveryMarker(marker: {
  sessionId: string;
  outboundMessageId: string | null;
  channelType: string;
  platformId: string;
  toolCallId?: string | null;
  platformMessageId?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO outbound_delivery_markers (
         marker_key, session_id, outbound_message_id, channel_type, platform_id,
         tool_call_id, platform_message_id, delivered_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(marker_key) DO UPDATE SET
         tool_call_id = COALESCE(excluded.tool_call_id, outbound_delivery_markers.tool_call_id),
         platform_message_id = COALESCE(excluded.platform_message_id, outbound_delivery_markers.platform_message_id),
         delivered_at = excluded.delivered_at`,
    )
    .run(
      markerKey(marker),
      marker.sessionId,
      marker.outboundMessageId,
      marker.channelType,
      marker.platformId,
      marker.toolCallId ?? null,
      marker.platformMessageId ?? null,
      new Date().toISOString(),
    );
}

export function getOutboundDeliveryMarker(
  sessionId: string,
  outboundMessageId: string,
  channelType: string,
  platformId: string,
): OutboundDeliveryMarker | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM outbound_delivery_markers
       WHERE session_id = ?
         AND outbound_message_id = ?
         AND channel_type = ?
         AND platform_id = ?`,
    )
    .get(sessionId, outboundMessageId, channelType, platformId) as OutboundDeliveryMarker | undefined;
}
