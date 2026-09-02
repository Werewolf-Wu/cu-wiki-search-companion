// SPDX-License-Identifier: MPL-2.0
import { DataCodeSyncSession } from './data-code-sync-session';

describe('DataCodeSyncSession', () => {
  it('runs save B after blocked save A fails and preserves each request outcome', async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstError = new Error('A failed');
    const order: string[] = [];
    const session = new DataCodeSyncSession<string>({
      refresh: vi.fn(),
      save: vi.fn(async (source) => {
        order.push(`${source}:start`);
        if (source === 'A') {
          await firstHeld;
          order.push('A:fail');
          throw firstError;
        }
        order.push(`${source}:complete`);
        return source;
      }),
      apply: async (source) => {
        order.push(`${source}:apply`);
      },
    });

    const first = session.save('A');
    const second = session.save('B');
    await vi.waitFor(() => expect(order).toEqual(['A:start']));
    releaseFirst();

    await expect(first).resolves.toEqual({ status: 'error', error: firstError });
    await expect(second).resolves.toEqual({ status: 'complete', value: 'B' });
    expect(order).toEqual(['A:start', 'A:fail', 'B:start', 'B:complete', 'B:apply']);
  });

  it('applies successful queued saves in order so the last successful save wins', async () => {
    const applied: string[] = [];
    const session = new DataCodeSyncSession<string>({
      refresh: vi.fn(),
      save: async (source) => source,
      apply: async (source) => {
        applied.push(source);
      },
    });

    await Promise.all([session.save('A'), session.save('B')]);

    expect(applied).toEqual(['A', 'B']);
  });

  it('coalesces overlapping background and manual refresh requests', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      await held;
      return 'refreshed';
    });
    const session = new DataCodeSyncSession<string>({
      refresh,
      save: vi.fn(),
      apply: vi.fn(),
    });

    const background = session.refresh(false);
    const manual = session.refresh(true);
    expect(background).toBe(manual);
    release();

    await expect(background).resolves.toEqual({
      status: 'complete',
      value: 'refreshed',
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(false);
  });

  it('returns an automatic refresh error without turning it into a save failure', async () => {
    const refreshError = new Error('network unavailable');
    const save = vi.fn();
    const session = new DataCodeSyncSession<string>({
      refresh: async () => {
        throw refreshError;
      },
      save,
      apply: vi.fn(),
    });

    await expect(session.refresh(false)).resolves.toEqual({
      status: 'error',
      error: refreshError,
    });
    expect(save).not.toHaveBeenCalled();
  });
});
