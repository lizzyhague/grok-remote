import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveStateDir } from "./store.ts";

export type LayoutOrigin = "active" | "archived";

export type ArchivedEntry = {
  sessionId: string;
  projectId: string;
};

export type TrashEntry = {
  sessionId: string;
  projectId: string;
  deletedAt: number;
  origin: LayoutOrigin;
};

type LayoutFile = {
  version: 1;
  archived: ArchivedEntry[];
  trash: TrashEntry[];
};

export function resolveLayoutStatePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "layout.json");
}

/**
 * 归档和回收站都是本应用本地标记。Grok 磁盘上的会话先不动。
 */
export class SessionLayoutStore {
  readonly #filePath: string;
  readonly #archived = new Map<string, ArchivedEntry>();
  readonly #trash = new Map<string, TrashEntry>();
  #writeQueue: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.#filePath = filePath;
  }

  static async open(filePath: string): Promise<SessionLayoutStore> {
    const store = new SessionLayoutStore(path.resolve(filePath));
    await store.#load();
    return store;
  }

  isArchived(sessionId: string): boolean {
    return this.#archived.has(sessionId);
  }

  isTrashed(sessionId: string): boolean {
    return this.#trash.has(sessionId);
  }

  archivedEntry(sessionId: string): ArchivedEntry | null {
    const entry = this.#archived.get(sessionId);
    return entry ? { ...entry } : null;
  }

  trashEntry(sessionId: string): TrashEntry | null {
    const entry = this.#trash.get(sessionId);
    return entry ? { ...entry } : null;
  }

  listArchived(projectId?: string): ArchivedEntry[] {
    return [...this.#archived.values()]
      .filter((entry) => projectId === undefined || entry.projectId === projectId)
      .map((entry) => ({ ...entry }));
  }

  listTrash(projectId?: string): TrashEntry[] {
    return [...this.#trash.values()]
      .filter((entry) => projectId === undefined || entry.projectId === projectId)
      .map((entry) => ({ ...entry }));
  }

  async archive(sessionId: string, projectId: string): Promise<void> {
    if (this.#trash.has(sessionId)) {
      throw new Error("这个会话已经在回收站中。");
    }
    const previous = this.#archived.get(sessionId);
    this.#archived.set(sessionId, { sessionId, projectId });
    try {
      await this.#persist();
    } catch (error) {
      if (previous) this.#archived.set(sessionId, previous);
      else this.#archived.delete(sessionId);
      throw error;
    }
  }

  async unarchive(sessionId: string): Promise<boolean> {
    if (this.#trash.has(sessionId)) {
      throw new Error("这个会话在回收站中，请从回收站恢复。");
    }
    const previous = this.#archived.get(sessionId);
    if (!previous) return false;
    this.#archived.delete(sessionId);
    try {
      await this.#persist();
      return true;
    } catch (error) {
      this.#archived.set(sessionId, previous);
      throw error;
    }
  }

  async moveToTrash(entry: TrashEntry): Promise<void> {
    if (this.#trash.has(entry.sessionId)) return;
    const previousArchived = this.#archived.get(entry.sessionId);
    this.#archived.delete(entry.sessionId);
    this.#trash.set(entry.sessionId, { ...entry });
    try {
      await this.#persist();
    } catch (error) {
      this.#trash.delete(entry.sessionId);
      if (previousArchived) this.#archived.set(entry.sessionId, previousArchived);
      throw error;
    }
  }

  async restoreTrash(sessionId: string): Promise<TrashEntry | null> {
    const previous = this.#trash.get(sessionId);
    if (!previous) return null;
    this.#trash.delete(sessionId);
    const restoredArchived = previous.origin === "archived";
    if (restoredArchived) {
      this.#archived.set(sessionId, {
        sessionId,
        projectId: previous.projectId,
      });
    }
    try {
      await this.#persist();
      return { ...previous };
    } catch (error) {
      this.#trash.set(sessionId, previous);
      if (restoredArchived) this.#archived.delete(sessionId);
      throw error;
    }
  }

  async removeTrash(sessionId: string): Promise<boolean> {
    const previous = this.#trash.get(sessionId);
    if (!previous) return false;
    this.#trash.delete(sessionId);
    try {
      await this.#persist();
      return true;
    } catch (error) {
      this.#trash.set(sessionId, previous);
      throw error;
    }
  }

  async #load(): Promise<void> {
    let source: string;
    try {
      source = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error(`会话整理状态文件不是有效 JSON：${this.#filePath}`);
    }
    if (!isLayoutFile(value)) {
      throw new Error(`会话整理状态文件格式不正确：${this.#filePath}`);
    }
    for (const entry of value.archived) {
      this.#archived.set(entry.sessionId, { ...entry });
    }
    for (const entry of value.trash) {
      this.#trash.set(entry.sessionId, { ...entry });
    }
  }

  #persist(): Promise<void> {
    const snapshot: LayoutFile = {
      version: 1,
      archived: [...this.#archived.values()].map((entry) => ({ ...entry })),
      trash: [...this.#trash.values()].map((entry) => ({ ...entry })),
    };
    const operation = this.#writeQueue.then(() => this.#writeSnapshot(snapshot));
    this.#writeQueue = operation.catch(() => {});
    return operation;
  }

  async #writeSnapshot(snapshot: LayoutFile): Promise<void> {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

function isLayoutFile(value: unknown): value is LayoutFile {
  return isObject(value) &&
    value.version === 1 &&
    Array.isArray(value.archived) &&
    Array.isArray(value.trash) &&
    value.archived.every(isArchivedEntry) &&
    value.trash.every(isTrashEntry) &&
    new Set(value.archived.map((entry) => entry.sessionId)).size === value.archived.length &&
    new Set(value.trash.map((entry) => entry.sessionId)).size === value.trash.length;
}

function isArchivedEntry(value: unknown): value is ArchivedEntry {
  return isObject(value) &&
    typeof value.sessionId === "string" && value.sessionId.length > 0 &&
    typeof value.projectId === "string" && value.projectId.length > 0;
}

function isTrashEntry(value: unknown): value is TrashEntry {
  return isArchivedEntry(value) &&
    typeof (value as TrashEntry).deletedAt === "number" &&
    Number.isFinite((value as TrashEntry).deletedAt) &&
    (value as TrashEntry).deletedAt >= 0 &&
    ((value as TrashEntry).origin === "active" || (value as TrashEntry).origin === "archived");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
