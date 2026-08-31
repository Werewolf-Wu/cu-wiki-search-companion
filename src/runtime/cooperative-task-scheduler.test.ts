// SPDX-License-Identifier: MPL-2.0
import { CooperativeTaskScheduler } from './cooperative-task-scheduler';

describe('CooperativeTaskScheduler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not schedule another chunk while hidden and resumes once visible', async () => {
    const visibility = new FakeVisibility(false);
    const yieldTask = vi.fn(async () => undefined);
    const scheduler = new CooperativeTaskScheduler({ visibility, yieldTask });

    const pending = scheduler.yield();
    await Promise.resolve();

    expect(yieldTask).not.toHaveBeenCalled();
    visibility.setVisible(true);
    await pending;
    expect(yieldTask).toHaveBeenCalledOnce();
    expect(visibility.listenerCount).toBe(0);
  });

  it('rechecks visibility after yielding before allowing the next chunk', async () => {
    const visibility = new FakeVisibility(true);
    let releaseYield!: () => void;
    const yielded = new Promise<void>((resolve) => {
      releaseYield = resolve;
    });
    const scheduler = new CooperativeTaskScheduler({
      visibility,
      yieldTask: () => yielded,
    });

    const pending = scheduler.yield();
    visibility.setVisible(false);
    releaseYield();
    await Promise.resolve();
    await Promise.resolve();

    expect(visibility.listenerCount).toBe(1);

    visibility.setVisible(true);
    await pending;
    expect(visibility.listenerCount).toBe(0);
  });

  it('runs the preferred task yield immediately when no visibility gate exists', async () => {
    const yieldTask = vi.fn(async () => undefined);
    const scheduler = new CooperativeTaskScheduler({ yieldTask });

    await scheduler.yield();

    expect(yieldTask).toHaveBeenCalledOnce();
  });

  it('falls back when scheduler.yield is present but rejects at runtime', async () => {
    const rejectedYield = vi.fn(async () => {
      throw new Error('当前 realm 不允许 scheduler.yield');
    });
    vi.stubGlobal('scheduler', { yield: rejectedYield });
    const scheduler = new CooperativeTaskScheduler({
      visibility: new FakeVisibility(true),
    });

    await scheduler.yield();

    expect(rejectedYield).toHaveBeenCalledOnce();
  });

  it('falls back to a timer when MessageChannel construction fails', async () => {
    vi.stubGlobal('scheduler', undefined);
    vi.stubGlobal(
      'MessageChannel',
      class BrokenMessageChannel {
        constructor() {
          throw new Error('userscript realm blocked MessageChannel');
        }
      },
    );
    const scheduler = new CooperativeTaskScheduler({
      visibility: new FakeVisibility(true),
    });

    await scheduler.yield();
  });

  it('removes the visibility listener and rejects when a paused task is aborted', async () => {
    const visibility = new FakeVisibility(false);
    const scheduler = new CooperativeTaskScheduler({
      visibility,
      yieldTask: vi.fn(async () => undefined),
    });
    const controller = new AbortController();

    const pending = scheduler.yield(controller.signal);
    controller.abort(new Error('停止旧一代重建'));

    await expect(pending).rejects.toThrow('停止旧一代重建');
    expect(visibility.listenerCount).toBe(0);
  });

  it('rejects promptly when aborted during the underlying task yield', async () => {
    let releaseYield!: () => void;
    const yielded = new Promise<void>((resolve) => {
      releaseYield = resolve;
    });
    let markYieldStarted!: () => void;
    const yieldStarted = new Promise<void>((resolve) => {
      markYieldStarted = resolve;
    });
    const scheduler = new CooperativeTaskScheduler({
      visibility: new FakeVisibility(true),
      yieldTask: () => {
        markYieldStarted();
        return yielded;
      },
    });
    const controller = new AbortController();
    let rejection: unknown;

    const pending = scheduler.yield(controller.signal).catch((error: unknown) => {
      rejection = error;
      throw error;
    });
    await yieldStarted;
    controller.abort(new Error('取消正在让步的任务'));
    await Promise.resolve();
    await Promise.resolve();

    expect(rejection).toEqual(new Error('取消正在让步的任务'));
    releaseYield();
    await expect(pending).rejects.toThrow('取消正在让步的任务');
  });
});

class FakeVisibility {
  private visible: boolean;
  private readonly listeners = new Set<() => void>();

  constructor(visible: boolean) {
    this.visible = visible;
  }

  isVisible = (): boolean => this.visible;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const listener of this.listeners) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
