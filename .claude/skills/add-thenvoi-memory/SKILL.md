---
name: add-thenvoi-memory
description: Enable platform memory tools for the Thenvoi Platform channel. Requires /add-thenvoi to be set up first. Gives agents persistent memory across sessions. Triggers on "add thenvoi memory", "platform memory", "enable memory tools".
---

# Add Thenvoi Platform Memory

This skill enables persistent memory for agents running on the Thenvoi Platform. Memories are stored on the platform, persist across sessions, and are visible to other agents in the organization.

**Prerequisite**: Thenvoi channel must be set up first via `/add-thenvoi`. If `src/channels/thenvoi.ts` doesn't exist, run `/add-thenvoi` first.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## Phase 1: Pre-flight

Check if memory is already enabled:
```bash
grep "THENVOI_MEMORY" .env
```

If `THENVOI_MEMORY_TOOLS=true` is already set, inform the user and ask if they want to adjust settings (skip to Phase 2b). If not set, continue.

Check if the Thenvoi channel is set up:
```bash
grep "THENVOI_BASE_URL" .env
```

If not configured, tell the user to run `/add-thenvoi` first and stop.

## Phase 2a: Choose Memory Level

Explain the three levels to the user before asking:

> **Memory has three features that build on each other:**
>
> 1. **Memory tools** — The agent gets tools to store, list, retrieve, supersede, and archive memories during conversation. The system prompt teaches it when to use them — user preferences become semantic memories, events become episodic, workflows become procedural. The agent decides what's worth remembering.
>
> 2. **Load on join** — When the agent joins a chat room, it loads existing memories about each participant and starts the conversation with that context. If a new participant joins mid-conversation, their memories are loaded automatically too. The agent knows who it's talking to from the first message.
>
> 3. **Consolidation on leave** — When the agent leaves a chat room (idle timeout or removal), it reviews the entire conversation one final time. It stores genuinely new information, supersedes outdated memories, and deduplicates — all without the user asking. This uses one additional Claude API call per session.

AskUserQuestion: Which memory features would you like to enable?

1. **Memory tools only** — Agent can store/retrieve memories when asked
2. **Tools + load on join** — Also loads existing memories about participants when agent joins a room
3. **All three (recommended)** — Also runs automatic memory consolidation when agent leaves a room

### If Memory tools only

Add to `.env`:
```bash
THENVOI_MEMORY_TOOLS=true
```

### If Tools + load on join

Add to `.env`:
```bash
THENVOI_MEMORY_TOOLS=true
THENVOI_MEMORY_LOAD_ON_START=true
```

### If All three

Add to `.env`:
```bash
THENVOI_MEMORY_TOOLS=true
THENVOI_MEMORY_LOAD_ON_START=true
THENVOI_MEMORY_CONSOLIDATION=true
```

## Phase 2b: Review available tools

Show the user what memory tools the agent will have access to:

| Tool | Purpose |
|------|---------|
| `thenvoi_store_memory` | Store a new memory with type, segment, tags, and thought |
| `thenvoi_list_memories` | List stored memories with optional filters (scope, type, segment) |
| `thenvoi_get_memory` | Retrieve a specific memory by ID |
| `thenvoi_supersede_memory` | Replace an outdated memory (marks old one as superseded) |
| `thenvoi_archive_memory` | Archive a memory that's no longer relevant |

### Memory types

- **semantic** — Facts, preferences, knowledge ("User prefers dark mode")
- **episodic** — Events, decisions, outcomes ("Deployed v2.1 on March 15")
- **procedural** — Workflows, processes, how-tos ("To deploy: run X then Y")

### Memory segments

- **user** — Information about or for the user
- **agent** — Agent's own learned behavior and procedures

## Phase 3: Rebuild and Restart

```bash
npm run build
NO_CACHE=1 ./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Verify memory tools (all levels)

Send a message to the agent on the platform:

> "Remember that my favorite color is blue."

The agent should:
1. Send a thought explaining why it's storing this
2. Call `thenvoi_store_memory` with type="semantic", segment="user"
3. Confirm it was stored

Then verify retrieval:

> "What's my favorite color?"

The agent should call `thenvoi_list_memories` and find the stored memory.

### Verify load on join (if enabled)

Start a **new** chat room with the same user. The agent should reference the stored memory ("favorite color is blue") without being asked — it was loaded when the agent joined the room.

AskUserQuestion: Did the agent reference the stored memory in the new room?

1. **Yes** — Memory loading is working correctly
2. **No** — Let's check the logs

If No, check container logs:
```bash
ls -t groups/thenvoi_*/logs/container-*.log | head -1 | xargs grep -i "memory\|Loaded"
```

Look for `Loaded memories for N user(s)` or error messages. Common issues:
- Credential proxy not running (no `Credential proxy started` in main logs)
- Platform API returned empty (user has no stored memories yet — verify in platform Memory UI)

### Verify consolidation on leave (if enabled)

Have a conversation mentioning some preferences or facts, then trigger the agent to leave:

```bash
# Find the running container for the room
docker ps --filter "name=nanoclaw-thenvoi" --format "{{.Names}}"
# Kill it to trigger consolidation (or wait 30 min for idle timeout)
docker kill <container-name>
```

Check container logs for:
```
Running memory consolidation...
Memory consolidation complete
```

AskUserQuestion: Check the platform Memory UI (Agents → your agent → Memory). Do you see new memories from the conversation?

1. **Yes** — Consolidation is working
2. **No** — Let's debug

If No, check container logs for consolidation errors. The consolidation might produce no new memories if the conversation was trivial.

### Clean up test memory

> "Archive the test memory about my favorite color."

## Configuration Reference

| Variable | Default | What it does |
|----------|---------|--------------|
| `THENVOI_MEMORY_TOOLS` | `false` | Give the agent 5 memory tools + system prompt guidance |
| `THENVOI_MEMORY_LOAD_ON_START` | `false` | Load participant memories when agent joins a room + when new participants join |
| `THENVOI_MEMORY_CONSOLIDATION` | `false` | Review and store memories when agent leaves a room (1 extra API call) |

## Changing Configuration

Edit the relevant variables in `.env` and restart:

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

No container rebuild needed for configuration-only changes.

## Disabling Memory

Set any or all to `false` in `.env` and restart NanoClaw. Memory tools will no longer be available, but existing memories remain on the platform and can be viewed in the Memory UI.
