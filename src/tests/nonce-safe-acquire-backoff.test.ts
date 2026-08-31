import { afterEach, describe, expect, it, vi } from 'vitest';
import { NonceManager } from '../nonce/NonceManager.js';

describe('NonceManager.safeAcquire exponential backoff', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('doubles the delay between bounded waiting windows', async () => {
    vi.useFakeTimers();

    const manager = new NonceManager({ startNonce: 0n, maxNonce: 100n });
    const heldLock = await manager.acquire();

    try {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const acquisition = manager.safeAcquire(4, 100, 10);
      const rejection = expect(acquisition).rejects.toThrow(
        'acquire attempt 4/4 timed out after 10ms',
      );

      await vi.runAllTimersAsync();
      await rejection;

      expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual([
        10,
        100,
        10,
        200,
        10,
        400,
        10,
      ]);
    } finally {
      heldLock.release();
      manager.destroy();
    }
  });
});
