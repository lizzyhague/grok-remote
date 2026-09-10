import type { BrowserTurnEvent } from "../turns/runtime.ts";

type ProjectTaskLease = {
  ownerId: string | null;
  sessionId: string;
  taskIds: Set<string>;
  reserved: boolean;
};

/** 锁跟随已接受的任务；页面断线或其他请求失败不能释放正在执行的任务。 */
export class ProjectTaskLocks {
  readonly #leases = new Map<string, ProjectTaskLease>();
  readonly #unsubscribe: () => void;

  constructor(turns: {
    onEvent(listener: (event: BrowserTurnEvent) => void): () => void;
  }) {
    this.#unsubscribe = turns.onEvent((event) => this.#onEvent(event));
  }

  acquire(projectId: string, ownerId: string, sessionId: string): boolean {
    const existing = this.#leases.get(projectId);
    if (existing) {
      if (existing.sessionId !== sessionId ||
        (existing.ownerId !== ownerId && existing.ownerId !== null)) return false;
      existing.ownerId = ownerId;
      existing.reserved = true;
      return true;
    }
    this.#leases.set(projectId, { ownerId, sessionId, taskIds: new Set(), reserved: true });
    return true;
  }

  reclaim(projectId: string, ownerId: string, sessionId: string): void {
    const lease = this.#leases.get(projectId);
    if (lease?.ownerId === null && lease.sessionId === sessionId) lease.ownerId = ownerId;
  }

  owns(projectId: string, ownerId: string, sessionId?: string): boolean {
    const lease = this.#leases.get(projectId);
    return lease?.ownerId === ownerId &&
      (sessionId === undefined || lease.sessionId === sessionId);
  }

  release(projectId: string, ownerId: string): boolean {
    const lease = this.#leases.get(projectId);
    if (!lease || lease.ownerId !== ownerId) return false;
    lease.reserved = false;
    if (lease.taskIds.size > 0) return false;
    this.#leases.delete(projectId);
    return true;
  }

  disconnect(ownerId: string): void {
    for (const [projectId, lease] of this.#leases) {
      if (lease.ownerId !== ownerId) continue;
      if (lease.taskIds.size === 0) this.#leases.delete(projectId);
      else lease.ownerId = null;
    }
  }

  dispose(): void {
    this.#unsubscribe();
  }

  #onEvent(event: BrowserTurnEvent): void {
    for (const [projectId, lease] of this.#leases) {
      if (event.type === "session.bound" && event.pendingId === lease.sessionId &&
        typeof event.sessionId === "string") lease.sessionId = event.sessionId;
      if (event.sessionId !== lease.sessionId || typeof event.turnId !== "string") continue;
      if (event.type === "turn.accepted") lease.taskIds.add(event.turnId);
      if (event.type === "turn.status" &&
        (event.status === "completed" || event.status === "interrupted" || event.status === "failed")) {
        if (lease.taskIds.delete(event.turnId) && lease.taskIds.size === 0 && !lease.reserved) {
          this.#leases.delete(projectId);
        }
      }
    }
  }
}
