/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';
import { loadParticipantMemories } from './band-memory-load.js';
import { runMemoryConsolidation } from './band-memory-consolidate.js';
import { getContinuation } from './db/session-state.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Per-group
  // memory lives in /workspace/agent/CLAUDE.local.md (auto-loaded).
  let instructions = buildSystemPromptAddendum(config.assistantName || undefined);

  // Band.ai memory pre-load (no-op when not Band or when feature is off).
  // Appended once at startup so the agent has participant context from the
  // first turn instead of needing to call list_memories itself.
  const memoryBlock = await loadParticipantMemories();
  if (memoryBlock) {
    instructions = `${instructions}\n\n${memoryBlock}`;
  }

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  const mcpEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

  // Build MCP servers config: nanoclaw built-in + any from container.json.
  // The built-in server is a subprocess of the provider, so it needs the same
  // container env as the runner for channel-provided tools (Band/Thenvoi, etc.)
  // to register and for OneCLI proxy variables to reach SDK REST calls.
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: mcpEnv,
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  // Graceful shutdown: when the host stops the container (SIGTERM from
  // `docker stop`), abort the poll loop so the in-flight query can wind
  // down cleanly. After the loop returns, Band.ai consolidation runs
  // (no-op when not enabled) before the process exits.
  const shutdown = new AbortController();
  let shuttingDown = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${sig} — aborting poll loop`);
    shutdown.abort();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
    signal: shutdown.signal,
  });

  // Post-loop hooks. Continuation is read fresh from outbound.db — the loop
  // persists it on every `init` event, so this picks up the latest session id.
  const continuation = getContinuation(providerName);
  await runMemoryConsolidation({
    provider,
    providerName,
    cwd: CWD,
    continuation,
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
