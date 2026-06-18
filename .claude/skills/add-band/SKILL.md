---
name: add-band
description: Add Band.ai channel integration. The product formerly known as Thenvoi — channel type `band`, BAND_* settings, domain app.band.ai.
---

# Add Band.ai Channel

Adds Band.ai chat support to NanoClaw. Band is the product (formerly Thenvoi; domain `app.band.ai`). The channel registers as `band`, platform IDs use the `band:` prefix, and configuration uses `BAND_*` environment variables (legacy `THENVOI_*` names are honored as a fallback). Only the npm package scope keeps the old name (`@thenvoi/rest-client`) until the renamed packages are published.

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/band.ts` exists
- `src/channels/channel-container-registry.ts` exists
- `src/channels/index.ts` contains `import './band.js';`
- `src/db/inbound-delivery-ledger.ts`, `src/db/module-state.ts`, and `src/db/outbound-delivery-markers.ts` exist
- `container/agent-runner/src/mcp-tools/band.ts` exists
- `container/agent-runner/src/mcp-tools/index.ts` contains `import './band.js';`
- `container/agent-runner/src/band-memory-load.ts` and `container/agent-runner/src/band-memory-consolidate.ts` exist
- `@thenvoi/sdk` and `@thenvoi/rest-client` are listed in `package.json`
- `@thenvoi/sdk` and `@thenvoi/rest-client` are listed in `container/agent-runner/package.json`
- `docker-compose.yml`, `Dockerfile.host`, `container/Dockerfile`, and `.env.compose.template` exist
- `container/agent-runner/src/providers/claude.ts` contains `CLAUDE_CODE_EXECUTABLE`
- `container/agent-runner/src/providers/mock.ts` wraps default replies in `<message to="...">` when a prompt has a source destination
- `src/container-runner.ts` calls `rewriteOneCliProxyArgs(args)` after OneCLI applies container config

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the Band integration branch

Fetch the branch that carries the v2 Band.ai integration:

```bash
git fetch origin migrate/band-v2-foundation
```

If this integration has landed under a different branch name, use that branch in the `git show` commands below.

### 2. Copy the Band runtime file set

Band touches channel ingestion, route idempotency, outbound delivery markers, container env projection, and the agent-runner MCP/tools loop. Copy the whole tested file set from the integration branch instead of only the obvious `band.ts` files; a partial copy can compile but fail at runtime, or fail typecheck because shared route contracts drifted.

```bash
git checkout origin/migrate/band-v2-foundation -- \
  .dockerignore \
  .env.compose.template \
  .env.example \
  .gitignore \
  Dockerfile.host \
  docker-compose.yml \
  docs/docker-compose-deployment.md \
  container/Dockerfile \
  container/agent-runner/bun.lock \
  container/agent-runner/package.json \
  container/agent-runner/src/band-memory-consolidate.test.ts \
  container/agent-runner/src/band-memory-consolidate.ts \
  container/agent-runner/src/band-memory-load.test.ts \
  container/agent-runner/src/band-memory-load.ts \
  container/agent-runner/src/index.ts \
  container/agent-runner/src/integration.test.ts \
  container/agent-runner/src/mcp-tools/index.ts \
  container/agent-runner/src/mcp-tools/server.ts \
  container/agent-runner/src/mcp-tools/band.instructions.md \
  container/agent-runner/src/mcp-tools/band.test.ts \
  container/agent-runner/src/mcp-tools/band.ts \
  container/agent-runner/src/poll-loop.test.ts \
  container/agent-runner/src/poll-loop.ts \
  container/agent-runner/src/providers/claude.ts \
  container/agent-runner/src/providers/mock.ts \
  container/agent-runner/src/providers/types.ts \
  package.json \
  pnpm-lock.yaml \
  src/channels/adapter.ts \
  src/channels/channel-container-registry.test.ts \
  src/channels/channel-container-registry.ts \
  src/channels/cli.ts \
  src/channels/index.ts \
  src/channels/band.test.ts \
  src/channels/band.ts \
  src/circuit-breaker.test.ts \
  src/circuit-breaker.ts \
  src/container-runner.test.ts \
  src/container-runner.ts \
  src/container-runtime.test.ts \
  src/container-runtime.ts \
  src/db/db-v2.test.ts \
  src/db/inbound-delivery-ledger.ts \
  src/db/index.ts \
  src/db/migrations/014-route-foundation-state.ts \
  src/db/migrations/015-band-rename.ts \
  src/db/migrations/index.ts \
  src/db/module-state.ts \
  src/db/outbound-delivery-markers.ts \
  src/db/schema.ts \
  src/db/session-db.test.ts \
  src/db/session-db.ts \
  src/db/sessions.ts \
  src/host-core.test.ts \
  src/index.ts \
  src/modules/agent-to-agent/agent-route.test.ts \
  src/modules/band-config.ts \
  src/providers/claude.ts \
  src/providers/index.ts \
  src/router.ts
```

This command also brings in the self-registration imports, migration registration, and db barrel exports. If the checkout has local changes in any listed file, review `git diff` first and merge deliberately instead of blindly overwriting.

### 3. Install packages from the copied lockfiles

```bash
pnpm install --frozen-lockfile
cd container/agent-runner && bun install --frozen-lockfile
```

### 4. Configure environment

Add the agent credentials to `.env`:

```bash
BAND_AGENT_ID=your-agent-id
BAND_API_KEY=your-agent-api-key
# Optional. Defaults to https://app.band.ai when unset.
BAND_BASE_URL=https://app.band.ai

# Optional. UUID of the Band user who owns this agent. Used by the contact
# hub-room strategy (added as the room owner) and other paths that need to
# address the owner directly. Falls back to GET /agent/me when unset.
BAND_OWNER_ID=

# Memory feature flags. See "Memory knobs" below.
BAND_MEMORY_TOOLS=false
BAND_MEMORY_LOAD_ON_START=false
BAND_MEMORY_CONSOLIDATION=false

# Contact-event strategy: disabled | hub_room.
# See "Contact strategies" below.
BAND_CONTACT_STRATEGY=disabled
# Optional. Agent group that should handle Contact Hub synthetic messages.
# If unset and exactly one agent group exists, NanoClaw uses that group.
BAND_CONTACT_AGENT_GROUP_ID=
```

For normal hosted Band.ai, leave `BAND_BASE_URL` unset or set it to `https://app.band.ai`. Direct `BAND_API_KEY` injection into agent containers is only for local HTTP validation or explicit `BAND_INJECT_API_KEY=true`; hosted HTTPS sessions should use OneCLI secret injection. Existing installs with `THENVOI_*` variables keep working — `BAND_*` simply takes precedence when both are set.

#### Memory knobs

- `BAND_MEMORY_TOOLS` — exposes `mcp__nanoclaw__band_list_memories`, `band_store_memory`, `band_supersede_memory`, etc. to the agent. The other two memory knobs are no-ops without this enabled.
- `BAND_MEMORY_LOAD_ON_START` — at container startup, fetch each room participant's stored memories via the SDK (`thenvoi_list_memories`, scope=`subject`, top 10 per participant) and append them to the system prompt as `## Existing Memories About Room Participants`. Also injects a synthetic `[System]` message into the room when a new participant joins mid-session (`participant_added`), with up to 10 of that participant's memories. Failure is non-fatal: the agent still starts.
- `BAND_MEMORY_CONSOLIDATION` — after the poll loop exits (typically on SIGTERM from `docker stop` when the host kills the container), run a one-shot consolidation pass against the same provider session. The pass is forbidden from sending chat messages or `<message to="…">` blocks; only memory tools are available at runtime. Output is drained, not delivered. No-op unless `BAND_MEMORY_TOOLS` is also enabled.

#### Contact strategies

`BAND_CONTACT_STRATEGY` controls what the host does with `contact_request_received`, `contact_request_updated`, `contact_added`, and `contact_removed` events emitted by Band:

- `disabled` (default) — events are dropped silently. The agent never sees contacts; outbound contact tools still work.
- `hub_room` — lazily provision a per-agent "Contact Hub" Band chat room, add `BAND_OWNER_ID` (or the value resolved from `GET /agent/me`) as a member, persist its room id in `data/v2.db` module state, wire it to `BAND_CONTACT_AGENT_GROUP_ID` (or the only agent group when exactly one exists), and forward every contact event into the hub as a synthetic message. The owner replies in the hub.

Sync the environment file if this instance uses `data/env/env`:

```bash
mkdir -p data/env && cp .env data/env/env
```

### 5. Build and test

```bash
pnpm install
pnpm run build
pnpm test -- src/channels/band.test.ts
cd container/agent-runner && bun test src/mcp-tools/band.test.ts
```

## Wire Band rooms

The Band adapter discovers rooms into `messaging_groups`, but discovery alone does not wire a room to an agent. Run `/manage-channels` and wire the desired Band room using:

- **type**: `band`
- **platform ID format**: `band:<room-id>`
- **session mode**: `shared` for room-local conversations, or `agent-shared` only when intentionally merging multiple channel surfaces into one agent session

For v1-style Band parity, use an engagement policy that responds in the selected room rather than silently accumulating ignored chatter.

## Channel Info

- **type**: `band`
- **user-facing name**: Band.ai
- **terminology**: Band has rooms/chats. The main control room is the owner-visible direct room and blocks room/participant mutation tools.
- **platform-id-format**: `band:<roomId>`
- **supports-threads**: no
- **typical-use**: Direct Band room or shared collaboration room with SDK-backed platform tools
- **default-isolation**: Same agent group for your own Band rooms. Separate agent groups for rooms with different people, projects, or data boundaries.

## Features

- Native Band message ingestion through the Band SDK
- SDK-backed Claude-visible tools exposed as `band_*`
- Fallback outbound delivery for ordinary NanoClaw `messages_out` chat rows
- Main control room detection and container env propagation
- Main-room participant/room mutation guardrails
- Memory tools gated by `BAND_MEMORY_TOOLS` and disabled for the run if the Band memory API is unavailable
- Optional participant-memory pre-load at startup (`BAND_MEMORY_LOAD_ON_START`)
- Optional end-of-session memory consolidation pass (`BAND_MEMORY_CONSOLIDATION`)
- Contact-event handling: drop or hub-room forwarding (`BAND_CONTACT_STRATEGY`)
- Hosted Band sessions avoid direct API-key env injection; local HTTP validation can opt in

## Troubleshooting

If messages appear in Band but the agent does not answer, check that the room is wired, not only discovered:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, channel_type, platform_id, name FROM messaging_groups WHERE channel_type='band'"
pnpm exec tsx scripts/q.ts data/v2.db "SELECT messaging_group_id, agent_group_id, session_mode FROM messaging_group_agents"
```

If tools are missing inside the container, verify that the session is Band-backed and that `container/agent-runner/src/mcp-tools/index.ts` imports `./band.js`.

If memory tools return disabled/unavailable, leave them disabled for that run. Do not claim cross-room memory was stored unless the `band_store_memory` call succeeds.
