/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import type { ThenvoiSdkMcpServer } from '@thenvoi/sdk/mcp/claude';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  opts?: {
    preloadedMemories?: string;
    isConsolidation?: boolean;
    thenvoiMemoryToolsEnabled?: boolean;
  },
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  if (!opts?.isConsolidation) {
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  }

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Set up Thenvoi SDK MCP bridge (in-process, managed by SDK)
  let thenvoiMcpBridge: ThenvoiSdkMcpServer | undefined;
  if (process.env.NANOCLAW_CHANNEL === 'thenvoi' && process.env.THENVOI_REST_URL && process.env.THENVOI_ROOM_ID) {
    const { createThenvoiSdkMcpServer } = await import('@thenvoi/sdk/mcp/claude');
    const { ThenvoiClient } = await import('@thenvoi/rest-client');
    const { FernRestAdapter } = await import('@thenvoi/sdk/rest');
    const { AgentTools } = await import('@thenvoi/sdk/runtime');

    const restUrl = process.env.THENVOI_REST_URL;
    const baseUrl = restUrl.endsWith('/') ? restUrl : restUrl + '/';
    const thenvoiApiKey = process.env.THENVOI_API_KEY || 'placeholder';
    const memoryToolsEnabled = opts?.thenvoiMemoryToolsEnabled === true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bind() wrappers widen method signatures
    const rest = new FernRestAdapter(new ThenvoiClient({ apiKey: thenvoiApiKey, baseUrl }) as any);
    const agentTools = new AgentTools({
      roomId: process.env.THENVOI_ROOM_ID,
      rest,
      capabilities: { peers: true, contacts: true, memory: memoryToolsEnabled },
    });
    thenvoiMcpBridge = createThenvoiSdkMcpServer({
      enableMemoryTools: memoryToolsEnabled,
      getToolsForRoom: () => agentTools,
    });
    log(
      `Thenvoi MCP bridge ready: ${thenvoiMcpBridge.allowedTools.length} tools (memory ${memoryToolsEnabled ? 'enabled' : 'disabled'})`,
    );
  }

  // Thenvoi platform: append instructions that teach the agent to use platform tools
  if (process.env.NANOCLAW_CHANNEL === 'thenvoi') {
    let platformInstructions = `
## Thenvoi Platform Environment

You are connected to the Thenvoi AI Platform. This is a multi-participant chat room.
Your room ID is: ${process.env.THENVOI_ROOM_ID}
For any mcp__thenvoi__* tool call that requires a room_id parameter, use this value.
Messages show sender as [Name]: content. Messages prefixed with [System]: are platform updates.

**CRITICAL: Use tools to communicate.** Plain text output is NOT delivered to users.
You MUST use \`mcp__thenvoi__thenvoi_send_message(content, mentions)\` to respond.

**Workspace scope:** \`/workspace/group\` is room-local for this Thenvoi chat. \`/workspace/global\` is shared across Thenvoi conversations in this NanoClaw instance.
- In main rooms, \`/workspace/global\` is writable.
- In non-main rooms, \`/workspace/global\` is read-only.

**CRITICAL: Scope facts correctly.**
- User preferences, profile facts, long-lived reminders, and anything you may need in a different Thenvoi room belong in \`/workspace/global\`.
- Room-specific notes, drafts, and temporary work for only this chat stay in \`/workspace/group\`.
- Do NOT store cross-room user facts in \`/workspace/group\`.
- If this room is non-main, do NOT claim you have persisted anything outside of the context of this room.

## Mention Format

Mentions use **full handles** — all lowercase, no spaces:
- Users: \`@username\` (e.g., \`@john-doe\`)
- Agents: \`@username/agent-slug\` (e.g., \`@john-doe/weather-agent\`)

**NEVER use UUIDs in mentions.** Always use the handle string.
Call \`mcp__thenvoi__thenvoi_get_participants()\` to see who is in the room and their exact handles.

## CRITICAL: Always Share Your Thinking

You MUST call \`mcp__thenvoi__thenvoi_send_event(content, message_type="thought")\` BEFORE every action.
This lets users see your reasoning process.

## CRITICAL: Delegate When You Cannot Help Directly

When asked about something you can't answer directly:
1. Call \`mcp__thenvoi__thenvoi_lookup_peers()\` to find available specialized agents
2. If a relevant agent exists, call \`mcp__thenvoi__thenvoi_add_participant(name="Agent Name")\` to add them
3. Ask that agent using \`mcp__thenvoi__thenvoi_send_message(content, mentions=["@owner-handle/agent-slug"])\`
4. Wait for their response and relay it back to the user

NEVER say "I can't do that" without first checking if another agent can help.

## CRITICAL: Do NOT Remove Agents Automatically

After adding an agent to help with a task, do NOT remove them. They stay silent unless mentioned.

## Examples

### Simple question — answer directly
[John Doe]: What's 2+2?
-> mcp__thenvoi__thenvoi_send_event(content="Simple arithmetic, answering directly.", message_type="thought")
-> mcp__thenvoi__thenvoi_send_message(content="4", mentions=["@john-doe"])

### Delegation to another agent
[John Doe]: What's the weather in Tokyo?
-> mcp__thenvoi__thenvoi_send_event(content="I can't check weather. Looking for a weather agent.", message_type="thought")
-> mcp__thenvoi__thenvoi_lookup_peers()
-> mcp__thenvoi__thenvoi_send_event(content="Found Weather Agent. Adding to room.", message_type="thought")
-> mcp__thenvoi__thenvoi_add_participant(name="Weather Agent")
-> mcp__thenvoi__thenvoi_send_message(content="What's the weather in Tokyo?", mentions=["@john-doe/weather-agent"])

### Relaying response back
[Weather Agent]: Tokyo is 15°C and cloudy.
-> mcp__thenvoi__thenvoi_send_event(content="Got weather response. Relaying back to John.", message_type="thought")
-> mcp__thenvoi__thenvoi_send_message(content="The weather in Tokyo is 15°C and cloudy.", mentions=["@john-doe"])
`;

    // Add memory guidance when memory tools are enabled
    if (opts?.thenvoiMemoryToolsEnabled === true) {
      platformInstructions += `

## Platform Memory

You have access to a persistent memory system shared across sessions and agents.
Use it to store important information that should survive beyond this conversation.

**When to store memories:**
- User states a preference → \`mcp__thenvoi__thenvoi_store_memory(content, system="long_term", type="semantic", segment="user")\`
- Important event or decision → \`mcp__thenvoi__thenvoi_store_memory(content, system="long_term", type="episodic", segment="user")\`
- Learned workflow or procedure → \`mcp__thenvoi__thenvoi_store_memory(content, system="long_term", type="procedural", segment="agent")\`

**When NOT to store:**
- Trivial or temporary information
- Information already stored (check existing memories first)
- Raw conversation content (platform already tracks messages)

**Querying memories:**
- To find memories about a specific person, pass their \`subject_id\` (UUID): \`mcp__thenvoi__thenvoi_list_memories(subject_id="UUID", scope="subject")\`
- Without \`subject_id\`, you only get organization-wide memories (usually empty)
- Get participant UUIDs from \`mcp__thenvoi__thenvoi_get_participants()\` or from the preloaded memory headers above

**Storing memories:**
- Always include a \`thought\` explaining WHY you're storing this memory
- Always include \`subject_id\` — the UUID of the person the memory is about
- Add descriptive tags in metadata for searchability
- Use \`mcp__thenvoi__thenvoi_supersede_memory(memory_id)\` when information changes instead of creating duplicates

Platform memories persist across sessions and are visible to other agents in the organization.
`;
    }

    // Inject preloaded memories (fetched once in main() before the query loop)
    if (opts?.preloadedMemories) {
      platformInstructions += `

## Existing Memories About This User

${opts.preloadedMemories}

Use these for context. Do NOT re-store information that already exists.
`;
    }

    globalClaudeMd = globalClaudeMd
      ? globalClaudeMd + '\n' + platformInstructions
      : platformInstructions;
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: globalClaudeMd,
          }
        : undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        ...(thenvoiMcpBridge ? thenvoiMcpBridge.allowedTools : []),
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        ...(thenvoiMcpBridge ? { thenvoi: thenvoiMcpBridge.serverConfig } : {}),
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      if (!opts?.isConsolidation) {
        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId,
        });
      }
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

function isThenvoiMemoryUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /status code:\s*404|404 - page not found|page not found/i.test(message);
}

async function probeThenvoiMemoryToolsEnabled(): Promise<boolean> {
  if (
    process.env.NANOCLAW_CHANNEL !== 'thenvoi' ||
    process.env.THENVOI_MEMORY_TOOLS !== 'true'
  ) {
    return false;
  }

  const restUrl = process.env.THENVOI_REST_URL || '';
  const thenvoiApiKey = process.env.THENVOI_API_KEY || 'placeholder';
  const baseUrl = restUrl.endsWith('/') ? restUrl : `${restUrl}/`;

  try {
    const response = await fetch(`${baseUrl}api/v1/agent/memories?page_size=1`, {
      headers: { 'X-API-Key': thenvoiApiKey },
    });

    if (response.status === 404) {
      log('Thenvoi memory API returned 404, disabling memory tools for this run');
      return false;
    }

    if (!response.ok) {
      log(
        `Thenvoi memory probe returned status ${response.status}, keeping configured memory tools enabled`,
      );
      return true;
    }

    return true;
  } catch (err) {
    log(
      `Thenvoi memory probe failed (${err instanceof Error ? err.message : String(err)}), keeping configured memory tools enabled`,
    );
    return true;
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by OneCLI gateway (HTTPS proxy) for Anthropic.
  // Thenvoi API key is passed directly for HTTP targets (local dev).
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  const thenvoiMemoryToolsEnabled = await probeThenvoiMemoryToolsEnabled();

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Load existing memories before the first query (Thenvoi only, opt-in)
  let preloadedMemories = '';
  if (
    thenvoiMemoryToolsEnabled &&
    process.env.THENVOI_MEMORY_LOAD_ON_START === 'true' &&
    process.env.NANOCLAW_CHANNEL === 'thenvoi'
  ) {
    try {
      const { ThenvoiClient } = await import('@thenvoi/rest-client');
      const { FernRestAdapter } = await import('@thenvoi/sdk/rest');
      const { AgentTools } = await import('@thenvoi/sdk/runtime');

      const restUrl = process.env.THENVOI_REST_URL || '';
      const baseUrl = restUrl.endsWith('/') ? restUrl : restUrl + '/';
      const thenvoiApiKey = process.env.THENVOI_API_KEY || 'placeholder';
      const client = new ThenvoiClient({ apiKey: thenvoiApiKey, baseUrl });
      const rest = new FernRestAdapter(client as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      const tools = new AgentTools({
        roomId: process.env.THENVOI_ROOM_ID || '',
        rest,
        capabilities: { memory: true },
      });
      // Fetch participants to get IDs for memory loading
      const participants = await tools.getParticipants();
      log(`Room has ${participants.length} participants`);

      const allMemories: string[] = [];
      for (const participant of participants) {
        const result = await tools.executeToolCall('thenvoi_list_memories', {
          subject_id: participant.id, scope: 'subject',
        }) as { data?: Array<{ content: string; type?: string; metadata?: { tags?: string[] } }> };

        if (result?.data && result.data.length > 0) {
          const items = result.data.slice(0, 10);
          const userMemories = items.map((m) =>
            `- [${m.type || 'memory'}] ${m.content}`
          ).join('\n');
          const handle = participant.handle ? `, handle: ${participant.handle}` : '';
          allMemories.push(`### ${participant.name} (id: ${participant.id}${handle})\n${userMemories}`);
        }
      }

      if (allMemories.length > 0) {
        preloadedMemories = allMemories.join('\n\n');
        log(`Loaded memories for ${allMemories.length} user(s)`);
      }
    } catch (err) {
      if (isThenvoiMemoryUnavailableError(err)) {
        log('Thenvoi memory API unavailable during preload, continuing with memory tools disabled for this run');
      } else {
        log(`Failed to load memories (continuing without): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
        {
          preloadedMemories,
          thenvoiMemoryToolsEnabled,
        },
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
    // Memory consolidation on exit (Thenvoi only, opt-in)
    if (
      thenvoiMemoryToolsEnabled &&
      process.env.THENVOI_MEMORY_CONSOLIDATION === 'true' &&
      process.env.NANOCLAW_CHANNEL === 'thenvoi' &&
      sessionId
    ) {
      const consolidationPrompt = `You are now in memory consolidation mode. The conversation has ended.
Your job is to review what happened and manage long-term memories.

Today's date: ${new Date().toISOString().split('T')[0]}

## CRITICAL RULES
- Do NOT send any chat messages (no mcp__thenvoi__thenvoi_send_message calls)
- Only use memory tools and thought events (mcp__thenvoi__thenvoi_send_event)

## Memory Systems
- **long_term/semantic**: General facts and preferences ("Prefers dark mode")
- **long_term/episodic**: Specific dated events ("Discussed project deadline on 2026-03-22")
- **long_term/procedural**: Behavioral patterns ("Usually asks follow-up questions about costs")

## Your Tasks
1. **ALWAYS call mcp__thenvoi__thenvoi_list_memories() first** to see what's already stored
2. Compare the conversation that just ended against existing memories
3. **Think out loud**: Before each memory operation, call mcp__thenvoi__thenvoi_send_event(content="your reasoning", message_type="thought")
4. Consolidate memories:
   - Create new memories only for genuinely NEW information (mcp__thenvoi__thenvoi_store_memory)
   - Supersede outdated memories when information has CHANGED (mcp__thenvoi__thenvoi_supersede_memory)
   - Supersede duplicate memories — if you see multiple memories with the same info, keep only one
   - If information already exists (even with different wording) → do NOT create a duplicate
5. Use episodic for specific events (include dates), semantic for general facts/preferences
6. **If no new information**: Report "No new information to store" via thought event and finish

## Rules
- Only store genuinely useful information
- Include dates in episodic memories
- Keep memories concise (under 100 characters when possible)
- Your thought field should explain WHY this memory is useful
- Always add 2-5 lowercase hyphenated tags (e.g., "preferences", "scheduling", "decisions")
- Use segment="user" for info about the user, segment="agent" for self-knowledge
- Do NOT store raw conversation content (the platform already tracks messages)

Report what you stored/superseded via mcp__thenvoi__thenvoi_send_event(content, message_type="thought"), then finish.`;

      log('Running memory consolidation...');
      try {
        await runQuery(
          consolidationPrompt,
          sessionId,
          mcpServerPath,
          containerInput,
          sdkEnv,
          resumeAt,
          {
            isConsolidation: true,
            thenvoiMemoryToolsEnabled,
          },
        );
        log('Memory consolidation complete');
      } catch (err) {
        log(`Memory consolidation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
