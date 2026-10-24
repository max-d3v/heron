import { useEffect, useRef, useState } from "react";

/** Re-render on an interval, for relative times. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * Consume an oRPC event iterator. "append" keeps every event (capped at `max`),
 * "latest" keeps only the newest. The stream restarts when `key` changes.
 */
export function useStream<T>(
  key: string | null,
  open: (signal: AbortSignal) => Promise<AsyncIterable<T>>,
  mode: "append" | "latest" = "append",
  max = 2000,
): { items: T[]; latest: T | null; error: unknown } {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<unknown>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    setItems([]);
    setError(null);
    if (key === null) return;
    const ac = new AbortController();
    let pending: T[] = [];
    let frame = 0;
    // Batch bursts (e.g. a backlog of steps) into one render per frame.
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      setItems((prev) => {
        if (mode === "latest") return batch.length ? [batch[batch.length - 1]!] : prev;
        const next = prev.concat(batch);
        return next.length > max ? next.slice(next.length - max) : next;
      });
    };
    void (async () => {
      try {
        const it = await openRef.current(ac.signal);
        for await (const item of it) {
          if (ac.signal.aborted) break;
          pending.push(item);
          if (!frame) frame = requestAnimationFrame(flush);
        }
      } catch (err) {
        if (!ac.signal.aborted) setError(err);
      }
    })();
    return () => {
      ac.abort();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key, mode, max]);

  return { items, latest: items.length ? items[items.length - 1]! : null, error };
}
