/**
 * Typed, synchronous, buffered event bus.
 * - `emit` appends to a buffer (events are plain data).
 * - `drain` returns and clears the buffer; the app drains once per frame so renderer/audio/UI see a
 *   consistent batch after N sim ticks.
 * - `on` listeners are called immediately on emit (used by the app side; sim modules only emit).
 */
/** Any object type whose keys are event names and values the payload types. */
export type EventMap = object;

export interface EventEnvelope<E extends EventMap, K extends keyof E = keyof E> { type: K; data: E[K]; tick: number }

export class EventBus<E extends EventMap> {
  private buffer: EventEnvelope<E>[] = [];
  private listeners = new Map<keyof E, Set<(data: unknown, tick: number) => void>>();
  private anyListeners = new Set<(e: EventEnvelope<E>) => void>();
  /** Current sim tick stamped onto emitted events; the owner updates it each step. */
  tick = 0;
  /** When true (dev builds), emitting from inside a listener throws to catch re-entrancy bugs. */
  guardReentrancy = false;
  private depth = 0;

  emit<K extends keyof E>(type: K, data: E[K]): void {
    if (this.guardReentrancy && this.depth > 0) throw new Error(`EventBus: re-entrant emit of "${String(type)}" from a listener`);
    const env: EventEnvelope<E, K> = { type, data, tick: this.tick };
    this.buffer.push(env as EventEnvelope<E>);
    const ls = this.listeners.get(type);
    if (ls || this.anyListeners.size) {
      this.depth++;
      try {
        if (ls) for (const fn of ls) fn(data, this.tick);
        for (const fn of this.anyListeners) fn(env as EventEnvelope<E>);
      } finally { this.depth--; }
    }
  }

  on<K extends keyof E>(type: K, fn: (data: E[K], tick: number) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    const wrapped = fn as (data: unknown, tick: number) => void;
    set.add(wrapped);
    return () => { set!.delete(wrapped); };
  }

  onAny(fn: (e: EventEnvelope<E>) => void): () => void {
    this.anyListeners.add(fn);
    return () => { this.anyListeners.delete(fn); };
  }

  /** Returns buffered events since the last drain and clears the buffer. */
  drain(): EventEnvelope<E>[] {
    if (this.buffer.length === 0) return this.buffer;
    const out = this.buffer; this.buffer = []; return out;
  }

  /** Peek without clearing (tests). */
  pending(): readonly EventEnvelope<E>[] { return this.buffer; }

  clear(): void { this.buffer = []; }
  removeAllListeners(): void { this.listeners.clear(); this.anyListeners.clear(); }
}
