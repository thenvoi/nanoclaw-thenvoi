---
name: add-thenvoi-contacts
description: Add contact event handling for the Thenvoi Platform channel. Requires /add-thenvoi to be set up first. Choose between auto-approve (callback), LLM-managed hub room, or manual-only mode. Triggers on "add thenvoi contacts", "contact handling", "auto-approve contacts".
---

# Add Thenvoi Contact Handling

This skill adds contact event handling to the Thenvoi Platform channel. When someone sends a contact request to your NanoClaw agent, this determines how it's handled.

**Prerequisite**: Thenvoi channel must be set up first via `/add-thenvoi`. If `src/channels/thenvoi.ts` doesn't exist, run `/add-thenvoi` first.

## Phase 1: Pre-flight

Check if `THENVOI_CONTACT_STRATEGY` is already in `.env`. If it is, skip to Phase 3 (verify).

Check if the Thenvoi channel is set up:
```bash
grep "THENVOI_BASE_URL" .env
```

If not configured, tell the user to run `/add-thenvoi` first.

## Phase 2: Choose Strategy

AskUserQuestion: How should contact requests be handled?

1. **Disabled (default)** — Contact events are logged but not auto-processed. You can still ask the agent "show me contact requests" in any room and manually approve/reject them.

2. **Callback (auto-approve)** — All incoming contact requests are automatically approved. Good for agents that should be discoverable and open to connections.

3. **Hub Room (LLM-managed)** — A dedicated chat room is created on the platform where the agent evaluates each contact request. You (the owner) can see the agent's reasoning and intervene. Best for agents that need selective approval.

### If Disabled

Add to `.env`:
```bash
THENVOI_CONTACT_STRATEGY=disabled
```

No other configuration needed. The agent will log contact events and you can manage contacts manually by asking the agent in any room.

### If Callback

Add to `.env`:
```bash
THENVOI_CONTACT_STRATEGY=callback
```

All contact requests will be auto-approved. The agent logs each approval.

### If Hub Room

Add to `.env`:
```bash
THENVOI_CONTACT_STRATEGY=hub_room
```

Optionally set your platform user ID (auto-derived from agent profile if not set):
```bash
THENVOI_OWNER_ID=your-platform-user-uuid
```

To find your user ID, check the platform admin panel or run:
```bash
curl -s -H "x-api-key: YOUR_AGENT_API_KEY" "YOUR_PLATFORM_URL/api/v1/agent/me" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['owner_uuid'])"
```

The hub room is created automatically on the first contact event. You'll see it appear in your platform chat list as "Contact Hub".

## Phase 3: Restart and Verify

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

### Verify disabled strategy

Send a contact request to the agent from another platform account. Check NanoClaw logs for:
```
WARN: Thenvoi: contact event received (strategy=disabled)
```

Then ask the agent in any room: "Do we have any contact requests?" — it should list the pending request.

### Verify callback strategy

Send a contact request. Check logs for:
```
INFO: Thenvoi: auto-approving contact request
INFO: Thenvoi: contact request auto-approved
```

The request should be approved on the platform.

### Verify hub room strategy

Send a contact request. A "Contact Hub" room should appear in your platform chat list. The agent will evaluate the request and report its decision. You can see the conversation and intervene.

## Switching Strategies

Edit `THENVOI_CONTACT_STRATEGY` in `.env` and restart NanoClaw. The change takes effect immediately.

## Manual Contact Management (all strategies)

Regardless of strategy, you can always manage contacts by talking to the agent in any room:

- "Show me contact requests" → lists pending requests
- "Approve the request from @alice" → approves
- "Reject the request from @alice" → rejects
- "List my contacts" → shows current contacts
- "Remove contact @alice" → removes
- "Send a contact request to @bob" → initiates
