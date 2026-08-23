export const DEFAULT_PRESENCE_GRACE_MS = 10_000;

export type PresenceListener = {
  onOnline?: () => void;
  onGraceExpired?: () => void;
};

/**
 * 以「是否至少有一个有效前端连接」为准。最后一个连接断开后留宽限期，
 * 避免切 App、刷卡或短暂重载被当成无人在线。
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
