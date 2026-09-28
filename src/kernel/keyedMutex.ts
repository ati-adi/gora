// kernel/keyedMutex.ts (WP0) — serializes async work per key (lanes, per-conversation critical sections).
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  /** Runs fn after every previously queued fn for the same key has settled. */
  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
        if (this.tails.get(key) === tail) this.tails.delete(key);
      }
    });
  }
  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
  size(): number {
    return this.tails.size;
  }
}
