/**
 * stats-worker —— Electron utilityProcess 入口（T4，issue #225；数据面核心，issue #242）。
 *
 * 把 StatsService 的 Status/Connections gRPC 长流订阅 + 连接事件解析 + per-frame 物化从 main 进程移出，消除主线程
 * 事件循环争用（Windows 拖动 move modal loop 跑主线程，与 stats 处理抢线程 → 拖动卡顿 / 启动后迟缓）。
 *
 * 设计要点：
 * - StatsService 保留 #210 长流重建 / #167 LRU eviction / 审计#3 OOM 上限 / resubscribe 切端口等不变量；
 *   connections 流的按需开关经 StatsService.setConnectionsStreamEnabled
 *   （复用其既有 subscribe/unsubscribe，不新增流原语）。
 * - worker 持自己的 SingBoxApiClient（仅 stats，不传 onUpdate → 不订 Tailscale）；端点参数由 main 经 'connect' 下发。
 * - **治本（issue #242）**：聚合下沉本 worker。每收到内核 connections 帧本地 aggregateConnections + 签名比对：
 *   ① change-driven + rate-cap → 仅内容真变且距上次 ≥AGG_MIN_INTERVAL_MS 才 post 小载荷 aggregate（杀「每秒全量克隆」
 *   B2 + 「零信息增量每秒重渲染」放大器）；② detail（全量明细）仅 host 下发 detailDemand（连接页 pull 期）才 post；
 *   ③ connectionsStream 无 aggregate/detail/history 任一消费者时取消上游 SubscribeConnections。
 * - 连接历史仅在 NEW/CLOSED 生命周期传小记录；history-only 不物化全量明细、不聚合拓扑。
 */
import {
  StatsService,
  trimConnection,
  type ConnectionLifecycleEvent,
} from '../services/StatsService';
import { SingBoxApiClient } from '../services/singbox-api-client';
import { aggregateConnections, aggregateSignature } from '../services/connections-aggregate';
import type { HostToWorkerMessage, WorkerToHostMessage } from '../services/StatsWorkerHost';
import type { ConnectionHistoryEntry } from '../../shared/types';

// utilityProcess 子进程的父端口（Electron 在子进程 process 上注入）。
const parentPort = process.parentPort;

// change-driven aggregate 的最小 post 间隔（§3.6；#251 真机观测后 2s→1s 提升拓扑跟手度）：内核帧 ~1s 到，
// 签名变化且距上次 post ≥1s 才推——高 churn 最坏 1 Hz；拓扑是计数图、落后 ≤1s 可接受，故无需额外 timer（帧本身即驱动）。
const AGG_MIN_INTERVAL_MS = 1000;

let apiClient: SingBoxApiClient | null = null;

// 需求驱动状态（取代 issue #225 的 connActive）：
// detailDemand——host 据连接页 pull 活跃度下发（setDemand.detail）。true 时每帧 post 全量明细（跨进程克隆，仅连接页
//   开着时才付费）。默认 false，待 host 首个 status 帧惰性下发真实值。
let detailDemand = false;
let aggregateDemand = false;
let historyDemand = false;
// connectionsStreamOn——映射「是否订阅上游 SubscribeConnections」。host 据窗口可见性下发（setDemand.connectionsStream）。
//   false 时经 StatsService 取消 Connections 流（连 aggregate 都停，sing-box 少序列化一条每秒长流削核 CPU）；Status
//   流不受影响（流量条恒需）。connect 默认 true（可见时即有 aggregate，host 首帧 setDemand 再收敛真实值）。
let connectionsStreamOn = true;
// change-driven：上次 post 的 aggregate 内容签名与时刻。签名未变或未过 rate-cap 不 post。null=强制下帧必发（connect 复位）。
let lastSentSig: string | null = null;
let lastSentAt = 0;
let historySessionId = '';
const recordedOpenIds = new Set<string>();

function post(msg: WorkerToHostMessage): void {
  parentPort.postMessage(msg);
}

function timestampMs(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (n >= 1e17) return n / 1e6; // ns
  if (n >= 1e14) return n / 1e3; // µs
  if (n >= 1e11) return n; // ms
  return n * 1e3; // s
}

function toHistoryEntry(event: ConnectionLifecycleEvent): ConnectionHistoryEntry | null {
  const raw = event.connection;
  const id = String(raw?.id ?? '');
  if (!id || !historySessionId) return null;
  const now = Date.now();
  const entry = trimConnection(raw);
  const parsedStart = entry.start ? Date.parse(entry.start) : NaN;
  const startedAt = Number.isFinite(parsedStart) ? parsedStart : timestampMs(raw.createdAt, now);
  const active = event.type === 'OPENED';
  return {
    key: `${historySessionId}:${id}`,
    connectionId: id,
    sessionId: historySessionId,
    startedAt,
    ...(active ? {} : { endedAt: timestampMs(event.closedAt ?? raw.closedAt, now) }),
    observedAt: now,
    active,
    domain: entry.metadata?.host,
    destinationIP: entry.metadata?.destinationIP,
    destinationPort: entry.metadata?.destinationPort,
    network: entry.metadata?.network,
    processPath: entry.metadata?.processPath,
    rule: entry.rule || undefined,
    chains: entry.chains,
    outbound: raw.outbound || entry.chains[0] || 'direct',
    outboundType: raw.outboundType,
    upload: entry.upload ?? 0,
    download: entry.download ?? 0,
  };
}

function onConnectionLifecycle(event: ConnectionLifecycleEvent): void {
  const id = String(event.connection?.id ?? '');
  if (!id) return;
  if (event.type === 'OPENED') {
    if (!historyDemand || recordedOpenIds.has(id)) return;
    recordedOpenIds.add(id);
  } else {
    recordedOpenIds.delete(id);
    if (!historyDemand) return;
  }
  const entry = toHistoryEntry(event);
  if (entry) post({ type: 'history', payload: [entry] });
}

// StatsService 实例常驻：'connect' 切 client + resubscribe，'stop' 停流。getApiClient 返回 worker 当前 client。
const stats = new StatsService(
  (s) => post({ type: 'stats', payload: s }), // status 不门控：始终流动，驱动 host 惰性下发 setDemand
  () => apiClient,
  (snap) => {
    // 每收到内核 connections 帧：本地聚合（下沉 worker，杀 host 侧每秒全量跨进程克隆 B2）。
    if (aggregateDemand) {
      const agg = aggregateConnections(snap.connections, snap.at);
      const sig = aggregateSignature(agg);
      const now = Date.now();
      // change-driven + rate-cap：签名变（内容真变）且距上次 post ≥AGG_MIN_INTERVAL_MS 才推 aggregate（拓扑小载荷）。
      if (sig !== lastSentSig && now - lastSentAt >= AGG_MIN_INTERVAL_MS) {
        post({ type: 'aggregate', payload: agg });
        lastSentSig = sig;
        lastSentAt = now;
      }
    }
    // detail 需求驱动：仅 detailDemand（连接页 pull 期）才把全量明细跨进程传（不门控签名/cap——明细每帧微变、
    // 消费端要实时 per-connection 流量）。
    if (detailDemand)
      post({ type: 'detail', payload: { connections: snap.connections, at: snap.at } });
  },
  // 第 4 参 isWindowVisible 故意不传；worker 由下方的 materialize demand 更精确门控。
  undefined,
  onConnectionLifecycle,
  () => aggregateDemand || detailDemand
);

parentPort.on('message', (e: Electron.MessageEvent) => {
  const msg = e.data as HostToWorkerMessage;
  switch (msg?.type) {
    case 'connect':
      // 切到最新端点（apiPort 每次启动可能重解析变化）：重建 client 后 resubscribe（停旧流句柄 → 按新 client 重订阅）。
      // 复位需求驱动态：connectionsStreamOn=true（新订阅默认活跃、可见时即有 aggregate，host 首个 status 帧按真实
      // 可见性校正）、detailDemand=false（待 host 下发）、lastSentSig=null + lastSentAt=0（强制首帧 aggregate 必发）。
      // 同时把 StatsService 的连接流开关复位 true（可能被上一需求周期关过），使 resubscribe 真的订阅 Connections。
      connectionsStreamOn = true;
      aggregateDemand = true;
      detailDemand = false;
      historyDemand = false;
      lastSentSig = null;
      lastSentAt = 0;
      historySessionId = msg.historySessionId;
      recordedOpenIds.clear();
      apiClient = new SingBoxApiClient(
        { host: msg.endpoint.host, port: msg.endpoint.port, tls: msg.endpoint.tls },
        msg.endpoint.secret
      );
      stats.setConnectionsStreamEnabled(true);
      stats.resubscribe();
      break;
    case 'setDemand':
      // host 惰性下发的需求：detail 存标志（下帧起门控明细 post）；connectionsStream 变化时真正订阅/取消上游
      // SubscribeConnections（复用 StatsService.setConnectionsStreamEnabled，Status/stats 不受影响）。
      aggregateDemand = msg.aggregate;
      detailDemand = msg.detail;
      historyDemand = msg.history;
      if (!historyDemand) recordedOpenIds.clear();
      if (msg.connectionsStream !== connectionsStreamOn) {
        connectionsStreamOn = msg.connectionsStream;
        stats.setConnectionsStreamEnabled(connectionsStreamOn);
      }
      break;
    case 'stop':
      stats.stop();
      apiClient = null;
      break;
    case 'dispose':
      stats.stop();
      apiClient = null;
      process.exit(0);
      break;
  }
});

// 监听器已挂 → 握手通知 main 可安全下发 'connect'（避免 fork 后立即 post 被竞态吞掉）。
post({ type: 'ready' });
