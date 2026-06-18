import { describe, expect, it } from 'vitest';

import {
  getChannelContainerConfig,
  listChannelContainerConfigNames,
  registerChannelContainerConfig,
} from './channel-container-registry.js';
import type { MessagingGroup, Session } from '../types.js';

function session(): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function messagingGroup(): MessagingGroup {
  return {
    id: 'mg-1',
    channel_type: 'fake-channel-container',
    platform_id: 'fake:room-1',
    name: 'Fake Room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  };
}

describe('channel container registry', () => {
  it('registers session-aware channel container contributions', async () => {
    registerChannelContainerConfig('fake-channel-container', (ctx) => ({
      env: {
        CHANNEL_TYPE: ctx.messagingGroup?.channel_type ?? '',
        PLATFORM_ID: ctx.messagingGroup?.platform_id ?? '',
        AGENT_GROUP_ID: ctx.agentGroupId,
        SESSION_ID: ctx.session.id,
      },
    }));

    const fn = getChannelContainerConfig('fake-channel-container');
    expect(fn).toBeDefined();
    const contribution = await fn!({
      session: session(),
      messagingGroup: messagingGroup(),
      agentGroupId: 'ag-1',
      hostEnv: {},
    });

    expect(contribution.env).toEqual({
      CHANNEL_TYPE: 'fake-channel-container',
      PLATFORM_ID: 'fake:room-1',
      AGENT_GROUP_ID: 'ag-1',
      SESSION_ID: 'sess-1',
    });
    expect(listChannelContainerConfigNames()).toContain('fake-channel-container');
  });

  it('rejects duplicate registrations', () => {
    registerChannelContainerConfig('duplicate-channel-container', () => ({}));
    expect(() => registerChannelContainerConfig('duplicate-channel-container', () => ({}))).toThrow(
      'Channel container config already registered',
    );
  });
});
