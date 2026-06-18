/**
 * Band.ai end-of-session memory consolidation.
 *
 * When `BAND_MEMORY_CONSOLIDATION=true` and the channel is `band`, this
 * runs once after the poll loop has exited (typically on SIGTERM from the host
 * when the container is being shut down). It drives the configured provider
 * directly with a consolidation prompt — events are drained but never written
 * to outbound.db, since this is internal housekeeping the user must not see.
 *
 * Failure is non-fatal — the container exits regardless.
 */
import type { AgentProvider } from './providers/types.js';

function log(msg: string): void {
  console.error(`[band-memory-consolidate] ${msg}`);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function shouldRun(): boolean {
  return (
    (process.env.BAND_MEMORY_TOOLS === 'true' || process.env.THENVOI_MEMORY_TOOLS === 'true') &&
    (process.env.BAND_MEMORY_CONSOLIDATION === 'true' || process.env.THENVOI_MEMORY_CONSOLIDATION === 'true') &&
    (process.env.NANOCLAW_CHANNEL === 'band' || process.env.NANOCLAW_CHANNEL === 'thenvoi')
  );
}

async function loadSubjectMap(): Promise<string> {
  const agentId = env('BAND_AGENT_ID') ?? env('THENVOI_AGENT_ID');
  const roomId = env('BAND_ROOM_ID') ?? env('THENVOI_ROOM_ID');
  if (!agentId || !roomId) {
    return 'No participant subject map is available. Do not store user- or agent-specific memories.';
  }

  try {
    const { ThenvoiLink } = await import('@thenvoi/sdk');
    const { AgentTools } = await import('@thenvoi/sdk/runtime');
    const link = new ThenvoiLink({
      agentId,
      apiKey: env('BAND_API_KEY') ?? env('THENVOI_API_KEY') ?? env('ONECLI_API_KEY') ?? '',
      restUrl: env('BAND_REST_URL') ?? env('THENVOI_REST_URL'),
    });
    const tools = new AgentTools({ roomId, rest: link.rest, capabilities: { memory: true } });
    const participants = await tools.getParticipants();
    if (participants.length === 0) {
      return 'No room participants were returned. Do not store user- or agent-specific memories.';
    }
    return participants
      .map((p) => `- ${p.name ?? 'Unknown'} (${p.handle ?? 'no handle'}): subject_id=${p.id}`)
      .join('\n');
  } catch (err) {
    log(`Failed to load participant subject map: ${err instanceof Error ? err.message : String(err)}`);
    return 'Participant subject map could not be loaded. Do not store user- or agent-specific memories.';
  }
}

const CONSOLIDATION_PROMPT = `You are now in memory consolidation mode. The conversation has ended.
Your job is to review what happened and manage long-term memories.

Today's date: __TODAY__

## CRITICAL RULES
- Do NOT send any chat messages (no mcp__nanoclaw__band_send_message calls)
- Do NOT call Band event, contact, participant, room, or peer tools
- Do NOT emit any <message to="..."> blocks — there is no user listening
- Only memory tools are available during this pass; other Band tools are blocked at runtime

## Participant Subject Map
__SUBJECT_MAP__

For any memory about a specific user or agent, call memory write tools with scope="subject" and the exact subject_id from this map. If the right subject_id is not present, do not store that user- or agent-specific memory. Use organization scope only for facts that are truly shared organization-level knowledge, not personal facts.

## Memory Systems
- **long_term/semantic**: General facts and preferences ("Prefers dark mode")
- **long_term/episodic**: Specific dated events ("Discussed project deadline on 2026-03-22")
- **long_term/procedural**: Behavioral patterns ("Usually asks follow-up questions about costs")

## Your Tasks
1. **ALWAYS call mcp__nanoclaw__band_list_memories() first** to see what's already stored
2. Compare the conversation that just ended against existing memories
3. Before each memory operation, reason internally about why the memory is useful; do not call event or chat tools for that reasoning
4. Consolidate memories:
   - Create new memories only for genuinely NEW information (mcp__nanoclaw__band_store_memory)
   - Supersede outdated memories when information has CHANGED (mcp__nanoclaw__band_supersede_memory)
   - Supersede duplicate memories — if you see multiple memories with the same info, keep only one
   - If information already exists (even with different wording) → do NOT create a duplicate
5. Use episodic for specific events (include dates), semantic for general facts/preferences
6. **If no new information**: Finish without calling any write tools

## Rules
- Only store genuinely useful information
- Include dates in episodic memories
- Keep memories concise (under 100 characters when possible)
- Your thought field should explain WHY this memory is useful
- Always add 2-5 lowercase hyphenated tags (e.g., "preferences", "scheduling", "decisions")
- Use segment="user" for info about the user, segment="agent" for self-knowledge
- Do NOT store raw conversation content (the platform already tracks messages)

After memory operations are complete, finish without calling chat or event tools.`;

export async function runMemoryConsolidation(args: {
  provider: AgentProvider;
  providerName: string;
  cwd: string;
  continuation: string | undefined;
}): Promise<void> {
  if (!shouldRun()) return;
  if (!args.continuation) {
    log('Skipped: no continuation — nothing to consolidate');
    return;
  }

  log('Running memory consolidation…');
  const today = new Date().toISOString().split('T')[0];
  const subjectMap = await loadSubjectMap();
  const prompt = CONSOLIDATION_PROMPT.replace('__TODAY__', today).replace('__SUBJECT_MAP__', subjectMap);

  const query = args.provider.query({
    prompt,
    continuation: args.continuation,
    cwd: args.cwd,
    env: { NANOCLAW_MEMORY_CONSOLIDATION_ACTIVE: 'true' },
    // No systemContext — the agent's existing system prompt has the destination
    // map and Band tool guidance baked in via CLAUDE.md. We override behavior
    // through the prompt itself ("do NOT send messages, do NOT emit <message>").
  });

  try {
    for await (const event of query.events) {
      if (event.type === 'error') {
        log(`Provider error during consolidation: ${event.message}`);
      } else if (event.type === 'result') {
        log(`Consolidation result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      }
      // Intentionally drain everything else without dispatch — no writes to
      // outbound.db. Tool-side memory writes happen inside the SDK MCP server
      // and persist via Band's REST API regardless of whether we route the
      // result text anywhere.
    }
    log('Consolidation complete');
  } catch (err) {
    log(`Consolidation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
