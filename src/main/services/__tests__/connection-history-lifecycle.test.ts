import { StatsService, type ConnectionLifecycleEvent } from '../StatsService';
import type { SingBoxConnectionEvents, SingBoxStatus } from '../singbox-api-client';

describe('StatsService connection history lifecycle', () => {
  it('NEW 发 OPENED；CLOSED 合并末段 delta 后发终态，history-only 不物化 detail', () => {
    let onEvents: ((events: SingBoxConnectionEvents) => void) | null = null;
    const detail = jest.fn();
    const lifecycle = jest.fn<void, [ConnectionLifecycleEvent]>();
    const client = {
      subscribeStatus: (_interval: number, _cb: (status: SingBoxStatus) => void) => () => {},
      subscribeConnections: (_interval: number, cb: (events: SingBoxConnectionEvents) => void) => {
        onEvents = cb;
        return () => {};
      },
    };
    const service = new StatsService(
      () => {},
      () => client as any,
      detail,
      undefined,
      lifecycle,
      () => false
    );
    service.start();
    const emit = (events: SingBoxConnectionEvents): void => {
      expect(onEvents).not.toBeNull();
      (onEvents as unknown as (value: SingBoxConnectionEvents) => void)(events);
    };

    emit({
      events: [
        {
          type: 'NEW',
          id: 'c1',
          connection: {
            id: 'c1',
            domain: 'example.com',
            destination: '1.2.3.4:443',
            createdAt: '1787918400000000000',
            uplinkTotal: '10',
            downlinkTotal: '20',
            outbound: 'US',
            outboundType: 'vless',
            chainList: ['US', 'proxy-selector'],
          },
        },
      ],
    });
    expect(lifecycle).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'OPENED', connection: expect.objectContaining({ id: 'c1' }) })
    );
    expect(detail).not.toHaveBeenCalled();

    emit({ events: [{ type: 'UPDATE', id: 'c1', uplinkDelta: '5', downlinkDelta: '7' }] });
    emit({
      events: [
        {
          type: 'CLOSED',
          id: 'c1',
          uplinkDelta: '2',
          downlinkDelta: '3',
          closedAt: '1787918460000000000',
        },
      ],
    });

    expect(lifecycle).toHaveBeenLastCalledWith({
      type: 'CLOSED',
      closedAt: '1787918460000000000',
      connection: expect.objectContaining({
        id: 'c1',
        uplinkTotal: '17',
        downlinkTotal: '30',
      }),
    });
  });

  it('历史回调异常不打断连接流', () => {
    let onEvents: ((events: SingBoxConnectionEvents) => void) | null = null;
    const client = {
      subscribeStatus: () => () => {},
      subscribeConnections: (_interval: number, cb: (events: SingBoxConnectionEvents) => void) => {
        onEvents = cb;
        return () => {};
      },
    };
    const service = new StatsService(
      () => {},
      () => client as any,
      undefined,
      undefined,
      () => {
        throw new Error('disk unavailable');
      }
    );
    service.start();
    const emit = (events: SingBoxConnectionEvents): void =>
      (onEvents as unknown as (value: SingBoxConnectionEvents) => void)(events);
    expect(() =>
      emit({
        events: [{ type: 'NEW', id: 'c1', connection: { id: 'c1', domain: 'example.com' } }],
      })
    ).not.toThrow();
    expect(service.getConnectionsSnapshot().connections).toHaveLength(1);
  });
});
