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
});
