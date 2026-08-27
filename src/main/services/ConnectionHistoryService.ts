/**
 * 结构化连接历史：按 UTC 日追加 JSONL，查询时按 key 取最后快照并聚合。
 *
 * 设计边界：
 * - 默认关闭；只记域名/IP、出口、规则、进程路径与流量，不记请求内容/source IP/密钥。
 * - 同连接 NEW/CLOSED 各追加一条，不原地改大文件；查询按 key 去重得最终态。
 * - 保留期只允许 1/3/7 天；单日文件硬上限 32 MiB，防连接风暴撑满磁盘。
 * - 所有 IO 走单串行队列，clear/query/append 不互相踩文件。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  ConnectionHistoryEntry,
  ConnectionHistoryGroup,
  ConnectionHistoryQuery,
  ConnectionHistoryQueryResult,
  ConnectionHistorySettings,
} from '../../shared/types';
import { getConnectionHistoryPath } from '../utils/paths';

const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_RE = /^connections-\d{4}-\d{2}-\d{2}\.jsonl$/;
const MAX_DAILY_BYTES = 32 * 1024 * 1024;
const MAX_QUERY_RECORDS = 100_000;
const DEFAULT_GROUP_LIMIT = 2_000;
const MAX_GROUP_LIMIT = 5_000;

export function normalizeHistoryRetentionDays(value: unknown): 1 | 3 | 7 {
  return value === 3 || value === 7 ? value : 1;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const out = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : char;
  })
    .join('')
    .trim()
    .slice(0, max);
  return out || undefined;
}

/** 持久化边界再收紧一次长度/数值，防核异常字段把 JSONL 撑爆。 */
export function sanitizeHistoryEntry(raw: ConnectionHistoryEntry): ConnectionHistoryEntry | null {
  const key = cleanText(raw?.key, 160);
  const connectionId = cleanText(raw?.connectionId, 80);
  const sessionId = cleanText(raw?.sessionId, 80);
  const startedAt = Number(raw?.startedAt);
  const observedAt = Number(raw?.observedAt);
  if (
    !key ||
    !connectionId ||
    !sessionId ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(observedAt)
  ) {
    return null;
  }
  const endedAt = Number(raw.endedAt);
  const chains = Array.isArray(raw.chains)
    ? raw.chains
        .map((v) => cleanText(v, 160))
        .filter((v): v is string => Boolean(v))
        .slice(0, 32)
    : [];
  return {
    key,
    connectionId,
    sessionId,
    startedAt,
    ...(Number.isFinite(endedAt) ? { endedAt } : {}),
    observedAt,
    active: raw.active === true,
    domain: cleanText(raw.domain, 512)?.toLowerCase(),
    destinationIP: cleanText(raw.destinationIP, 128),
    destinationPort: cleanText(raw.destinationPort, 16),
    network: cleanText(raw.network, 24),
    processPath: cleanText(raw.processPath, 2048),
    rule: cleanText(raw.rule, 2048),
    chains,
    outbound: cleanText(raw.outbound, 160) ?? chains[0] ?? 'direct',
    outboundType: cleanText(raw.outboundType, 80),
    upload: Math.max(0, Number.isFinite(Number(raw.upload)) ? Number(raw.upload) : 0),
    download: Math.max(0, Number.isFinite(Number(raw.download)) ? Number(raw.download) : 0),
  };
}

export function isDirectHistoryEntry(entry: ConnectionHistoryEntry): boolean {
  return (
    entry.outbound.toLowerCase() === 'direct' ||
    entry.outboundType?.toLowerCase() === 'direct' ||
    entry.chains[0]?.toLowerCase() === 'direct'
  );
}

/** 纯聚合核：时间采用「连接生命周期与查询窗口有交集」，长连接不会因启动早于 from 被漏掉。 */
export function aggregateHistoryEntries(
  entries: ConnectionHistoryEntry[],
  query: ConnectionHistoryQuery,
  now = Date.now(),
  inputTruncated = false
): ConnectionHistoryQueryResult {
  const from = Number.isFinite(query.from) ? query.from : now - 6 * 60 * 60 * 1000;
  const to = Number.isFinite(query.to) ? query.to : now;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const mode = query.mode ?? 'all';
  const outboundFilter = cleanText(query.outbound, 160)?.toLowerCase();
  const search = cleanText(query.search, 512)?.toLowerCase();
  const limit = Math.min(
    MAX_GROUP_LIMIT,
    Math.max(1, Math.floor(query.limit ?? DEFAULT_GROUP_LIMIT))
  );

  const filtered = entries.filter((entry) => {
    const end = entry.endedAt ?? now;
    if (entry.startedAt > hi || end < lo) return false;
    const direct = isDirectHistoryEntry(entry);
    if (mode === 'proxy' && direct) return false;
    if (mode === 'direct' && !direct) return false;
    if (outboundFilter && entry.outbound.toLowerCase() !== outboundFilter) return false;
    if (search) {
      const haystack = [
        entry.domain,
        entry.destinationIP,
        entry.outbound,
        entry.outboundType,
        entry.processPath,
        entry.rule,
        ...entry.chains,
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  type MutableGroup = ConnectionHistoryGroup & { processSet: Set<string> };
  const grouped = new Map<string, MutableGroup>();
  const destinations = new Set<string>();
  for (const entry of filtered) {
    const destination = entry.domain?.toLowerCase() || entry.destinationIP || '(unknown)';
    destinations.add(destination);
    const groupKey = `${destination}\u0000${entry.outbound}`;
    let group = grouped.get(groupKey);
    if (!group) {
      group = {
        destination,
        domain: entry.domain,
        destinationIP: entry.destinationIP,
        outbound: entry.outbound,
        outboundType: entry.outboundType,
        count: 0,
        firstAt: entry.startedAt,
        lastAt: entry.endedAt ?? entry.observedAt,
        upload: 0,
        download: 0,
        activeCount: 0,
        processes: [],
        processSet: new Set<string>(),
      };
      grouped.set(groupKey, group);
    }
    group.count++;
    group.firstAt = Math.min(group.firstAt, entry.startedAt);
    group.lastAt = Math.max(group.lastAt, entry.endedAt ?? entry.observedAt);
    group.upload += entry.upload;
    group.download += entry.download;
    if (entry.active) group.activeCount++;
    if (entry.processPath) group.processSet.add(entry.processPath);
  }

  const allGroups = Array.from(grouped.values())
    .map(({ processSet, ...group }) => ({
      ...group,
      processes: Array.from(processSet).slice(0, 5),
    }))
    .sort(
      (a, b) =>
        b.lastAt - a.lastAt || b.count - a.count || a.destination.localeCompare(b.destination)
    );

  return {
    groups: allGroups.slice(0, limit),
    totalConnections: filtered.length,
    uniqueDestinations: destinations.size,
    truncated: inputTruncated || allGroups.length > limit,
  };
}

export interface ConnectionHistoryServiceOptions {
  directory?: string;
  isEnabled: () => boolean;
  retentionDays: () => unknown;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class ConnectionHistoryService {
  private readonly directory: string;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private lastPruneAt = 0;
  private sizeWarnedFor = '';

  constructor(private readonly opts: ConnectionHistoryServiceOptions) {
    this.directory = opts.directory ?? getConnectionHistoryPath();
    this.now = opts.now ?? Date.now;
  }

  getSettings(): ConnectionHistorySettings {
    return {
      enabled: this.opts.isEnabled() === true,
      retentionDays: normalizeHistoryRetentionDays(this.opts.retentionDays()),
    };
  }

  append(entries: ConnectionHistoryEntry[]): Promise<void> {
    if (!this.opts.isEnabled() || entries.length === 0) return Promise.resolve();
    return this.enqueue(async () => {
      // append 排队后用户可能已关闭记录；执行前再门一次，关闭语义立即生效。
      if (!this.opts.isEnabled()) return;
      await fs.mkdir(this.directory, { recursive: true });
      await this.pruneUnlocked();
      const byFile = new Map<string, string[]>();
      for (const raw of entries) {
        const entry = sanitizeHistoryEntry(raw);
        if (!entry) continue;
        const day = new Date(entry.observedAt).toISOString().slice(0, 10);
        const file = path.join(this.directory, `connections-${day}.jsonl`);
        const lines = byFile.get(file) ?? [];
        lines.push(JSON.stringify(entry));
        byFile.set(file, lines);
      }
      for (const [file, lines] of byFile) {
        let size = 0;
        try {
          size = (await fs.stat(file)).size;
        } catch {
          /* new file */
        }
        if (size >= MAX_DAILY_BYTES) {
          if (this.sizeWarnedFor !== file) {
            this.sizeWarnedFor = file;
            this.opts.log?.('warn', `连接历史当日文件已达 32MiB 上限，本日后续记录已停止`);
          }
          continue;
        }
        await fs.appendFile(file, `${lines.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 });
      }
    });
  }

  query(query: ConnectionHistoryQuery): Promise<ConnectionHistoryQueryResult> {
    return this.enqueue(async () => {
      await this.pruneUnlocked();
      const latest = new Map<string, ConnectionHistoryEntry>();
      let truncated = false;
      let files: string[] = [];
      try {
        files = (await fs.readdir(this.directory)).filter((name) => FILE_RE.test(name)).sort();
      } catch {
        return aggregateHistoryEntries([], query, this.now());
      }
      for (const name of files) {
        let text = '';
        try {
          text = await fs.readFile(path.join(this.directory, name), 'utf-8');
        } catch {
          continue;
        }
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const entry = sanitizeHistoryEntry(JSON.parse(line) as ConnectionHistoryEntry);
            if (!entry) continue;
            // delete+set 让 Map 的头部恒为最早观测；超上限时保留最近记录。
            latest.delete(entry.key);
            latest.set(entry.key, entry);
            if (latest.size > MAX_QUERY_RECORDS) {
              const oldest = latest.keys().next().value;
              if (oldest) latest.delete(oldest);
              truncated = true;
            }
          } catch {
            /* 单行损坏跳过，其余历史仍可查 */
          }
        }
      }
      return aggregateHistoryEntries(Array.from(latest.values()), query, this.now(), truncated);
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      let files: string[] = [];
      try {
        files = (await fs.readdir(this.directory)).filter((name) => FILE_RE.test(name));
      } catch {
        return;
      }
      await Promise.all(
        files.map((name) => fs.unlink(path.join(this.directory, name)).catch(() => {}))
      );
      this.sizeWarnedFor = '';
    });
  }

  prune(): Promise<void> {
    return this.enqueue(() => this.pruneUnlocked(true));
  }

  private async pruneUnlocked(force = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastPruneAt < 60 * 60 * 1000) return;
    this.lastPruneAt = now;
    const cutoff = now - normalizeHistoryRetentionDays(this.opts.retentionDays()) * DAY_MS;
    let files: string[] = [];
    try {
      files = (await fs.readdir(this.directory)).filter((name) => FILE_RE.test(name));
    } catch {
      return;
    }
    for (const name of files) {
      const file = path.join(this.directory, name);
      try {
        if ((await fs.stat(file)).mtimeMs < cutoff) await fs.unlink(file);
      } catch {
        /* best effort */
      }
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
