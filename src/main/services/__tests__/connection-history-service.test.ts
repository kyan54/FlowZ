import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  ConnectionHistoryService,
  aggregateHistoryEntries,
  normalizeHistoryRetentionDays,
  sanitizeHistoryEntry,
} from '../ConnectionHistoryService';
import type { ConnectionHistoryEntry } from '../../../shared/types';

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

function entry(over: Partial<ConnectionHistoryEntry> = {}): ConnectionHistoryEntry {
  return {
    key: 'session-1:c1',
    connectionId: 'c1',
    sessionId: 'session-1',
    startedAt: NOW - 60_000,
    observedAt: NOW - 60_000,
    active: true,
    domain: 'Example.COM',
    destinationIP: '1.2.3.4',
    destinationPort: '443',
    network: 'tcp',
    processPath: '/Applications/Browser.app/Contents/MacOS/Browser',
    rule: 'domain_suffix=example.com => route(proxy)',
    chains: ['US', 'proxy-selector'],
    outbound: 'US',
    outboundType: 'vless',
    upload: 0,
    download: 0,
    ...over,
  };
}

describe('ConnectionHistoryService', () => {
  let dir: string;
  let enabled = true;
  let retention: unknown = 1;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowz-conn-history-'));
    enabled = true;
    retention = 1;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const service = () =>
    new ConnectionHistoryService({
      directory: dir,
      isEnabled: () => enabled,
      retentionDays: () => retention,
      now: () => NOW,
    });

  it('默认/非法保留期归一到 1 天', () => {
    expect(normalizeHistoryRetentionDays(undefined)).toBe(1);
    expect(normalizeHistoryRetentionDays(2)).toBe(1);
    expect(normalizeHistoryRetentionDays(3)).toBe(3);
    expect(normalizeHistoryRetentionDays(7)).toBe(7);
  });

  it('关闭时不创建历史目录或文件', async () => {
    enabled = false;
    const s = service();
    await s.append([entry()]);
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it('OPEN/CLOSED 追加后按 key 取终态并聚合域名、出口、流量与进程', async () => {
    const s = service();
    await s.append([entry()]);
    await s.append([
      entry({
        active: false,
        endedAt: NOW - 10_000,
        observedAt: NOW - 10_000,
        upload: 1024,
        download: 2048,
      }),
    ]);

    const result = await s.query({
      from: NOW - 2 * 60_000,
      to: NOW,
      mode: 'proxy',
    });
    expect(result.totalConnections).toBe(1);
    expect(result.uniqueDestinations).toBe(1);
    expect(result.groups).toEqual([
      expect.objectContaining({
        destination: 'example.com',
        outbound: 'US',
        count: 1,
        upload: 1024,
        download: 2048,
        activeCount: 0,
        processes: ['/Applications/Browser.app/Contents/MacOS/Browser'],
      }),
    ]);
  });

  it('支持代理/直连、搜索和生命周期与时间窗相交过滤', async () => {
    const proxy = entry({ startedAt: NOW - 10 * 60_000, endedAt: NOW - 5 * 60_000, active: false });
    const direct = entry({
      key: 'session-1:c2',
      connectionId: 'c2',
      domain: 'direct.example',
      startedAt: NOW - 3 * 60_000,
      observedAt: NOW - 2 * 60_000,
      active: false,
      endedAt: NOW - 2 * 60_000,
      outbound: 'direct',
      outboundType: 'direct',
      chains: ['direct'],
      processPath: '/Applications/Mail.app/Contents/MacOS/Mail',
    });

    const proxyOnly = aggregateHistoryEntries(
      [proxy, direct],
      {
        from: NOW - 7 * 60_000,
        to: NOW,
        mode: 'proxy',
      },
      NOW
    );
    // proxy 在 from 前建立、但在窗口内仍存活，须命中。
    expect(proxyOnly.groups.map((g) => g.destination)).toEqual(['example.com']);

    const directOnly = aggregateHistoryEntries(
      [proxy, direct],
      {
        from: NOW - 60 * 60_000,
        to: NOW,
        mode: 'direct',
        search: 'mail.app',
      },
      NOW
    );
    expect(directOnly.groups.map((g) => g.destination)).toEqual(['direct.example']);
  });

  it('清除只删除历史 JSONL', async () => {
    const s = service();
    await s.append([entry()]);
    await fs.writeFile(path.join(dir, 'keep.txt'), 'keep');
    await s.clear();
    await expect(fs.readdir(dir)).resolves.toEqual(['keep.txt']);
  });

  it('保留期清理过期日文件', async () => {
    const old = path.join(dir, 'connections-2026-08-20.jsonl');
    const recent = path.join(dir, 'connections-2026-08-28.jsonl');
    await fs.writeFile(old, `${JSON.stringify(entry())}\n`);
    await fs.writeFile(recent, `${JSON.stringify(entry())}\n`);
    const oldDate = new Date(NOW - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(old, oldDate, oldDate);
    await service().prune();
    await expect(fs.readdir(dir)).resolves.toEqual(['connections-2026-08-28.jsonl']);
  });

  it('持久化边界清理控制字符、长度和负流量', () => {
    const cleaned = sanitizeHistoryEntry(
      entry({ domain: 'EXAMPLE.COM\n', upload: -1, download: Number.NaN })
    );
    expect(cleaned).toEqual(
      expect.objectContaining({ domain: 'example.com', upload: 0, download: 0 })
    );
  });
});
