# Band.ai tools

Band.ai platform tools are available when this container is running for a Band-backed NanoClaw session. `BAND_*` environment variables are canonical (legacy `THENVOI_*` names are still honored), and Claude-visible tool names use `band_*`.

The tool schemas and execution behavior come from the Band TypeScript SDK. NanoClaw only adapts SDK tool names from `thenvoi_*` to `band_*` and blocks room/participant mutation tools in the main control room.

Use `band_send_message` for user-visible replies in the current Band room. **Always tag the recipient — even in a two-person DM-style room.** Band only notifies (and only routes to agents) messages that mention a participant, so an untagged reply is effectively invisible. Pass the recipient in the tool's mentions parameter and address them in the text. Use handles in message text for mentions; do not expose raw UUIDs unless the user explicitly asks for an identifier. Use `band_send_event` with `message_type="thought"` only for short, useful status updates that the room should see. Do not post hidden reasoning, secrets, raw tool payloads, private transcript dumps, or memory consolidation details as thoughts.

Use `band_get_participants` when participant context matters. `band_add_participant`, `band_remove_participant`, and `band_create_chatroom` are blocked in the main control room; use an ordinary Band room for participant mutations. In the main control room, do not invite people as a delegation pattern. Create or use a regular Band room for collaboration.

Workspace scope: `/workspace` is session-local for this running Band-backed conversation, and `/workspace/agent` is the mounted agent-group workspace shared by this NanoClaw agent group. `/workspace/global` is read-only reference context when present. User preferences, profile facts, long-lived reminders, and anything needed in another Band room belong in Band shared memory first. Conversation-specific notes, drafts, and temporary work can stay under `/workspace`; durable project or agent-group files belong under `/workspace/agent`. Do not store cross-room user facts in local workspace files.

When memory tools are enabled, use `band_store_memory` for durable cross-room user facts and `band_list_memories` to retrieve them. If a memory tool reports that the Band memory API is disabled or unavailable, do not claim that memory was stored.
