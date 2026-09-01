/**
 * Regression tests for issues #577 and #572.
 *
 * - #577 `u64ToScVal` / `estimateRequiredFee` — no raw `RangeError` from an
 *   unguarded `BigInt(x)` on a float or negative value.
 * - #572 `NonceManager.safeAcquire` — one queued waiter across retries, so a
 *   retrying caller is not sent to the back of the line and starved.
 */

import { describe, it, expect } from 'vitest';
import { u64ToScVal, estimateRequiredFee } from '../soroban.js';
import { NonceManager, type NonceLock } from '../nonce/NonceManager.js';

// ── #577: u64ToScVal ─────────────────────────────────────────────────────────

describe('#577 — u64ToScVal input guards', () => {
  it('encodes a valid non-negative integer', () => {
    expect(u64ToScVal(0n).switch().name).toBe('scvU64');
    expect(u64ToScVal(5).switch().name).toBe('scvU64');
    expect(u64ToScVal(18446744073709551615n).switch().name).toBe('scvU64');
  });

  it('throws a clear RangeError for a negative value instead of an opaque XDR error', () => {
    expect(() => u64ToScVal(-1)).toThrow(RangeError);
    expect(() => u64ToScVal(-1n)).toThrow(/non-negative/);
  });

  it('throws a clear RangeError for a non-integer number', () => {
    expect(() => u64ToScVal(2.5)).toThrow(RangeError);
    expect(() => u64ToScVal(2.5)).toThrow(/integer/);
  });
});

// ── #577: estimateRequiredFee ────────────────────────────────────────────────

describe('#577 — estimateRequiredFee never throws on a non-conforming fee field', () => {
  it('does not throw on a float minResourceFee — the fallback is the whole point', () => {
    expect(() => estimateRequiredFee({ minResourceFee: 1234.5 })).not.toThrow();
    expect(estimateRequiredFee({ minResourceFee: 1234.5 })).toBe(1234n);
  });

  it('falls back on an un-parseable fee string', () => {
    expect(estimateRequiredFee({ minResourceFee: '12.5abc' }, 999n)).toBe(999n);
  });

  it('still extracts the normal string / number / bigint shapes', () => {
    expect(estimateRequiredFee({ minResourceFee: '250000000' })).toBe(250_000_000n);
    expect(estimateRequiredFee({ fee: 42 })).toBe(42n);
    expect(estimateRequiredFee({ minResourceFee: 1000n })).toBe(1000n);
  });
});

// ── #572: NonceManager.safeAcquire ───────────────────────────────────────────

describe('#572 — NonceManager.safeAcquire uses one waiter and does not starve a retrying caller', () => {
  it('acquires the lock immediately when it is free', async () => {
    const m = new NonceManager({ startNonce: 0n, maxNonce: 100n });
    const lock = await m.safeAcquire();
    expect(lock.nonce).toBe(0n);
    lock.release();
    m.destroy();
  });

  it('a caller waiting through several patience windows still gets the next nonce (bounded wait, not back-of-line)', async () => {
    const m = new NonceManager({ startNonce: 0n, maxNonce: 100n });

    const held = await m.acquire(); // nonce 0, lock held

    // Short windows so safeAcquire "retries" a few times while blocked.
    const waiter = m.safeAcquire(4, 5, 20);
    // A later arrival that queues *after* the retrying caller.
    await new Promise((r) => setTimeout(r, 35));
    const late = m.acquire();

    // Free the lock — the earliest queued waiter (safeAcquire's single entry)
    // must be served first, not the later arrival.
    held.release();

    const first = await waiter;
    expect(first.nonce).toBe(1n);
    first.release();

    const l = await late;
    expect(l.nonce).toBe(2n);
    l.release();
    m.destroy();
  });

  it('does not leave the lock permanently held when safeAcquire gives up', async () => {
    const m = new NonceManager({ startNonce: 0n, maxNonce: 100n });
    const held = await m.acquire();

    await expect(m.safeAcquire(2, 1, 10)).rejects.toThrow(/timed out/);

    // The abandoned waiter must not block the next real acquirer.
    held.release();
    const next = await m.acquire();
    expect(next.nonce).toBe(1n);
    next.release();
    m.destroy();
  });

  it('concurrent safeAcquire callers all get distinct nonces', async () => {
    const m = new NonceManager({ startNonce: 0n, maxNonce: 100n });
    const locks: NonceLock[] = await Promise.all(
      Array.from({ length: 8 }, () =>
        m.safeAcquire(5, 2, 200).then((l) => {
          setTimeout(() => l.release(), 0);
          return l;
        }),
      ),
    );
    const nonces = locks.map((l) => l.nonce.toString()).sort();
    expect(new Set(nonces).size).toBe(8);
    m.destroy();
  });
});
