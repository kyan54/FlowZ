import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-config-conn-history-'));

jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ConfigManager } from '../ConfigManager';
import type { UserConfig } from '../../../shared/types';

function makeConfig(enabled: unknown, retention: unknown): UserConfig {
  return {
    subscriptions: [],
    servers: [],
    selectedServerId: null,
    proxyMode: 'smart',
    proxyModeType: 'systemProxy',
    mixedPort: 7890,
    tunConfig: { mtu: 1350, stack: 'system', autoRoute: true, strictRoute: true },
    customRules: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    logLevel: 'info',
    dnsConfig: { domesticDns: '', foreignDns: '', enableFakeIp: false },
    connectionHistoryEnabled: enabled,
    connectionHistoryRetentionDays: retention,
  } as unknown as UserConfig;
}

describe('connection history config sanitize + defaults', () => {
  const cm = new ConfigManager(path.join(TMP, 'config.json'));

  it('显式 boolean + 1/3/7 天原样保留', () => {
    for (const days of [1, 3, 7] as const) {
      const cfg = makeConfig(true, days);
      cm.validateConfig(cfg);
      expect(cfg.connectionHistoryEnabled).toBe(true);
      expect(cfg.connectionHistoryRetentionDays).toBe(days);
    }
  });

  it('非法开关回退 false、非法保留期回退 1', () => {
    const cfg = makeConfig('yes', 30);
    cm.validateConfig(cfg);
    expect(cfg.connectionHistoryEnabled).toBe(false);
    expect(cfg.connectionHistoryRetentionDays).toBe(1);
  });

  it('存量配置缺字段保持 undefined，由读取端按关闭/1天解释', () => {
    const cfg = makeConfig(undefined, undefined);
    cm.validateConfig(cfg);
    expect(cfg.connectionHistoryEnabled).toBeUndefined();
    expect(cfg.connectionHistoryRetentionDays).toBeUndefined();
  });

  it('新装默认关闭并保留 1 天', () => {
    const cfg = (cm as unknown as { createDefaultConfig: () => UserConfig }).createDefaultConfig();
    expect(cfg.connectionHistoryEnabled).toBe(false);
    expect(cfg.connectionHistoryRetentionDays).toBe(1);
  });
});
