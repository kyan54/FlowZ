import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type {
  ConnectionHistoryQuery,
  ConnectionHistoryQueryResult,
  ConnectionHistorySettings,
  UserConfig,
} from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import type { ConfigManager } from '../../services/ConfigManager';
import {
  ConnectionHistoryService,
  normalizeHistoryRetentionDays,
} from '../../services/ConnectionHistoryService';
import type { StatsHost } from '../../services/StatsWorkerHost';

/** 历史配置用专用 IPC 落盘：不广播全局 CONFIG_CHANGED，避免纯观测开关误触发核重启。 */
export function registerConnectionHistoryHandlers(
  service: ConnectionHistoryService,
  configManager: ConfigManager,
  statsHost: StatsHost
): void {
  registerIpcHandler<void, ConnectionHistorySettings>(
    IPC_CHANNELS.CONNECTION_HISTORY_GET_SETTINGS,
    () => service.getSettings()
  );

  registerIpcHandler<ConnectionHistorySettings, ConnectionHistorySettings>(
    IPC_CHANNELS.CONNECTION_HISTORY_CONFIGURE,
    async (_event: IpcMainInvokeEvent, args) => {
      const config = await configManager.loadConfig();
      config.connectionHistoryEnabled = args?.enabled === true;
      config.connectionHistoryRetentionDays = normalizeHistoryRetentionDays(args?.retentionDays);
      await configManager.saveConfig(config as UserConfig);
      await service.prune();
      statsHost.syncDemand();
      return service.getSettings();
    }
  );

  registerIpcHandler<ConnectionHistoryQuery, ConnectionHistoryQueryResult>(
    IPC_CHANNELS.CONNECTION_HISTORY_QUERY,
    (_event: IpcMainInvokeEvent, query) => service.query(query)
  );

  registerIpcHandler<void, { ok: boolean }>(IPC_CHANNELS.CONNECTION_HISTORY_CLEAR, async () => {
    await service.clear();
    return { ok: true };
  });
}
