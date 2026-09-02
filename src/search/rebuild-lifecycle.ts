// SPDX-License-Identifier: MPL-2.0
export class ConcurrentRebuildLifecycle<TState, TUpdate> {
  private generation = 0;
  private readonly pendingRebuilds = new Set<TUpdate[]>();

  constructor(
    private state: TState,
    private readonly applyUpdate: (state: TState, update: TUpdate) => void,
    private readonly cloneUpdate: (update: TUpdate) => TUpdate,
  ) {}

  get current(): TState {
    return this.state;
  }

  rebuild(nextState: TState): void {
    this.generation += 1;
    this.state = nextState;
  }

  async rebuildAsync(build: () => Promise<TState>): Promise<void> {
    const generation = ++this.generation;
    const pending: TUpdate[] = [];
    this.pendingRebuilds.add(pending);
    try {
      const nextState = await build();
      for (const update of pending) this.applyUpdate(nextState, update);
      if (generation === this.generation) this.state = nextState;
    } finally {
      this.pendingRebuilds.delete(pending);
    }
  }

  update(update: TUpdate): void {
    for (const pending of this.pendingRebuilds) {
      pending.push(this.cloneUpdate(update));
    }
    this.applyUpdate(this.state, update);
  }
}
