import type { MessagingGroup, Session } from '../types.js';
import type { ProviderContainerContribution } from '../providers/provider-container-registry.js';

export interface ChannelContainerContext {
  session: Session;
  messagingGroup: MessagingGroup | null;
  agentGroupId: string;
  hostEnv: NodeJS.ProcessEnv;
}

export type ChannelContainerConfigFn = (
  ctx: ChannelContainerContext,
) => ProviderContainerContribution | Promise<ProviderContainerContribution>;

const registry = new Map<string, ChannelContainerConfigFn>();

export function registerChannelContainerConfig(channelType: string, fn: ChannelContainerConfigFn): void {
  if (registry.has(channelType)) {
    throw new Error(`Channel container config already registered: ${channelType}`);
  }
  registry.set(channelType, fn);
}

export function getChannelContainerConfig(channelType: string): ChannelContainerConfigFn | undefined {
  return registry.get(channelType);
}

export function listChannelContainerConfigNames(): string[] {
  return [...registry.keys()];
}
