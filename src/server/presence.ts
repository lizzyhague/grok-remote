export const DEFAULT_PRESENCE_GRACE_MS = 10_000;

export type PresenceListener = {
  onOnline?: () => void;
  onGraceExpired?: () => void;
};

/**
 * Presence means at least one valid frontend connection. Keep a grace period after the last
 * connection closes so app switching, card switching, or a brief reload does not appear offline.
 */
export class PresenceTracker {
  readonly #graceMs: number;
  readonly #listeners = new Set<PresenceListener>();
  #count = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #now: () => number;
  #disconnectedAt: number | null = null;

  constructor(options: { graceMs?: number; now?: () => number } = {}) {
    this.#graceMs = options.graceMs ?? DEFAULT_PRESENCE_GRACE_MS;
    this.#now = options.now ?? Date.now;
  }

  get connectionCount(): number {
    return this.#count;
  }

  get online(): boolean {
    return this.#count > 0;
  }

  subscribe(listener: PresenceListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  add(): void {
    this.#count += 1;
    this.#disconnectedAt = null;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#count === 1) {
      for (const listener of this.#listeners) {
        listener.onOnline?.();
      }
    }
  }

  remove(): void {
    if (this.#count === 0) {
      return;
    }
    this.#count -= 1;
    if (this.#count > 0) {
      return;
    }
    this.#disconnectedAt = this.#now();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#count === 0) {
        for (const listener of this.#listeners) {
          listener.onGraceExpired?.();
        }
      }
    }, this.#graceMs);
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#listeners.clear();
  }
}
