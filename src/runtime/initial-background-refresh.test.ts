// SPDX-License-Identifier: MPL-2.0
import { InitialBackgroundRefreshCoordinator } from './initial-background-refresh';

describe('InitialBackgroundRefreshCoordinator', () => {
  it('keeps the refresh pending when Data sync fails and retries later', async () => {
    const syncData = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const coordinator = new InitialBackgroundRefreshCoordinator({
      canRun: () => true,
      isVisible: () => true,
      syncIncremental: vi.fn(async () => undefined),
      syncData,
    });

    await coordinator.request();
    expect(coordinator.pending).toBe(true);
    await coordinator.request();

    expect(syncData).toHaveBeenCalledTimes(2);
    expect(coordinator.pending).toBe(false);
  });

  it('does not begin Data sync after the page becomes hidden', async () => {
    let visible = true;
    const syncData = vi.fn(async () => true);
    const coordinator = new InitialBackgroundRefreshCoordinator({
      canRun: () => true,
      isVisible: () => visible,
      syncIncremental: async () => {
        visible = false;
      },
      syncData,
    });

    await coordinator.request();

    expect(syncData).not.toHaveBeenCalled();
    expect(coordinator.pending).toBe(true);
  });

  it('deduplicates overlapping requests in one tab', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const syncIncremental = vi.fn(async () => held);
    const coordinator = new InitialBackgroundRefreshCoordinator({
      canRun: () => true,
      isVisible: () => true,
      syncIncremental,
      syncData: vi.fn(async () => true),
    });

    const first = coordinator.request();
    const duplicate = coordinator.request();
    await vi.waitFor(() => expect(syncIncremental).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, duplicate]);

    expect(syncIncremental).toHaveBeenCalledOnce();
  });

  it('retries a later Data invalidation on the next visible tick', async () => {
    const incrementalResults = ['startup', 'changed', 'not-due'];
    const observedIncremental: string[] = [];
    const syncData = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const coordinator = new InitialBackgroundRefreshCoordinator({
      canRun: () => true,
      isVisible: () => true,
      syncIncremental: async () => {
        observedIncremental.push(incrementalResults.shift() ?? 'unexpected');
      },
      syncData,
    });

    await coordinator.request();
    expect(coordinator.pending).toBe(false);

    coordinator.markPending();
    await coordinator.request();
    expect(coordinator.pending).toBe(true);

    await coordinator.request();

    expect(observedIncremental).toEqual(['startup', 'changed', 'not-due']);
    expect(syncData).toHaveBeenCalledTimes(3);
    expect(coordinator.pending).toBe(false);
  });

  it('clears a pending invalidation after another refresh path succeeds', async () => {
    const syncIncremental = vi.fn(async () => undefined);
    const syncData = vi.fn(async () => true);
    const coordinator = new InitialBackgroundRefreshCoordinator({
      canRun: () => true,
      isVisible: () => true,
      syncIncremental,
      syncData,
    });

    await coordinator.request();
    coordinator.markPending();
    expect(coordinator.pending).toBe(true);

    coordinator.markComplete();
    await coordinator.request();

    expect(coordinator.pending).toBe(false);
    expect(syncIncremental).toHaveBeenCalledOnce();
    expect(syncData).toHaveBeenCalledOnce();
  });

  it('does not let an early external Data success skip the startup incremental pass', async () => {
    const syncIncremental = vi.fn(async () => undefined);
    const syncData = vi.fn(async () => true);
    const coordinator = new InitialBackgroundRefreshCoordinator({
      canRun: () => true,
      isVisible: () => true,
      syncIncremental,
      syncData,
    });

    coordinator.markComplete();
    await coordinator.request();

    expect(syncIncremental).toHaveBeenCalledOnce();
    expect(syncData).not.toHaveBeenCalled();
    expect(coordinator.pending).toBe(false);
  });
});
