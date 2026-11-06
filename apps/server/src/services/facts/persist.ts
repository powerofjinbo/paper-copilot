/** Coalescing background writer: many schedule() calls -> one write of the latest state. */
export interface Persister {
  /** Ask for a write of the current state (returns at once; the write runs in the background). */
  schedule(): void;
  /** Resolve when every scheduled write has finished. */
  flush(): Promise<void>;
}

export function createPersister(write: () => Promise<void>, onError: (e: unknown) => void): Persister {
  let dirty = false;
  let running: Promise<void> | null = null;
  const loop = async () => {
    while (dirty) {
      dirty = false;
      try {
        await write();
      } catch (e) {
        onError(e);
      }
    }
  };
  const p: Persister = {
    schedule() {
      dirty = true;
      if (!running) {
        running = loop().finally(() => {
          running = null;
          if (dirty) p.schedule();
        });
      }
    },
    async flush() {
      while (running) await running;
    },
  };
  return p;
}

/** Log a failure of an optional dependency once per key (e.g. a core function still being built). */
export function onceLogger(log: { warn(msg: string, data?: unknown): void }): (key: string, msg: string, data?: unknown) => void {
  const seen = new Set<string>();
  return (key, msg, data) => {
    if (seen.has(key)) return;
    seen.add(key);
    log.warn(msg, data);
  };
}
