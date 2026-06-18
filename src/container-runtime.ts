/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { type ChildProcess, execSync, spawn } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/**
 * Stop a container by name. Uses execFileSync to avoid shell injection.
 *
 * `timeoutSec` is forwarded as `docker stop -t` — the runtime sends SIGTERM,
 * waits up to that many seconds for the entrypoint to exit, then SIGKILLs.
 * Default 1s matches the historical behavior; bump it when the container
 * needs to do real work in its SIGTERM handler (e.g. Band.ai memory
 * consolidation).
 */
export function stopContainer(name: string, timeoutSec: number = 1): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  if (!Number.isInteger(timeoutSec) || timeoutSec < 0) {
    throw new Error(`Invalid stop timeout: ${timeoutSec}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t ${timeoutSec} ${name}`, { stdio: 'pipe' });
}

/**
 * Fire-and-forget variant: spawns `docker stop` detached and returns
 * immediately, so a long shutdown grace period (e.g. for Band.ai memory
 * consolidation) doesn't block the host's sweep loop. The runtime still
 * SIGTERMs first, waits up to `timeoutSec`, then SIGKILLs.
 */
export function stopContainerAsync(name: string, timeoutSec: number): ChildProcess {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  if (!Number.isInteger(timeoutSec) || timeoutSec < 0) {
    throw new Error(`Invalid stop timeout: ${timeoutSec}`);
  }
  const child = spawn(CONTAINER_RUNTIME_BIN, ['stop', '-t', String(timeoutSec), name], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return child;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
