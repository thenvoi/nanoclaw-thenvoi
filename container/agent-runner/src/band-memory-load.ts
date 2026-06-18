/**
 * Band.ai memory pre-load.
 *
 * When `BAND_MEMORY_LOAD_ON_START=true` and the channel is `band`,
 * fetch each room participant's stored memories via the SDK and format them
 * into a markdown block to append to the system prompt addendum. This gives
 * the agent context about who they're talking to from the very first turn,
 * before any tool calls would have a chance to surface it.
 *
 * Failure is non-fatal — the room can still function without preloaded memory.
 */

function log(msg: string): void {
  console.error(`[band-memory-load] ${msg}`);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

interface MemoryItem {
  content?: string;
  type?: string;
}

function shouldLoad(): boolean {
  return (
    (process.env.BAND_MEMORY_TOOLS === 'true' || process.env.THENVOI_MEMORY_TOOLS === 'true') &&
    (process.env.BAND_MEMORY_LOAD_ON_START === 'true' || process.env.THENVOI_MEMORY_LOAD_ON_START === 'true') &&
    (process.env.NANOCLAW_CHANNEL === 'band' || process.env.NANOCLAW_CHANNEL === 'thenvoi')
  );
}

export async function loadParticipantMemories(): Promise<string> {
  if (!shouldLoad()) return '';

  const agentId = env('BAND_AGENT_ID') ?? env('THENVOI_AGENT_ID');
  const roomId = env('BAND_ROOM_ID') ?? env('THENVOI_ROOM_ID');
  if (!agentId || !roomId) {
    log('Skipped: BAND_AGENT_ID or BAND_ROOM_ID missing');
    return '';
  }

  try {
    const { ThenvoiLink } = await import('@thenvoi/sdk');
    const { AgentTools } = await import('@thenvoi/sdk/runtime');

    const link = new ThenvoiLink({
      agentId,
      apiKey: env('BAND_API_KEY') ?? env('THENVOI_API_KEY') ?? env('ONECLI_API_KEY') ?? '',
      restUrl: env('BAND_REST_URL') ?? env('THENVOI_REST_URL'),
    });
    const tools = new AgentTools({
      roomId,
      rest: link.rest,
      capabilities: { memory: true },
    });

    const participants = await tools.getParticipants();
    log(`Room has ${participants.length} participant(s)`);

    const blocks: string[] = [];
    for (const p of participants) {
      try {
        const result = (await tools.executeToolCall('thenvoi_list_memories', {
          subject_id: p.id,
          scope: 'subject',
        })) as { data?: MemoryItem[] };

        const items = (result?.data ?? []).slice(0, 10);
        if (items.length === 0) continue;

        const handle = p.handle ?? 'unknown';
        const lines = items.map((m) => `- [${m.type ?? 'memory'}] ${m.content ?? ''}`).join('\n');
        blocks.push(`### ${p.name} (id: ${p.id}, handle: ${handle})\n${lines}`);
      } catch (err) {
        log(`Memory fetch failed for ${p.name} (${p.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (blocks.length === 0) {
      log('No stored memories for any participant');
      return '';
    }

    log(`Loaded memories for ${blocks.length} participant(s)`);
    return [
      '## Existing Memories About Room Participants',
      '',
      'Use these for context. Do NOT re-store information that already exists.',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  } catch (err) {
    log(`Failed to load memories (continuing without): ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}
