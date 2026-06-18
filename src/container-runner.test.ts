import { describe, expect, it } from 'vitest';

import { resolveProviderName, rewriteOneCliProxyArgs } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('rewriteOneCliProxyArgs', () => {
  it('rewrites OneCLI proxy host args for compose child containers', () => {
    const args = [
      'run',
      '-e',
      'HTTPS_PROXY=http://x:token@host.docker.internal:10255',
      '-e',
      'NO_PROXY=localhost,host.docker.internal',
      '--add-host=host.docker.internal:host-gateway',
    ];

    rewriteOneCliProxyArgs(args, 'onecli');

    expect(args).toContain('HTTPS_PROXY=http://x:token@onecli:10255');
    expect(args).toContain('NO_PROXY=localhost,host.docker.internal');
    expect(args).toContain('--add-host=host.docker.internal:host-gateway');
  });

  it('leaves args unchanged without a compose hostname', () => {
    const args = ['-e', 'HTTPS_PROXY=http://x:token@host.docker.internal:10255'];

    rewriteOneCliProxyArgs(args, undefined);

    expect(args).toEqual(['-e', 'HTTPS_PROXY=http://x:token@host.docker.internal:10255']);
  });
});
