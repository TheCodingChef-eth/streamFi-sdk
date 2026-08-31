export interface NonceLock {
  nonce: bigint;
  release: () => void;
}

export interface NonceManagerOptions {
  startNonce?: bigint | number | string;
  maxNonce?: bigint | number | string;
}

const MAX_SAFE_U64 = 18446744073709551615n;

interface QueueEntry {
  resolve: (value: NonceLock) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
}

export class NonceManager {
  private currentNonce: bigint;
  private maxNonce: bigint;
  private isLocked = false;
  private lockQueue: QueueEntry[] = [];
  private acquiredNonces: Set<string> = new Set();
  private isDestroyed = false;

  constructor(options: NonceManagerOptions = {}) {
    const rawStart = options.startNonce ?? 0n;
    const rawMax = options.maxNonce ?? MAX_SAFE_U64;

    this.currentNonce = this.toSafeBigInt(rawStart);
    this.maxNonce = this.toSafeBigInt(rawMax);

    if (this.currentNonce < 0n) {
      throw new Error('NonceManager: startNonce cannot be negative');
    }
    if (this.maxNonce <= this.currentNonce) {
      throw new Error('NonceManager: maxNonce must be greater than startNonce');
    }
    if (this.maxNonce > MAX_SAFE_U64) {
      this.maxNonce = MAX_SAFE_U64;
    }
  }

  private toSafeBigInt(value: bigint | number | string): bigint {
    if (typeof value === 'string' && value.trim() === '') {
      // BigInt('') would coerce to 0n, silently masking a caller bug.
      throw new Error('NonceManager: nonce value cannot be an empty string');
    }
    try {
      return BigInt(value);
    } catch {
      throw new Error(
        `NonceManager: invalid nonce value "${String(value)}" — expected a non-negative integer (bigint, number, or numeric string)`,
      );
    }
  }

  private nonceKey(nonce: bigint): string {
    return nonce.toString();
  }

  async acquire(): Promise<NonceLock> {
    if (this.isDestroyed) {
      throw new Error('NonceManager has been destroyed');
    }

    if (!this.isLocked) {
      this.isLocked = true;
      return this.nextNonce();
    }

    return this.enqueue().promise;
  }

  /**
   * Queues a waiter for the lock and returns a handle that can cancel it.
   * A cancelled waiter is skipped (without consuming a nonce) once it
   * reaches the front of the queue, so an abandoned caller (e.g. a timed
   * out `acquireWithFallback`) never leaves the lock permanently held.
   */
  private enqueue(): { promise: Promise<NonceLock>; cancel: () => void } {
    const entry: QueueEntry = { resolve: () => undefined, reject: () => undefined, cancelled: false };
    const promise = new Promise<NonceLock>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.lockQueue.push(entry);
    return { promise, cancel: () => { entry.cancelled = true; } };
  }

  private nextNonce(): NonceLock {
    const nonce = this.currentNonce;
    if (nonce >= this.maxNonce) {
      this.releaseLock();
      throw new Error(`NonceManager: nonce ${nonce} exceeds maximum ${this.maxNonce}`);
    }

    this.currentNonce = nonce + 1n;
    const key = this.nonceKey(nonce);
    this.acquiredNonces.add(key);

    const release = () => {
      this.acquiredNonces.delete(key);
      this.releaseLock();
    };

    return { nonce, release };
  }

  private releaseLock(): void {
    let next = this.lockQueue.shift();
    while (next && next.cancelled) {
      next = this.lockQueue.shift();
    }
    if (next) {
      try {
        const lock = this.nextNonce();
        next.resolve(lock);
      } catch (err) {
        this.isLocked = false;
        next.reject(err instanceof Error ? err : new Error(String(err)));
      }
    } else {
      this.isLocked = false;
    }
  }

  get current(): bigint {
    return this.currentNonce;
  }

  get remaining(): bigint {
    return this.maxNonce - this.currentNonce;
  }

  get acquired(): number {
    return this.acquiredNonces.size;
  }

  async reset(nonce?: bigint | number): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('NonceManager has been destroyed');
    }

    const start = Date.now();
    while (this.isLocked && Date.now() - start < 5000) {
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }

    this.currentNonce = nonce !== undefined ? this.toSafeBigInt(nonce) : 0n;
    this.acquiredNonces.clear();
    
    const resetError = new Error('NonceManager reset');
    for (const entry of this.lockQueue) {
      entry.reject(resetError);
    }
    this.lockQueue = [];
    this.isLocked = false;
  }

  destroy(): void {
    this.isDestroyed = true;
    
    const destroyError = new Error('NonceManager destroyed');
    for (const entry of this.lockQueue) {
      entry.reject(destroyError);
    }
    this.lockQueue = [];
    this.isLocked = false;
    this.acquiredNonces.clear();
  }

  static isNonceValid(value: unknown): value is bigint {
    if (typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') {
      return false;
    }
    try {
      const n = typeof value === 'bigint' ? value : BigInt(value);
      return n >= 0n && n <= MAX_SAFE_U64;
    } catch {
      return false;
    }
  }

  async acquireWithFallback(timeoutMs = 5000): Promise<NonceLock> {
    if (this.isDestroyed) {
      throw new Error('NonceManager has been destroyed');
    }

    if (!this.isLocked) {
      this.isLocked = true;
      return this.nextNonce();
    }

    const { promise, cancel } = this.enqueue();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancel();
        reject(new Error(`NonceManager: acquire timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } catch (err) {
      if (err instanceof Error) {
        throw err;
      }
      throw new Error(String(err));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Safe acquisition with bounded waiting and exponential backoff between
   * patience windows.
   *
   * Unlike a naive retry over {@link acquireWithFallback} — which `enqueue()`s
   * a fresh waiter on every attempt, leaving cancelled entries in `lockQueue`
   * and sending a retrying caller to the *back* of the line each time, so a
   * caller that keeps just missing the window can be starved (#572) — this
   * enqueues **exactly one** waiter. That waiter keeps its queue position
   * across every attempt; a timed-out attempt just extends how long we wait
   * on the same slot. The waiter is only cancelled once every retry is
   * exhausted.
   *
   * @param retries              number of patience windows
   * @param delayMs              base backoff between windows (× 2^attempt)
   * @param perAttemptTimeoutMs  how long each window waits before backing off
   */
  async safeAcquire(
    retries = 3,
    delayMs = 100,
    perAttemptTimeoutMs = 5000,
  ): Promise<NonceLock> {
    if (this.isDestroyed) {
      throw new Error('NonceManager has been destroyed');
    }

    // Fast path — the lock is free right now.
    if (!this.isLocked) {
      this.isLocked = true;
      return this.nextNonce();
    }

    const { promise, cancel } = this.enqueue();

    // If the lock frees while we are between attempts (during a backoff
    // sleep), `releaseLock` resolves `promise` with the nonce even though
    // nothing is awaiting it at that instant. Record it so we hand it back
    // instead of cancelling — cancelling then would leak the held lock.
    let handedLock: NonceLock | null = null;
    void promise.then(
      (lock) => {
        handedLock = lock;
      },
      () => undefined,
    );

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `NonceManager: acquire attempt ${attempt + 1}/${retries} timed out after ${perAttemptTimeoutMs}ms`,
              ),
            ),
          perAttemptTimeoutMs,
        );
      });

      try {
        const lock = await Promise.race([promise, timeoutPromise]);
        if (timer) clearTimeout(timer);
        return lock;
      } catch (err) {
        if (timer) clearTimeout(timer);
        lastError = err instanceof Error ? err : new Error(String(err));
        // The single waiter is still queued (not cancelled) — just wait a
        // bit longer on the same slot.
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, delayMs * 2 ** attempt));
          if (handedLock) return handedLock;
        }
      }
    }

    if (handedLock) return handedLock;
    cancel();
    throw lastError ?? new Error('NonceManager: safeAcquire failed');
  }
}
