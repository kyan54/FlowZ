const registered = new Map<string, (event: unknown, args: any) => unknown>();

jest.mock('../../ipc-handler', () => ({
  registerIpcHandler: (channel: string, handler: (event: unknown, args: any) => unknown) => {
    registered.set(channel, handler);
  },
}));

import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import { registerConnectionHistoryHandlers } from '../connection-history-handlers';

describe('connection history IPC handlers', () => {
  beforeEach(() => registered.clear());

  it('configure 一次落盘设置、清理过期文件并即时重算 worker demand', async () => {
    const config: any = { servers: [], connectionHistoryEnabled: false };
    const service: any = {
      getSettings: jest.fn(() => ({ enabled: true, retentionDays: 3 })),
      prune: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
      clear: jest.fn(),
    };
    const configManager: any = {
      loadConfig: jest.fn().mockResolvedValue(config),
      saveConfig: jest.fn().mockResolvedValue(undefined),
    };
    const statsHost: any = { syncDemand: jest.fn() };
    registerConnectionHistoryHandlers(service, configManager, statsHost);

    const handler = registered.get(IPC_CHANNELS.CONNECTION_HISTORY_CONFIGURE)!;
    await expect(handler({}, { enabled: true, retentionDays: 3 })).resolves.toEqual({
      enabled: true,
      retentionDays: 3,
    });
    expect(configManager.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionHistoryEnabled: true,
        connectionHistoryRetentionDays: 3,
      })
    );
    expect(service.prune).toHaveBeenCalled();
    expect(statsHost.syncDemand).toHaveBeenCalled();
  });

  it('query/clear 原样转交 service', async () => {
    const result = { groups: [], totalConnections: 0, uniqueDestinations: 0, truncated: false };
    const service: any = {
      getSettings: () => ({ enabled: false, retentionDays: 1 }),
      prune: jest.fn(),
      query: jest.fn().mockResolvedValue(result),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    registerConnectionHistoryHandlers(
      service,
      { loadConfig: jest.fn(), saveConfig: jest.fn() } as any,
      { syncDemand: jest.fn() } as any
    );
    const query = { from: 1, to: 2, mode: 'proxy' };
    await expect(
      registered.get(IPC_CHANNELS.CONNECTION_HISTORY_QUERY)!({}, query)
    ).resolves.toEqual(result);
    expect(service.query).toHaveBeenCalledWith(query);
    await expect(
      registered.get(IPC_CHANNELS.CONNECTION_HISTORY_CLEAR)!({}, undefined)
    ).resolves.toEqual({ ok: true });
    expect(service.clear).toHaveBeenCalled();
  });
});
