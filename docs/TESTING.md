# Thenvoi Channel Integration — Manual Test Plan

## Prerequisites

- Fresh NanoClaw clone (upstream `qwibitai/nanoclaw`)
- Thenvoi skills symlinked or merged into `.claude/skills/`
- Local Thenvoi platform running at `http://127.0.0.1:4000` (or production at `https://app.thenvoi.com`)
- Docker running
- OneCLI installed and running (`onecli version`, `curl -sf http://127.0.0.1:10254/health`)
- Anthropic credentials registered with OneCLI (`onecli secrets list`)
- A registered external agent on the platform (agent ID, API key)

## Step 1: Base Setup (Clean Baseline)

```bash
cd /path/to/nanoclaw-test
claude
```

Run: `/setup`

Choose:
- Anthropic API key (not OAuth)
- Docker as container runtime
- **Skip all channels** — we want a clean baseline first

**Verify:**
- [ ] `npm run dev` starts successfully
- [ ] Logs show "NanoClaw running (trigger: @Andy)"
- [ ] No channels connected (no WhatsApp/Telegram/Slack/Discord in logs)

## Step 2: Add Thenvoi Channel

In Claude: `/add-thenvoi`

The skill should:
1. Add git remote: `git remote add thenvoi https://github.com/thenvoi/nanoclaw-thenvoi.git`
2. Merge: `git fetch thenvoi main && git merge thenvoi/main`
3. Install and build: `npm install && npm run build`
4. Run tests: `npx vitest run src/channels/thenvoi.test.ts`
5. Ask for agent ID, API key, base URL
6. Ask about OneCLI secret registration (for HTTPS targets)
7. Ask about agent name sync (platform name vs local name)
8. Ask about internal thoughts publishing
9. Ask about container capacity
10. Rebuild container: `NO_CACHE=1 ./container/build.sh`
11. Restart service

**Verify:**
- [ ] All thenvoi tests pass
- [ ] `npm run dev` shows "Thenvoi channel connected"
- [ ] Active rooms register on startup (if agent is in any rooms)
- [ ] Send a message on the platform → agent responds via `thenvoi_send_message`
- [ ] Thought events appear in the platform UI
- [ ] Agent can look up peers (`thenvoi_lookup_peers`)
- [ ] Agent can add participants (`thenvoi_add_participant`)

## Step 3: Add Thenvoi Contacts

In Claude: `/add-thenvoi-contacts`

Choose `hub_room` strategy. The skill should:
1. Ask which strategy (disabled / callback / hub_room)
2. For hub_room: optionally set owner ID (auto-derived if not set)
3. Add `THENVOI_CONTACT_STRATEGY=hub_room` to `.env`
4. Restart

**Verify:**
- [ ] Send a contact request from another platform account
- [ ] "Contact Hub" room appears in platform chat list
- [ ] Agent evaluates the request and reports decision
- [ ] Owner can see the hub room conversation
- [ ] Deduplication works (same event doesn't trigger twice)

## Step 4: Add Thenvoi Memory

In Claude: `/add-thenvoi-memory`

Choose "All three (recommended)". The skill should:
1. Ask which level (tools only / tools+load / all three)
2. Add the relevant env vars to `.env`
3. Rebuild container
4. Restart

### 4a: Verify Memory Tools

- [ ] Tell the agent: "Remember that I prefer dark mode"
- [ ] Agent sends a thought explaining why it's storing this
- [ ] Agent calls `thenvoi_store_memory` with type="semantic", segment="user"
- [ ] Memory appears in platform Memory UI with tags
- [ ] Ask: "What do you remember about me?" → agent calls `thenvoi_list_memories`

### 4b: Verify Load on Join

- [ ] Start a **new** chat room with the same user
- [ ] Agent references "dark mode" preference without being asked
- [ ] Container logs show: `Loaded memories for N user(s)`
- [ ] Add a new participant mid-conversation → their memories load as system message

### 4c: Verify Consolidation on Leave

- [ ] Have a conversation with new preferences/facts
- [ ] Kill the container: `docker kill <container-name>` (or wait 30 min idle timeout)
- [ ] Container logs show: `Running memory consolidation...` then `Memory consolidation complete`
- [ ] New memories appear in platform Memory UI
- [ ] Have a second conversation with contradicting info → after exit, old memory is superseded

### 4d: Verify Memory Supersede

- [ ] Tell agent: "Actually I prefer light mode now"
- [ ] Agent should supersede the "dark mode" memory, not create a duplicate
- [ ] Platform Memory UI shows old memory as "Superseded"

## Step 5: Channel Coexistence

Add a second channel alongside Thenvoi.

In Claude: `/add-telegram` (or `/add-whatsapp`)

**Verify:**
- [ ] Both channels show as connected in logs
- [ ] Thenvoi messages still work (send message on platform → response)
- [ ] Telegram messages still work (send message in Telegram → response)
- [ ] No interference between channels (different JID prefixes)
- [ ] Container isolation: each group gets its own container regardless of channel
- [ ] OneCLI injects Anthropic credentials for all containers

## Step 6: Rollback Thenvoi

Remove Thenvoi without affecting other channels.

```bash
# Remove thenvoi channel import
# Edit src/channels/index.ts — remove: import './thenvoi.js'

# Remove env vars
# Edit .env — remove all THENVOI_* lines

# Remove OneCLI secret (optional)
onecli secrets delete Thenvoi

# Rebuild
npm run build
npm run dev
```

**Verify:**
- [ ] NanoClaw starts without errors
- [ ] No "Thenvoi" in logs
- [ ] Second channel (Telegram/WhatsApp) still works
- [ ] No crash from `@thenvoi/sdk` still being in node_modules
- [ ] OneCLI still works for Anthropic API
- [ ] Scheduled tasks still run
- [ ] IPC still works

## Step 8: Re-add After Rollback

```bash
# Re-add the import
# Edit src/channels/index.ts — add back: import './thenvoi.js'

# Re-add THENVOI_* env vars to .env

npm run build
npm run dev
```

**Verify:**
- [ ] Thenvoi reconnects
- [ ] Rooms re-register from platform
- [ ] Messages flow again
- [ ] Second channel still works alongside
- [ ] Previously stored memories still load (platform-side persistence)

## Test Matrix

| Step | What It Validates |
|------|------------------|
| 1 | Base NanoClaw works without any channels |
| 2 | Skill merge, build, OneCLI, WebSocket, room lifecycle, message flow |
| 3 | Contact strategies, hub room creation, owner auto-resolution |
| 4a | Memory tools registration, store/list/supersede/archive |
| 4b | Memory load on join, mid-session participant injection |
| 4c | Consolidation on leave, LLM-guided memory review |
| 4d | Memory supersede (no duplicates) |
| 5 | Channel coexistence — multiple channels simultaneously |
| 6 | Clean removal — no side effects on other channels |
| 7 | Re-add after removal — stateless, re-attachable |

## Environment Configurations

### Local Development (HTTP)
```bash
THENVOI_BASE_URL=http://127.0.0.1:4000
THENVOI_AGENT_ID=<local-agent-id>
THENVOI_API_KEY=<local-api-key>
```

Container gets `THENVOI_API_KEY` as env var (direct, no OneCLI for Thenvoi). OneCLI handles Anthropic credentials only. `localhost` is rewritten to `host.docker.internal` so containers can reach the host.

### Production (HTTPS)
```bash
THENVOI_BASE_URL=https://app.thenvoi.com
THENVOI_AGENT_ID=<prod-agent-id>
THENVOI_API_KEY=<prod-api-key>
```

OneCLI injects Thenvoi key via MITM proxy. Register the secret:
```bash
onecli secrets create --name Thenvoi --type generic \
  --value <api-key> --host-pattern app.thenvoi.com --header-name x-api-key
```
Agents must have `secretMode: "all"` (set automatically by NanoClaw on agent creation). Container never sees `THENVOI_API_KEY`.

## Troubleshooting

### Agent not responding
- Check logs for "Thenvoi channel connected"
- Check `THENVOI_BASE_URL`, `THENVOI_AGENT_ID`, `THENVOI_API_KEY` in `.env`
- Verify agent is added as participant in the platform chat room
- Check container image was rebuilt after merge (`NO_CACHE=1 ./container/build.sh`)

### Agent uses send_message instead of thenvoi_send_message
- Check the group's `CLAUDE.md` — it should say "Plain text output is NOT delivered"
- If it says "Your output is sent to the user or group" → it has the generic template
- Delete the stale CLAUDE.md and restart: the Thenvoi template will be copied
- Verify `groups/thenvoi/CLAUDE.md` exists (the template)

### Memory load returns empty
- Verify `THENVOI_MEMORY_LOAD_ON_START=true` in `.env`
- Check platform Memory UI — does the user have any stored memories?
- Check container logs for `Loaded memories for N user(s)` or errors
- For HTTP: verify `THENVOI_API_KEY` is set in `.env`
- For HTTPS: verify OneCLI has the Thenvoi secret (`onecli secrets list`)

### Consolidation doesn't run
- Verify `THENVOI_MEMORY_CONSOLIDATION=true` in `.env`
- Container must exit cleanly (idle timeout or `docker kill`, not `docker rm -f`)
- Check container logs for `Running memory consolidation...`
- If it says "Memory consolidation failed" — check error message

### Contact hub room not created
- Verify `THENVOI_CONTACT_STRATEGY=hub_room` in `.env`
- First contact event triggers creation — send a contact request
- Check logs for "Thenvoi: creating contact hub room"
- If owner not added: check `THENVOI_OWNER_ID` or agent profile `owner_uuid`

### OneCLI not injecting Thenvoi key (production HTTPS)
- Verify secret exists: `onecli secrets list` — should show Thenvoi with correct host pattern
- Secret type must be `generic` with `headerName: x-api-key`
- Agent must have `secretMode: "all"`: check via OneCLI dashboard or `onecli agents list`
- Host pattern must match the production hostname (e.g., `app.thenvoi.com`)
- Verify container has no `THENVOI_API_KEY` env var: `docker exec <name> env | grep THENVOI_API_KEY`
