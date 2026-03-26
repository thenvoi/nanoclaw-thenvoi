---
name: add-thenvoi-memory
description: Enable platform memory tools for the Thenvoi Platform channel. Requires /add-thenvoi to be set up first. Gives agents persistent memory across sessions. Triggers on "add thenvoi memory", "platform memory", "enable memory tools".
---

# Add Thenvoi Platform Memory

This skill enables persistent memory tools for agents running on the Thenvoi Platform channel. Memories are stored on the platform and persist across sessions, visible to other agents in the organization.

**Prerequisite**: Thenvoi channel must be set up first via `/add-thenvoi`. If `src/channels/thenvoi.ts` doesn't exist, run `/add-thenvoi` first.

## Phase 1: Pre-flight

Check if memory tools are already enabled:
```bash
grep "THENVOI_MEMORY_TOOLS" .env
```

If `THENVOI_MEMORY_TOOLS=true` is already set, skip to Phase 3 (verify).

Check if the Thenvoi channel is set up:
```bash
grep "THENVOI_BASE_URL" .env
```

If not configured, tell the user to run `/add-thenvoi` first.

## Phase 2: Enable Memory Tools

Add to `.env`:
```bash
THENVOI_MEMORY_TOOLS=true
```

This registers the following tools in the agent's MCP server:

| Tool | Purpose |
|------|---------|
| `thenvoi_store_memory` | Store a new memory with type, segment, and metadata |
| `thenvoi_list_memories` | List stored memories with optional filters |
| `thenvoi_get_memory` | Retrieve a specific memory by ID |
| `thenvoi_supersede_memory` | Replace outdated memory (marks old one as superseded) |
| `thenvoi_archive_memory` | Archive a memory that's no longer relevant |

### Memory Types

- **semantic** — Facts, preferences, knowledge ("User prefers dark mode")
- **episodic** — Events, decisions, outcomes ("Deployed v2.1 on March 15")
- **procedural** — Workflows, processes, how-tos ("To deploy: run X then Y")

### Memory Segments

- **user** — Information about or for the user
- **agent** — Agent's own learned behavior and procedures

## Phase 3: Rebuild and Verify

```bash
./container/build.sh
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

### Verify memory tools are registered

Send a message to the agent on the platform and ask it to store a test memory:

> "Remember that my favorite color is blue."

The agent should:
1. Send a thought explaining why it's storing this
2. Call `thenvoi_store_memory` with type="semantic", segment="user"
3. Confirm it was stored

Then verify retrieval:

> "What's my favorite color?"

The agent should call `thenvoi_list_memories` and find the stored memory.

### Clean up test memory

> "Archive the test memory about my favorite color."

## Disabling Memory Tools

Set `THENVOI_MEMORY_TOOLS=false` in `.env` and restart NanoClaw. Memory tools will no longer be available to agents, but existing memories remain on the platform.
