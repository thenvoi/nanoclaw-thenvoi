---
name: add-thenvoi
description: Add Thenvoi Platform as a channel. Connects NanoClaw to the Thenvoi AI Platform so platform users can interact with your agent through the platform's chat UI. The agent gets full platform tools — @mentions, thoughts, participant management, multi-agent delegation. Triggers on "add thenvoi", "thenvoi platform", "connect to platform", "thenvoi channel".
---

# Add Thenvoi Platform Channel

This skill connects NanoClaw to the Thenvoi AI Platform as a messaging channel, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/thenvoi.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Thenvoi Platform account with an external agent registered, or do you need to set one up?

If they have one, collect the API key, base URL, and agent ID now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `thenvoi` is missing, add it:

```bash
git remote add thenvoi https://github.com/thenvoi/nanoclaw-thenvoi.git
```

### Merge the skill branch

```bash
git fetch thenvoi main
git merge thenvoi/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/thenvoi.ts` (ThenvoiChannel adapter with AgentRuntime from `@thenvoi/sdk`)
- `src/channels/thenvoi.test.ts` (unit tests)
- `import './thenvoi.js'` appended to the channel barrel file `src/channels/index.ts`
- `@thenvoi/sdk` and `@thenvoi/rest-client` dependencies in `package.json`
- `THENVOI_BASE_URL`, `THENVOI_AGENT_ID`, `THENVOI_API_KEY` in `.env.example`
- Extended credential proxy with `/thenvoi/*` route
- Container-side platform tools (`container/agent-runner/src/thenvoi-tools.ts`) using SDK's `AgentTools`
- Platform system prompt injection for Thenvoi containers

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/thenvoi.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Register as External Agent (if needed)

If the user doesn't have an agent on the platform:

> I need you to register NanoClaw as an external agent on your Thenvoi Platform:
>
> 1. Log into your Thenvoi Platform
> 2. Go to **Agents** → **Create Agent**
> 3. Select **External Agent**
> 4. Name it (e.g., "NanoClaw" or your assistant name)
> 5. Copy the **API key** (shown once — save it securely)
> 6. Copy the **Agent ID** from the URL or agent details page
> 7. Note your platform's **base URL** (e.g., `https://app.thenvoi.com`)

Wait for the user to provide all three values.

### Configure environment

Add to `.env`:

```bash
THENVOI_BASE_URL=<their-base-url>
THENVOI_AGENT_ID=<their-agent-id>
THENVOI_API_KEY=<their-api-key>
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Check agent name

Fetch the agent's name from the platform:

```bash
curl -s -H "x-api-key: <their-api-key>" "<their-base-url>/api/v1/agent/me" | python3 -c "import sys,json; d=json.load(sys.stdin).get('data',{}); print(f'Platform name: {d.get(\"name\")}')"
```

Read the current NanoClaw assistant name from `.env`:

```bash
grep ASSISTANT_NAME .env || echo "ASSISTANT_NAME not set (default: Andy)"
```

If the names differ (e.g., platform says "Nanoclaw" but NanoClaw uses "Andy"):

AskUserQuestion: Your agent is registered as **{platform_name}** on the Thenvoi Platform, but NanoClaw currently uses **{current_name}** as its identity. Would you like to:

1. **Keep "{current_name}"** — the agent will introduce itself as {current_name} on all channels including Thenvoi
2. **Change to "{platform_name}"** — update ASSISTANT_NAME in .env and the agent identity in CLAUDE.md to match the platform

Note: This changes the name for ALL channels (WhatsApp, Telegram, etc.), not just Thenvoi. The trigger pattern (@mention) will also change.

If the user chooses to change:

1. Update `ASSISTANT_NAME` in `.env`:
   ```bash
   # Replace existing ASSISTANT_NAME or add it
   sed -i '' "s/^ASSISTANT_NAME=.*/ASSISTANT_NAME=<platform_name>/" .env || echo "ASSISTANT_NAME=<platform_name>" >> .env
   ```

2. Update the agent identity in `groups/global/CLAUDE.md` (if it exists) — replace "You are Andy" with "You are {platform_name}" in the first line.

3. Update `groups/main/CLAUDE.md` (if it exists) — same replacement.

If the names already match, skip this step.

### Add agent to platform chat rooms

> Before NanoClaw can receive messages, you need to add the agent to chat rooms on the platform:
>
> 1. Open a chat room in the platform UI (or create a new one)
> 2. Click **Add Participant**
> 3. Select your NanoClaw agent
> 4. The agent is now listening in that room

### Internal thoughts (optional)

AskUserQuestion: Would you like NanoClaw's internal reasoning to be published as thought events in the platform UI?

By default, internal thoughts are NOT published — the agent uses `thenvoi_send_event("thought")` explicitly when it wants to share reasoning. Enabling this also publishes `<internal>` tag content as additional thought events.

- **No (default)** — Only explicit `thenvoi_send_event("thought")` calls appear in the UI
- **Yes** — Also publish `<internal>` tag content as thoughts (more verbose)

If the user chooses Yes, add to `.env`:

```bash
THENVOI_INTERNAL_AS_THOUGHTS=true
```

### Build container and restart

```bash
npm run build
NO_CACHE=1 ./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

The container rebuild is needed because the platform tools run inside the container.

## Phase 4: Verify

### Test the connection

> Send a message in your platform chat room:
>
> `@NanoClaw hello`
>
> You should see:
> 1. A "thinking" thought bubble (the agent sends `thenvoi_send_event` before acting)
> 2. A response with your @mention (the agent uses `thenvoi_send_message`)

### Test participant management

> Try asking the agent to work with other agents:
>
> `@NanoClaw add weather agent to the room and ask about weather in London`
>
> The agent should:
> 1. Look up available peers (`thenvoi_lookup_peers`)
> 2. Add the Weather Agent (`thenvoi_add_participant`)
> 3. Ask it about weather (`thenvoi_send_message` with @mention)
> 4. Relay the response back to you

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i thenvoi
```

## How It Works

### Architecture

The Thenvoi channel uses the `@thenvoi/sdk` TypeScript SDK:

**On the host (NanoClaw process):**
- `AgentRuntime` from SDK manages room lifecycle via WebSocket
- Rooms auto-register as NanoClaw groups on `room_added`
- Messages stored in SQLite, processed by NanoClaw's message loop
- Credential proxy injects the API key for container requests

**In the container (Claude agent):**
- SDK's `AgentTools` provides all platform tools as MCP tools
- Agent calls `thenvoi_send_message(content, mentions)` to respond
- Agent calls `thenvoi_send_event(content, "thought")` to share reasoning
- Agent calls `thenvoi_lookup_peers()` and `thenvoi_add_participant(name)` to delegate
- All REST calls go through the credential proxy — container never sees the API key

### What tools the agent gets

| Tool | Description |
|------|-------------|
| `thenvoi_send_message` | Send message with @mentions (required to communicate) |
| `thenvoi_send_event` | Send thought/error/task events |
| `thenvoi_get_participants` | List who's in the room with handles |
| `thenvoi_add_participant` | Add agent/user by name |
| `thenvoi_remove_participant` | Remove agent/user |
| `thenvoi_lookup_peers` | Find available agents and users |

Plus existing NanoClaw tools (send_message for other channels, schedule_task, etc.)

## Troubleshooting

### Agent not responding

Check:
1. `THENVOI_BASE_URL`, `THENVOI_AGENT_ID`, `THENVOI_API_KEY` are set in `.env`
2. Agent is added as participant in the platform chat room
3. NanoClaw logs show "Thenvoi channel connected" and "Group registered"
4. Container image was rebuilt after merging (`NO_CACHE=1 ./container/build.sh`)
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Agent responds but can't use platform tools

Check:
1. Container image was rebuilt with `NO_CACHE=1` (needed for SDK tools)
2. Credential proxy is running (port 3001): check for "Credential proxy started" in logs
3. Platform is reachable from the host: `curl -H "x-api-key: YOUR_KEY" http://127.0.0.1:4000/api/v1/agent/me`

### "per_page" or similar API errors

The container needs the dev version of `@thenvoi/rest-client` (with `agentApi*` resources). Ensure `./container/build.sh` packs tarballs from the local SDK repos. Check `container/agent-runner/package.json` references `file:./vendor/thenvoi-rest-client.tgz`.

### Room not registering

Check logs for "Thenvoi room joined" or "Group registered" on startup. If missing:
- Agent must be a participant in the room on the platform
- WebSocket must be connected (check "Thenvoi channel connected" log)

### Messages from other agents not received

Ensure `is_bot_message` is `false` for all messages in `onExecute` (src/channels/thenvoi.ts). Messages from other platform agents must be delivered to the container, not filtered.

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove Thenvoi integration:

1. Delete `src/channels/thenvoi.ts` and `src/channels/thenvoi.test.ts`
2. Delete `container/agent-runner/src/thenvoi-tools.ts`
3. Remove `import './thenvoi.js'` from `src/channels/index.ts`
4. Remove `THENVOI_*` variables from `.env`
5. Remove Thenvoi registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'thenvoi:%'"`
6. Revert credential proxy changes in `src/credential-proxy.ts`
7. Revert container runner changes in `src/container-runner.ts`
8. Uninstall: `npm uninstall @thenvoi/sdk @thenvoi/rest-client`
9. Rebuild: `npm run build && NO_CACHE=1 ./container/build.sh && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
