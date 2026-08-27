import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock3, Database, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/ipc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { formatBytes } from '@/lib/format';
import type {
  ConnectionHistoryMode,
  ConnectionHistoryQueryResult,
  ConnectionHistorySettings,
} from '../../../shared/types';

function localDateTimeValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function processName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

const EMPTY_RESULT: ConnectionHistoryQueryResult = {
  groups: [],
  totalConnections: 0,
  uniqueDestinations: 0,
  truncated: false,
};

export function ConnectionHistoryTable() {
  const { t } = useTranslation();
  const now = Date.now();
  const [settings, setSettings] = useState<ConnectionHistorySettings | null>(null);
  const [from, setFrom] = useState(() => localDateTimeValue(now - 6 * 60 * 60 * 1000));
  const [to, setTo] = useState(() => localDateTimeValue(now));
  const [mode, setMode] = useState<ConnectionHistoryMode>('proxy');
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<ConnectionHistoryQueryResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const initialLoadStarted = useRef(false);

  const query = useCallback(async () => {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
    setLoading(true);
    try {
      setResult(
        await api.connections.history.query({
          from: fromMs,
          to: toMs,
          mode,
          search: search.trim() || undefined,
          limit: 2_000,
        })
      );
    } catch (error) {
      toast.error(t('connections.history.queryFailed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [from, mode, search, t, to]);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    let alive = true;
    void api.connections.history
      .getSettings()
      .then((value) => {
        if (!alive) return;
        setSettings(value);
        return query();
      })
      .catch((error) => {
        if (!alive) return;
        toast.error(t('connections.history.queryFailed'), {
          description: error instanceof Error ? error.message : undefined,
        });
      });
    return () => {
      alive = false;
    };
  }, [query, t]);

  const configure = async (next: ConnectionHistorySettings) => {
    try {
      const saved = await api.connections.history.configure(next);
      setSettings(saved);
      if (saved.enabled) void query();
    } catch (error) {
      toast.error(t('connections.history.configFailed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const clear = async () => {
    try {
      await api.connections.history.clear();
      setResult(EMPTY_RESULT);
      toast.success(t('connections.history.clearDone'));
    } catch (error) {
      toast.error(t('connections.history.clearFailed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setClearOpen(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="card flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Database className="h-4 w-4 text-primary" />
              {t('connections.tabHistory')}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('connections.history.enabledDesc')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t('connections.history.enabled')}
            </span>
            <Switch
              checked={settings?.enabled ?? false}
              disabled={!settings}
              onCheckedChange={(enabled) => settings && void configure({ ...settings, enabled })}
            />
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t('connections.history.from')}</span>
            <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t('connections.history.to')}</span>
            <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t('connections.history.mode')}</span>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={mode}
              onChange={(e) => setMode(e.target.value as ConnectionHistoryMode)}
            >
              <option value="all">{t('connections.history.modeAll')}</option>
              <option value="proxy">{t('connections.history.modeProxy')}</option>
              <option value="direct">{t('connections.history.modeDirect')}</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t('connections.history.retention')}</span>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={settings?.retentionDays ?? 1}
              disabled={!settings}
              onChange={(e) =>
                settings &&
                void configure({
                  ...settings,
                  retentionDays: Number(e.target.value) as 1 | 3 | 7,
                })
              }
            >
              <option value={1}>{t('connections.history.day1')}</option>
              <option value={3}>{t('connections.history.day3')}</option>
              <option value={7}>{t('connections.history.day7')}</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t('connections.search')}</span>
            <div className="relative">
              <Search className="absolute start-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                className="ps-9"
                value={search}
                placeholder={t('connections.history.search')}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void query()}
              />
            </div>
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {t('connections.history.summary', {
              connections: result.totalConnections,
              destinations: result.uniqueDestinations,
            })}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setClearOpen(true)}>
              <Trash2 className="me-1.5 h-3.5 w-3.5" />
              {t('connections.history.clear')}
            </Button>
            <Button size="sm" onClick={() => void query()} disabled={loading}>
              <RefreshCw className={`me-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              {loading ? t('connections.history.loading') : t('connections.history.refresh')}
            </Button>
          </div>
        </div>
        {!settings?.enabled && settings && (
          <div className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            {t('connections.history.disabled')}
          </div>
        )}
        {result.truncated && (
          <div className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            {t('connections.history.truncated')}
          </div>
        )}
      </div>

      <div className="card min-h-0 flex-1 overflow-auto">
        {loading && result.groups.length === 0 ? (
          <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">
            {t('connections.history.loading')}
          </div>
        ) : result.groups.length === 0 ? (
          <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">
            {t('connections.history.empty')}
          </div>
        ) : (
          <table className="w-full min-w-[980px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-card text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 text-start font-medium">
                  {t('connections.history.colDestination')}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t('connections.history.colOutbound')}
                </th>
                <th className="px-3 py-2 text-end font-medium">
                  {t('connections.history.colCount')}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t('connections.history.colWindow')}
                </th>
                <th className="px-3 py-2 text-end font-medium">
                  {t('connections.history.colTraffic')}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t('connections.history.colProcess')}
                </th>
              </tr>
            </thead>
            <tbody>
              {result.groups.map((group) => (
                <tr
                  key={`${group.destination}\u0000${group.outbound}`}
                  className="border-b border-border/60 hover:bg-muted/40"
                >
                  <td className="max-w-[280px] px-3 py-2 align-top">
                    <div className="break-all font-medium">{group.destination}</div>
                    {group.domain && group.destinationIP && (
                      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {group.destinationIP}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <span className="pill">{group.outbound}</span>
                    {group.outboundType && (
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {group.outboundType}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-end align-top font-mono">
                    {group.count}
                    {group.activeCount > 0 && (
                      <div className="mt-1 text-[10px] text-success">
                        {t('connections.history.active', { count: group.activeCount })}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Clock3 className="h-3 w-3" />
                      {new Date(group.firstAt).toLocaleString()}
                    </div>
                    <div className="mt-1">{new Date(group.lastAt).toLocaleString()}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-end align-top font-mono">
                    ↑ {formatBytes(group.upload)}
                    <br />↓ {formatBytes(group.download)}
                  </td>
                  <td className="max-w-[240px] px-3 py-2 align-top text-muted-foreground">
                    {group.processes.length > 0
                      ? group.processes.map((value) => (
                          <div className="truncate" key={value} title={value}>
                            {processName(value)}
                          </div>
                        ))
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connections.history.clearTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('connections.history.clearWarn')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('connections.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void clear()}>
              {t('connections.history.clear')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
