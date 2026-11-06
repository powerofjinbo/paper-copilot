/** React hooks shared by the shell and the panels. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SentenceUnit } from '@paper-copilot/core';
import { errorText } from '../api/errors';
import { useWorkspace } from '../state/store';

export function useMounted(): { current: boolean } {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

/**
 * Source text of each unit, sliced from the editor's current document (units in the store are in
 * current editor coordinates). Falls back to the normalized text when no editor is mounted.
 */
export function useUnitText(): (u: SentenceUnit) => string {
  const editor = useWorkspace((s) => s.editor);
  const units = useWorkspace((s) => s.units);
  const doc = useMemo(() => {
    if (!editor) return null;
    try {
      return editor.getText();
    } catch {
      return null;
    }
    // Re-read whenever the editor publishes units (after every mapping or patch).
  }, [editor, units]);
  return useCallback(
    (u: SentenceUnit) => {
      if (doc && u.end <= doc.length && u.start >= 0 && u.end > u.start) return doc.slice(u.start, u.end);
      return u.textNorm;
    },
    [doc],
  );
}

/** Run an async action with busy/error state; errors also become a notice. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, opts: { notify?: boolean } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useMounted();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const notify = opts.notify !== false;
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fnRef.current(...args);
      } catch (e) {
        const m = errorText(e);
        if (mounted.current) setError(m);
        if (notify) useWorkspace.getState().pushNotice('error', m);
        return undefined;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [mounted, notify],
  );
  return { run, busy, error, setError };
}

/** Load data once (and on `reload()`); keeps the last value while reloading. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void; setData: (d: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    loaderRef
      .current()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { data, error, loading, reload, setData };
}

/** The job record of a job id from the store (job.progress messages). */
export function useJob(jobId: string | null): { kind: string; state: string; message: string } | null {
  return useWorkspace((s) => (jobId ? (s.jobs[jobId] ?? null) : null));
}

export function isJobActive(job: { state: string } | null): boolean {
  return !!job && (job.state === 'queued' || job.state === 'running');
}
