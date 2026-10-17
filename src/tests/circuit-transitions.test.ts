import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recordFailure, recordSuccess, resetCircuit, getCircuitState, subscribeCircuitTransitions } from '../rpc-circuit-state.js';

describe('subscribeCircuitTransitions', () => {
  const scope = 'https://rpc.transitions.test';
  beforeEach(() => { vi.useFakeTimers(); resetCircuit(scope); });
  afterEach(() => { vi.useRealTimers(); resetCircuit(scope); });

  it('emits closed -> open -> half-open -> closed', () => {
    const calls: Array<[string, string]> = [];
    const off = subscribeCircuitTransitions((from, to) => calls.push([from, to]));
    for (let i = 0; i < 2; i++) recordFailure(scope, { threshold: 2, cooldownMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(getCircuitState(scope).state).toBe('half-open');
    recordSuccess(scope);
    off();
    expect(calls).toEqual([['closed', 'open'], ['open', 'half-open'], ['half-open', 'closed']]);
  });

  it('stops notifying after unsubscribe', () => {
    const fn = vi.fn();
    subscribeCircuitTransitions(fn)();
    recordFailure(scope, { threshold: 1 });
    expect(fn).not.toHaveBeenCalled();
  });
});
