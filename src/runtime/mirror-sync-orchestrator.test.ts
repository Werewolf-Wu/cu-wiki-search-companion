// SPDX-License-Identifier: MPL-2.0
import { MirrorSyncOrchestrator } from './mirror-sync-orchestrator';
import type { RecentChangeSyncResult, ReconciliationSyncResult } from '../types';

describe('MirrorSyncOrchestrator', () => {
  it('returns an exact lock-unavailable outcome without starting synchronization', async () => {
    const reconcile = vi.fn();
    const catchUp = vi.fn();
    const orchestrator = new MirrorSyncOrchestrator({
      coordinator: {
        runIfDue: vi.fn(async () => 'lock-unavailable' as const),
        runExclusive: vi.fn(async () => 'lock-unavailable' as const),
      },
      facts: { reconcile, catchUp },
      committed: {
        refreshReconciliation: vi.fn(),
        refreshRecentChanges: vi.fn(),
      },
      derived: {
        refreshData: vi.fn(),
        hasLoadedContentIndex: () => false,
        refreshContent: vi.fn(),
      },
    });

    await expect(orchestrator.runScheduled()).resolves.toEqual({
      request: 'scheduled',
      status: 'lock-unavailable',
      coordination: 'lock-unavailable',
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(catchUp).not.toHaveBeenCalled();
  });

  it('returns not-due without starting synchronization', async () => {
    const options = baseOptions();
    options.coordinator.runIfDue = vi.fn(async () => 'not-due' as const);
    const orchestrator = new MirrorSyncOrchestrator(options);

    await expect(orchestrator.runScheduled()).resolves.toEqual({
      request: 'scheduled',
      status: 'not-due',
      coordination: 'not-due',
    });
    expect(options.facts.reconcile).not.toHaveBeenCalled();
    expect(options.facts.catchUp).not.toHaveBeenCalled();
  });

  it('reports login-required and applies partially committed reconciliation after lock release', async () => {
    const order: string[] = [];
    const options = baseOptions();
    options.coordinator.runIfDue = vi.fn(async (task) => {
      order.push('lock-acquired');
      await task();
      order.push('lock-released');
      return 'ran' as const;
    });
    const reconciliation = reconciliationResult('login-required');
    options.facts.reconcile = vi.fn(async () => {
      order.push('reconcile');
      return reconciliation;
    });
    options.committed.refreshReconciliation = vi.fn(async () => {
      order.push('committed-refresh');
      return undefined;
    });
    const orchestrator = new MirrorSyncOrchestrator(options);

    await expect(orchestrator.runScheduled()).resolves.toMatchObject({
      request: 'scheduled',
      status: 'login-required',
      coordination: 'ran',
      reconciliation,
    });
    expect(order).toEqual([
      'lock-acquired',
      'reconcile',
      'lock-released',
      'committed-refresh',
    ]);
    expect(options.facts.catchUp).not.toHaveBeenCalled();
  });

  it('preserves catch-up and Data failures after refreshing committed reconciliation outside the lock', async () => {
    const order: string[] = [];
    const catchUpError = new Error('RC catch-up failed');
    const dataError = new Error('Data refresh failed');
    const options = baseOptions();
    options.coordinator.runExclusive = vi.fn(async (task) => {
      order.push('lock-acquired');
      await task();
      order.push('lock-released');
      return 'ran' as const;
    });
    options.facts.reconcile = vi.fn(async () => {
      order.push('reconcile');
      return completeReconciliation();
    });
    options.facts.catchUp = vi.fn(async () => {
      order.push('catch-up');
      throw catchUpError;
    });
    options.committed.refreshReconciliation = vi.fn(async () => {
      order.push('committed-refresh');
      return { dataCodesInvalidated: true };
    });
    options.derived.refreshData = vi.fn(async () => {
      order.push('data');
      return { status: 'error' as const, error: dataError };
    });
    options.derived.hasLoadedContentIndex = () => true;
    options.derived.refreshContent = vi.fn(async () => {
      order.push('content');
    });
    const orchestrator = new MirrorSyncOrchestrator(options);

    await expect(orchestrator.reconcileNow()).resolves.toMatchObject({
      request: 'manual',
      status: 'catch-up-error',
      reconciliation: { status: 'complete' },
      dataRefresh: { status: 'error', error: dataError },
      contentRefresh: 'complete',
      errors: { catchUp: catchUpError, data: dataError },
    });
    expect(order).toEqual([
      'lock-acquired',
      'reconcile',
      'catch-up',
      'lock-released',
      'committed-refresh',
      'data',
      'content',
    ]);
  });

  it('refreshes partial reconciliation facts even when reconciliation throws', async () => {
    const order: string[] = [];
    const failure = new Error('namespace batch failed');
    const options = baseOptions();
    options.coordinator.runExclusive = vi.fn(async (task) => {
      order.push('lock-acquired');
      await task();
      order.push('lock-released');
      return 'ran' as const;
    });
    options.facts.reconcile = vi.fn(async () => {
      order.push('partial-commit');
      throw failure;
    });
    options.committed.refreshReconciliation = vi.fn(async () => {
      order.push('committed-refresh');
      return { dataCodesInvalidated: false };
    });

    await expect(new MirrorSyncOrchestrator(options).reconcileNow()).resolves.toMatchObject({
      status: 'error',
      errors: { synchronization: failure },
    });
    expect(order).toEqual([
      'lock-acquired',
      'partial-commit',
      'lock-released',
      'committed-refresh',
    ]);
  });

  it.each([
    ['warm', true, 'complete'],
    ['cold', false, 'not-loaded'],
  ] as const)(
    '%s runtime consumes deferred RC content without preparing a cold index',
    async (_label, loaded, expectedContentRefresh) => {
      const options = baseOptions();
      options.facts.reconcile = vi.fn(async () => reconciliationResult('not-due'));
      options.facts.catchUp = vi.fn(async () => completeRecentChanges([42]));
      options.committed.refreshReconciliation = vi.fn(async () => undefined);
      options.committed.refreshRecentChanges = vi.fn(async () => ({
        dataCodesInvalidated: false,
      }));
      options.derived.hasLoadedContentIndex = () => loaded;
      const orchestrator = new MirrorSyncOrchestrator(options);

      await expect(orchestrator.runScheduled()).resolves.toMatchObject({
        status: 'complete',
        contentRefresh: expectedContentRefresh,
      });
      expect(options.derived.refreshContent).toHaveBeenCalledTimes(loaded ? 1 : 0);
    },
  );

  it('returns Data failure independently after a successful catch-up', async () => {
    const dataError = new Error('Mongo unavailable');
    const options = baseOptions();
    options.facts.reconcile = vi.fn(async () => reconciliationResult('not-due'));
    options.facts.catchUp = vi.fn(async () => completeRecentChanges());
    options.committed.refreshReconciliation = vi.fn(async () => undefined);
    options.committed.refreshRecentChanges = vi.fn(async () => ({
      dataCodesInvalidated: true,
    }));
    options.derived.refreshData = vi.fn(async () => ({
      status: 'error' as const,
      error: dataError,
    }));

    await expect(new MirrorSyncOrchestrator(options).runScheduled()).resolves.toMatchObject({
      status: 'data-error',
      dataRefresh: { status: 'error', error: dataError },
      errors: { data: dataError },
    });
  });

  it('coalesces concurrent scheduled requests at its public interface', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const options = baseOptions();
    options.facts.reconcile = vi.fn(async () => {
      await held;
      return reconciliationResult('login-required');
    });
    options.committed.refreshReconciliation = vi.fn(async () => undefined);
    const orchestrator = new MirrorSyncOrchestrator(options);

    const first = orchestrator.runScheduled();
    const duplicate = orchestrator.runScheduled();
    expect(first).toBe(duplicate);
    release();
    await Promise.all([first, duplicate]);

    expect(options.facts.reconcile).toHaveBeenCalledOnce();
  });

  it('emits request and reconciliation lifecycle events through the public seam', async () => {
    const events: string[] = [];
    const options = baseOptions();
    options.facts.reconcile = vi.fn(async (_force, onProgress) => {
      onProgress(reconciliationState());
      return reconciliationResult('login-required');
    });
    options.committed.refreshReconciliation = vi.fn(async () => undefined);
    options.onEvent = (event) => events.push(event.type);

    await new MirrorSyncOrchestrator(options).runScheduled();

    expect(events).toEqual([
      'started',
      'reconciliation-started',
      'reconciliation-progress',
    ]);
  });
});

function reconciliationState() {
  return {
    status: 'running' as const,
    scanProtocol: 2,
    reason: 'scheduled' as const,
    namespaceIds: [0],
    namespaceNames: { 0: '' },
    namespaceIndex: 0,
    generation: 1,
    startLocalSeq: 1,
    throughLocalSeq: 1,
    serverStartedAt: '2026-09-01T00:00:00Z',
    pagesFetched: 0,
    pagesChanged: 0,
    filesChanged: false,
    dataCodesInvalidated: false,
    startedAt: 1,
  };
}

function completeReconciliation(): Extract<
  ReconciliationSyncResult,
  { status: 'complete' }
> {
  return {
    status: 'complete',
    reason: 'manual',
    serverStartedAt: '2026-09-01T00:00:00Z',
    pagesFetched: 5,
    pagesChanged: 2,
    filesChanged: false,
    dataCodesInvalidated: true,
    throughLocalSeq: 6,
  };
}

function completeRecentChanges(
  deferredContentPageIds: number[] = [],
): Extract<RecentChangeSyncResult, { status: 'complete' }> {
  return {
    status: 'complete',
    startedAt: '2026-09-01T00:00:00Z',
    through: '2026-09-01T00:01:00Z',
    eventsSeen: 1,
    candidates: 1,
    changedPages: [],
    deferredContentPageIds,
    filesChanged: false,
    dataCodesInvalidated: false,
    throughLocalSeq: 7,
  };
}

function reconciliationResult(
  status: 'login-required' | 'not-due' | 'no-baseline',
): ReconciliationSyncResult {
  if (status === 'login-required') {
    return {
      status,
      pagesFetched: 3,
      pagesChanged: 1,
      filesChanged: false,
      dataCodesInvalidated: false,
      throughLocalSeq: 4,
    };
  }
  return {
    status,
    pagesFetched: 0,
    pagesChanged: 0,
    filesChanged: false,
    dataCodesInvalidated: false,
    throughLocalSeq: 4,
  };
}

function baseOptions(): ConstructorParameters<typeof MirrorSyncOrchestrator>[0] {
  return {
    coordinator: {
      runIfDue: vi.fn(async (task) => {
        await task();
        return 'ran' as const;
      }),
      runExclusive: vi.fn(async (task) => {
        await task();
        return 'ran' as const;
      }),
    },
    facts: {
      reconcile: vi.fn(),
      catchUp: vi.fn(),
    },
    committed: {
      refreshReconciliation: vi.fn(),
      refreshRecentChanges: vi.fn(),
    },
    derived: {
      refreshData: vi.fn(),
      hasLoadedContentIndex: () => false,
      refreshContent: vi.fn(),
    },
  };
}
