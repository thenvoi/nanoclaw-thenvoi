import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Product rename: Thenvoi → Band (domain app.band.ai).
 *
 * Rewrites every persisted wire identifier:
 *   - channel_type 'thenvoi' → 'band'
 *   - platform_id / user id prefix 'thenvoi:' → 'band:'
 *   - module_state module 'thenvoi' → 'band' (+ platformId strings in JSON)
 *
 * Pending approval rows for the renamed channel are deleted rather than
 * rewritten: their serialized InboundEvent JSON embeds the old identifiers
 * and the cards were never deliverable anyway. The originating platform
 * messages still sit unprocessed in the Band inbox, so the adapter's drain
 * re-routes them after restart and fresh approvals get created as needed.
 *
 * Active sessions for Band messaging groups are closed: their per-session
 * session_routing/destinations rows (separate SQLite files) still say
 * 'thenvoi', and closing forces fresh sessions with 'band' routing on the
 * next inbound message.
 */
export const migration015: Migration = {
  version: 15,
  name: 'band-rename',
  up: (db: Database.Database) => {
    // users.id is a referenced PK; defer FK checks to commit so parent and
    // children can be rewritten in any order within this transaction.
    db.pragma('defer_foreign_keys = ON');

    const OLD = 'thenvoi';
    const NEW = 'band';
    const OLD_PREFIX = 'thenvoi:';
    const NEW_PREFIX = 'band:';
    // substr() start index just past the old prefix (1-based, prefix length + 1)
    const AFTER_OLD_PREFIX = OLD_PREFIX.length + 1;

    // Close active sessions for the renamed channel before touching
    // messaging_groups (the predicate still uses the old channel_type).
    db.prepare(
      `UPDATE sessions SET status = 'closed', container_status = 'stopped', last_active = ?
       WHERE status = 'active'
         AND messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type = ?)`,
    ).run(new Date().toISOString(), OLD);

    // Stale pending approvals (see doc comment).
    db.prepare(
      `DELETE FROM pending_sender_approvals
       WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type = ?)`,
    ).run(OLD);
    db.prepare(
      `DELETE FROM pending_channel_approvals
       WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type = ?)`,
    ).run(OLD);

    const prefixRewrite = (table: string, column: string, where = ''): void => {
      db.prepare(
        `UPDATE ${table} SET ${column} = ? || substr(${column}, ?)
         WHERE ${column} LIKE ? ${where}`,
      ).run(NEW_PREFIX, AFTER_OLD_PREFIX, `${OLD_PREFIX}%`);
    };
    const valueRewrite = (table: string, column: string): void => {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(NEW, OLD);
    };

    // Namespaced user ids ('thenvoi:<handle>') — parent first for clarity;
    // FK checks are deferred so order is not load-bearing.
    prefixRewrite('users', 'id');
    prefixRewrite('user_roles', 'user_id');
    prefixRewrite('user_roles', 'granted_by');
    prefixRewrite('agent_group_members', 'user_id');
    prefixRewrite('agent_group_members', 'added_by');
    prefixRewrite('user_dms', 'user_id');
    valueRewrite('user_dms', 'channel_type');

    // Channel wiring + per-message audit state.
    prefixRewrite('messaging_groups', 'platform_id');
    valueRewrite('messaging_groups', 'channel_type');
    prefixRewrite('pending_questions', 'platform_id');
    valueRewrite('pending_questions', 'channel_type');
    prefixRewrite('inbound_delivery_ledger', 'platform_id');
    valueRewrite('inbound_delivery_ledger', 'channel_type');
    prefixRewrite('unregistered_senders', 'platform_id');
    prefixRewrite('unregistered_senders', 'user_id');
    valueRewrite('unregistered_senders', 'channel_type');
    prefixRewrite('pending_approvals', 'platform_id');
    valueRewrite('pending_approvals', 'channel_type');

    // Outbound markers embed channel/platform in marker_key ('|thenvoi|...').
    prefixRewrite('outbound_delivery_markers', 'platform_id');
    valueRewrite('outbound_delivery_markers', 'channel_type');
    db.prepare(
      `UPDATE outbound_delivery_markers
       SET marker_key = replace(replace(marker_key, '|thenvoi|', '|band|'), '|thenvoi:', '|band:')
       WHERE marker_key LIKE '%|thenvoi%'`,
    ).run();

    // Module state: row key + platformId strings inside the JSON value.
    db.prepare(
      `UPDATE module_state
       SET value_json = replace(value_json, '"thenvoi:', '"band:')
       WHERE module_name = ?`,
    ).run(OLD);
    db.prepare(`UPDATE module_state SET module_name = ? WHERE module_name = ?`).run(NEW, OLD);
  },
};
