export const MAIN_CONTROL_ROOM_FOLDER = 'thenvoi_main_room';

export function isThenvoiMainControlRoom(groupFolder: string): boolean {
  return groupFolder === MAIN_CONTROL_ROOM_FOLDER;
}

type ThenvoiToolExecutor = {
  executeToolCall(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<unknown>;
  addParticipant(name: string, role?: string): Promise<unknown>;
  [key: string]: unknown;
};

export function createThenvoiToolsProxy<T extends ThenvoiToolExecutor>(
  tools: T,
  opts: { blockParticipantAdds: boolean },
): T {
  if (!opts.blockParticipantAdds) return tools;

  return new Proxy(tools, {
    get(target, prop, receiver) {
      if (prop === 'addParticipant') {
        return async () => {
          throw new Error(
            'Cannot add participants in the Thenvoi main control room',
          );
        };
      }
      if (prop === 'executeToolCall') {
        return async (
          toolName: string,
          toolArgs: Record<string, unknown> | undefined,
        ) => {
          if (toolName === 'thenvoi_add_participant') {
            throw new Error(
              'Cannot add participants in the Thenvoi main control room',
            );
          }
          return target.executeToolCall(toolName, toolArgs ?? {});
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T;
}
