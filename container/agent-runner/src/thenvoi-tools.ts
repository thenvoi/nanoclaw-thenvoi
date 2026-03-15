/**
 * Thenvoi platform tools for the container MCP server.
 * Uses the SDK's AgentTools + FernRestAdapter instead of raw fetch.
 * Registered when NANOCLAW_CHANNEL=thenvoi.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodTypeAny } from 'zod';
import { ThenvoiClient } from '@thenvoi/rest-client';
import { FernRestAdapter } from '@thenvoi/sdk/rest';
import {
  AgentTools,
  TOOL_MODELS,
  BASE_TOOL_NAMES,
  getToolDescription,
} from '@thenvoi/sdk/runtime';

interface ThenvoiConfig {
  restUrl: string;  // http://host.docker.internal:3001/thenvoi
  roomId: string;
  agentId: string;
}

/** Convert JSON Schema property to Zod validator (from SDK's mcp.ts pattern). */
function toZodValidator(schema: Record<string, unknown>): ZodTypeAny {
  const type = schema.type;
  if (type === 'string') {
    if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string')) {
      const values = schema.enum as string[];
      if (values.length > 0) return z.enum(values as [string, ...string[]]);
    }
    return z.string();
  }
  if (type === 'integer' || type === 'number') return z.number();
  if (type === 'boolean') return z.boolean();
  if (type === 'array') {
    const items = schema.items;
    if (items && typeof items === 'object') return z.array(toZodValidator(items as Record<string, unknown>));
    return z.array(z.unknown());
  }
  if (type === 'object') return z.record(z.string(), z.unknown());
  return z.unknown();
}

function toWireString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

export function registerThenvoiTools(server: McpServer, config: ThenvoiConfig): void {
  // Create SDK REST client chain: ThenvoiClient → FernRestAdapter → AgentTools
  // Ensure trailing slash so URL.join doesn't drop the /thenvoi path prefix
  const baseUrl = config.restUrl.endsWith('/') ? config.restUrl : config.restUrl + '/';
  const client = new ThenvoiClient({
    apiKey: 'placeholder', // Credential proxy injects the real key
    baseUrl,
  });
  const rest = new FernRestAdapter(client as any); // eslint-disable-line @typescript-eslint/no-explicit-any -- bind() wrappers widen method signatures
  const tools = new AgentTools({
    roomId: config.roomId,
    rest,
    capabilities: { peers: true, contacts: true, memory: false },
  });

  // Register each platform tool from the SDK's TOOL_MODELS
  const toolsToRegister = new Set(BASE_TOOL_NAMES);

  for (const toolName of toolsToRegister) {
    const model = TOOL_MODELS[toolName as keyof typeof TOOL_MODELS];
    if (!model) continue;

    // Build Zod schema from the model's JSON Schema properties
    const required = new Set<string>(model.required ?? []);
    const shape: Record<string, ZodTypeAny> = {};

    for (const [propName, propSchema] of Object.entries(model.properties)) {
      const validator = toZodValidator(propSchema as Record<string, unknown>);
      shape[propName] = required.has(propName) ? validator : validator.optional();
    }

    server.tool(
      toolName,
      getToolDescription(toolName),
      shape,
      async (args) => {
        try {
          const result = await tools.executeToolCall(toolName, args as Record<string, unknown>);

          // Check for structured tool errors
          if (result && typeof result === 'object' && 'ok' in result && (result as { ok: boolean }).ok === false) {
            const err = result as { message?: string };
            return {
              content: [{ type: 'text' as const, text: err.message ?? 'Tool execution failed' }],
              isError: true,
            };
          }

          return { content: [{ type: 'text' as const, text: toWireString(result) }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Tool ${toolName} failed: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    );
  }
}
