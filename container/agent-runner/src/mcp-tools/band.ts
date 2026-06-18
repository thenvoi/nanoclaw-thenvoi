import { ThenvoiLink } from '@thenvoi/sdk';
import { AgentTools } from '@thenvoi/sdk/runtime';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentToolsProtocol } from '@thenvoi/sdk';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const BAND_TOOL_REGISTRY = [
  { sdkName: 'thenvoi_send_message', bandName: 'band_send_message' },
  { sdkName: 'thenvoi_send_event', bandName: 'band_send_event' },
  { sdkName: 'thenvoi_get_participants', bandName: 'band_get_participants' },
  { sdkName: 'thenvoi_add_participant', bandName: 'band_add_participant' },
  { sdkName: 'thenvoi_remove_participant', bandName: 'band_remove_participant' },
  { sdkName: 'thenvoi_lookup_peers', bandName: 'band_lookup_peers' },
  { sdkName: 'thenvoi_create_chatroom', bandName: 'band_create_chatroom' },
  { sdkName: 'thenvoi_list_contacts', bandName: 'band_list_contacts' },
  { sdkName: 'thenvoi_add_contact', bandName: 'band_add_contact' },
  { sdkName: 'thenvoi_remove_contact', bandName: 'band_remove_contact' },
  { sdkName: 'thenvoi_list_contact_requests', bandName: 'band_list_contact_requests' },
  { sdkName: 'thenvoi_respond_contact_request', bandName: 'band_respond_contact_request' },
  { sdkName: 'thenvoi_list_memories', bandName: 'band_list_memories' },
  { sdkName: 'thenvoi_store_memory', bandName: 'band_store_memory' },
  { sdkName: 'thenvoi_get_memory', bandName: 'band_get_memory' },
  { sdkName: 'thenvoi_supersede_memory', bandName: 'band_supersede_memory' },
  { sdkName: 'thenvoi_archive_memory', bandName: 'band_archive_memory' },
] as const;

type BandToolRegistryEntry = (typeof BAND_TOOL_REGISTRY)[number];
type SdkToolName = BandToolRegistryEntry['sdkName'];

const BAND_TOOL_BY_SDK_NAME = new Map<string, BandToolRegistryEntry>(
  BAND_TOOL_REGISTRY.map((entry) => [entry.sdkName, entry]),
);
const BAND_TOOL_BY_MCP_NAME = new Map<string, BandToolRegistryEntry>(
  BAND_TOOL_REGISTRY.map((entry) => [entry.bandName, entry]),
);

const MUTATION_TOOLS_BLOCKED_IN_MAIN_ROOM = new Set<SdkToolName>([
  'thenvoi_add_participant',
  'thenvoi_remove_participant',
  'thenvoi_create_chatroom',
]);

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

// BAND_* is canonical post-rename; THENVOI_* is honored as a legacy fallback
// so containers spawned by an older host keep working.
function bandEnv(suffix: string): string | undefined {
  return env(`BAND_${suffix}`) ?? env(`THENVOI_${suffix}`);
}

function bandEnvPresent(): boolean {
  return Boolean(bandEnv('ROOM_ID') && bandEnv('AGENT_ID') && bandEnv('REST_URL'));
}

function roomId(): string {
  return bandEnv('ROOM_ID')!;
}

function mainControlRoom(): boolean {
  return bandEnv('IS_MAIN_CONTROL_ROOM') === 'true';
}

function memoryToolsEnabled(): boolean {
  return bandEnv('MEMORY_TOOLS') === 'true' && !memoryDisabledForRun;
}

function consolidationMode(): boolean {
  return env('NANOCLAW_MEMORY_CONSOLIDATION_ACTIVE') === 'true';
}

function isMemoryTool(sdkToolName: SdkToolName): boolean {
  return sdkToolName.includes('memory') || sdkToolName.includes('memories');
}

let cachedTools: AgentToolsProtocol | null = null;
let memoryDisabledForRun = false;

function apiKey(): string {
  return bandEnv('API_KEY') ?? env('ONECLI_API_KEY') ?? '';
}

function restUrl(): string | undefined {
  return bandEnv('REST_URL');
}

function sdkTools(): AgentToolsProtocol {
  if (cachedTools) return cachedTools;

  const link = new ThenvoiLink({
    agentId: bandEnv('AGENT_ID')!,
    apiKey: apiKey(),
    restUrl: restUrl(),
  });
  cachedTools = new AgentTools({
    roomId: roomId(),
    rest: link.rest,
    capabilities: {
      peers: true,
      contacts: true,
      memory: memoryToolsEnabled(),
    },
  }).getAdapterTools();
  return cachedTools;
}

function toBandToolName(sdkToolName: SdkToolName): string {
  return BAND_TOOL_BY_SDK_NAME.get(sdkToolName)!.bandName;
}

function toSdkToolName(bandToolName: string): SdkToolName | null {
  return BAND_TOOL_BY_MCP_NAME.get(bandToolName)?.sdkName ?? null;
}

function formatToolResult(result: unknown): CallToolResult {
  if (isSdkToolError(result)) {
    return {
      content: [{ type: 'text', text: result.legacyMessage ?? result.message ?? JSON.stringify(result) }],
      isError: true,
    };
  }

  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function isSdkToolError(value: unknown): value is { message?: string; legacyMessage?: string; errorType?: string } {
  return Boolean(value && typeof value === 'object' && 'errorType' in value);
}

function isUnavailableMemoryResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as { status?: unknown; errorType?: unknown; message?: unknown; legacyMessage?: unknown };
  const haystack = [result.status, result.errorType, result.message, result.legacyMessage]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  return haystack.includes('404') || haystack.includes('not found') || haystack.includes('unsupported');
}

function memoryDisabledResult(toolName: SdkToolName): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `${toBandToolName(toolName)} is disabled because the Band.ai memory API is unavailable for this run.`,
      },
    ],
    isError: true,
  };
}

function blockedDuringConsolidation(sdkToolName: SdkToolName): CallToolResult | null {
  if (!consolidationMode() || isMemoryTool(sdkToolName)) return null;
  return {
    content: [
      {
        type: 'text',
        text: `${toBandToolName(sdkToolName)} is blocked during Band.ai memory consolidation. Only memory tools are available in this mode.`,
      },
    ],
    isError: true,
  };
}

function blockedInMainRoom(sdkToolName: SdkToolName): CallToolResult | null {
  if (!mainControlRoom() || !MUTATION_TOOLS_BLOCKED_IN_MAIN_ROOM.has(sdkToolName)) return null;
  return {
    content: [
      {
        type: 'text',
        text: `${toBandToolName(sdkToolName)} is blocked in the Band.ai main control room. Use a regular Band room for participant or room mutations.`,
      },
    ],
    isError: true,
  };
}

function normalizeDescription(description: unknown, registryEntry: BandToolRegistryEntry): string {
  const text = typeof description === 'string' ? description : 'Band.ai platform tool.';
  return text.replace(/Thenvoi/g, 'Band.ai').replaceAll(registryEntry.sdkName, registryEntry.bandName);
}

function sdkSchemaToMcpTool(schema: Record<string, unknown>): Tool | null {
  const sdkName = typeof schema.name === 'string' ? schema.name : undefined;
  const registryEntry = sdkName ? BAND_TOOL_BY_SDK_NAME.get(sdkName) : undefined;
  const inputSchema = schema.input_schema && typeof schema.input_schema === 'object' ? schema.input_schema : undefined;
  if (!registryEntry || !inputSchema) return null;

  return {
    name: registryEntry.bandName,
    description: normalizeDescription(schema.description, registryEntry),
    inputSchema: inputSchema as Tool['inputSchema'],
  };
}

function buildBandToolDefinitions(): McpToolDefinition[] {
  const tools = sdkTools();
  const schemas = tools.getAnthropicToolSchemas({ includeMemory: memoryToolsEnabled() });

  return schemas.flatMap((schema) => {
    const tool = sdkSchemaToMcpTool(schema);
    if (!tool) return [];

    const sdkToolName = toSdkToolName(tool.name);
    if (!sdkToolName) return [];
    return [
      {
        tool,
        async handler(args) {
          const consolidationBlocked = blockedDuringConsolidation(sdkToolName);
          if (consolidationBlocked) return consolidationBlocked;
          const blocked = blockedInMainRoom(sdkToolName);
          if (blocked) return blocked;
          if (isMemoryTool(sdkToolName) && memoryDisabledForRun) return memoryDisabledResult(sdkToolName);
          const result = await sdkTools().executeToolCall(sdkToolName, args);
          if (isMemoryTool(sdkToolName) && isUnavailableMemoryResult(result)) {
            memoryDisabledForRun = true;
            return memoryDisabledResult(sdkToolName);
          }
          return formatToolResult(result);
        },
      },
    ];
  });
}

if (bandEnvPresent()) {
  registerTools(buildBandToolDefinitions());
}
