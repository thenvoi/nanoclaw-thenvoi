import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'route-foundation-state',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_delivery_ledger (
        channel_type        TEXT NOT NULL,
        platform_id         TEXT NOT NULL,
        platform_message_id TEXT NOT NULL,
        thread_id           TEXT,
        status              TEXT NOT NULL,
                            -- received | persisted | processed | retrying | dead_lettered | intentionally_dropped | terminal_failed
        reason              TEXT,
        retryable           INTEGER NOT NULL DEFAULT 0,
        retry_count         INTEGER NOT NULL DEFAULT 0,
        next_retry_at       TEXT,
        session_ids_json    TEXT,
        session_message_ids_json TEXT,
        first_seen          TEXT NOT NULL,
        last_seen           TEXT NOT NULL,
        processed_at        TEXT,
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (channel_type, platform_id, platform_message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_inbound_delivery_status
        ON inbound_delivery_ledger(status, next_retry_at);

      CREATE INDEX IF NOT EXISTS idx_inbound_delivery_last_seen
        ON inbound_delivery_ledger(last_seen);

      CREATE TABLE IF NOT EXISTS outbound_delivery_markers (
        marker_key          TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        outbound_message_id TEXT,
        channel_type        TEXT NOT NULL,
        platform_id         TEXT NOT NULL,
        tool_call_id        TEXT,
        platform_message_id TEXT,
        delivered_at        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outbound_delivery_markers_outbound
        ON outbound_delivery_markers(session_id, outbound_message_id, channel_type, platform_id);

      CREATE INDEX IF NOT EXISTS idx_outbound_delivery_markers_tool_call
        ON outbound_delivery_markers(tool_call_id);

      CREATE TABLE IF NOT EXISTS module_state (
        module_name TEXT NOT NULL,
        key         TEXT NOT NULL,
        value_json  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (module_name, key)
      );
    `);
  },
};
