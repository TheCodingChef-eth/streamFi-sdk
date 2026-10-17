import { useState, useEffect, useCallback, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface UseWithdrawableAmountResult {
  amount: bigint | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export interface UseWithdrawableAmountOptions {
  /**
   * Polling interval in milliseconds. Defaults to 1000. Use a small value
   * (e.g. 100) for smooth high-frequency streams, or a larger one to save
   * battery on mobile. Pass `0` (or a non-finite value) to disable polling.
   * The timer is paused while `document.hidden` is true.
   */
  intervalMs?: number;
}

export const DEFAULT_WITHDRAWABLE_INTERVAL_MS = 1000;

export function useWithdrawableAmount(
  streamId: bigint | string | null | undefined,
  options: UseWithdrawableAmountOptions = {},
): UseWithdrawableAmountResult {
  const intervalMs = options.intervalMs ?? DEFAULT_WITHDRAWABLE_INTERVAL_MS;
  const { client, isReady } = useStreamFiClient();
  const [amount, setAmount] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetch = useCallback((silent = false) => {
    const requestId = ++requestIdRef.current;

    if (!isReady || !client || streamId == null) {
      setAmount(null);
      setLoading(false);
      setError(null);
      return;
    }

    if (!silent) setLoading(true);
    setError(null);

    client.streams
      .withdrawable(streamId)
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setAmount(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client, isReady, streamId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  useEffect(() => {
    if (!isReady || !client || streamId == null) return;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    const isHidden = () => typeof document !== 'undefined' && document.hidden;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(() => fetch(true), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibilityChange = () => {
      if (isHidden()) {
        stop();
      } else {
        // Catch up immediately after the tab becomes visible again.
        fetch(true);
        start();
      }
    };

    if (!isHidden()) start();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [client, isReady, streamId, intervalMs, fetch]);

  const refetch = useCallback(() => fetch(), [fetch]);

  return { amount, loading, error, refetch };
}
