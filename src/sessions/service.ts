import { realpath } from "node:fs/promises";

import type { ProjectCatalog } from "../projects/catalog.ts";
import { GrokSessionDisk } from "./disk.ts";
import { parseActivePromptIndex, parseUpdatesJsonl } from "./history.ts";
import {
  SessionLayoutStore,
  type LayoutOrigin,
} from "./layout-store.ts";
import { RemoteSessionStore } from "./store.ts";
import {
  HISTORY_PAGE_SIZE,
  PENDING_SESSION_PREFIX,
  type SessionPage,
  type SessionSummary,
  type SessionView,
  type TurnSnapshot,
} from "./types.ts";

export type { SessionPage, SessionSummary, SessionView };

export const TRASH_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const PAGE_SIZE = 50;

export type SessionListOptions = {
  cursor?: string | null;
  view?: SessionView;
  searchTerm?: string | null;
};

export type SessionMutationResult = {
  succeeded: string[];
  failed: Array<{ sessionId: string; message: string }>;
};

export type TrashCleanupResult = {
  deleted: number;
  failed: Array<{ sessionId: string; message: string }>;
};

export type OpenedSession = {
  session: SessionSummary;
  tasks: TurnSnapshot[];
  older: TurnSnapshot[];
  activeTurnId: string | null;
  alwaysApprove: boolean;
  lastSeq: number;
  resumeAfterSeq: number;
};

export type SessionChangeEvent = {
  projectId: string;
  sessionIds: string[];
  change: "delete" | "create" | "update" | "archive" | "unarchive" | "trash" | "restore";
};

export class SessionService {
  readonly #projects: ProjectCatalog;
  readonly #disk: GrokSessionDisk;
  readonly #store: RemoteSessionStore;
  readonly #layout: SessionLayoutStore;
  readonly #now: () => number;
  readonly #isRunning: (sessionId: string) => boolean;
  readonly #listeners = new Set<(event: SessionChangeEvent) => void>();
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    projects: ProjectCatalog,
    disk: GrokSessionDisk,
    store: RemoteSessionStore,
    layout: SessionLayoutStore,
    options: {
      now?: () => number;
      isRunning?: (sessionId: string) => boolean;
    } = {},
  ) {
    this.#projects = projects;
    this.#disk = disk;
    this.#store = store;
    this.#layout = layout;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.#isRunning = options.isRunning ?? (() => false);
  }

  onChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async list(projectId: string, options: SessionListOptions = {}): Promise<SessionPage> {
    const project = await this.#projects.resolve(projectId);
    const view = options.view ?? "active";
    const search = options.searchTerm?.trim().toLowerCase() ?? "";
    const offset = decodeCursor(options.cursor ?? null);

    if (view === "trash") {
      return this.#listTrash(projectId, project.path, offset, search);
    }

    const fromDisk = await this.#disk.listForCwd(project.path);
    const sessions: SessionSummary[] = [];
    for (const record of fromDisk) {
      if (this.#layout.isTrashed(record.id)) continue;
      const archived = this.#layout.isArchived(record.id);
      if (view === "archived" ? !archived : archived) continue;
      sessions.push(this.#toSummary(record));
    }

    const filtered = search
      ? sessions.filter((session) =>
        session.title.toLowerCase().includes(search) ||
        session.preview.toLowerCase().includes(search)
      )
      : sessions;
    filtered.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    const page = filtered.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + page.length;
    return {
      sessions: page,
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
    };
  }

  async start(projectId: string): Promise<OpenedSession> {
    await this.#projects.resolve(projectId);
    const meta = await this.#store.createPending(projectId);
    this.#emit({ projectId, sessionIds: [meta.id], change: "create" });
    return {
      session: pendingSummary(meta),
      tasks: [],
      older: [],
      activeTurnId: null,
      alwaysApprove: false,
      lastSeq: 0,
      resumeAfterSeq: 0,
    };
  }

  async open(projectId: string, sessionId: string): Promise<OpenedSession> {
    const project = await this.#projects.resolve(projectId);
    const meta = await this.#store.readMeta(sessionId);

    if (sessionId.startsWith(PENDING_SESSION_PREFIX)) {
      if (!meta || meta.projectId !== projectId) {
        throw new Error("会话不存在，或不属于这个项目。");
      }
      return {
        session: pendingSummary(meta),
        tasks: [],
        older: [],
        activeTurnId: null,
        alwaysApprove: meta.permissionMode === "always-approve",
        lastSeq: await this.#store.lastSeq(sessionId),
        resumeAfterSeq: await this.#resumeAfterSeq(sessionId),
      };
    }

    if (this.#layout.isTrashed(sessionId)) {
      throw new Error("这个会话在回收站中，请先恢复后再打开。");
    }

    const record = await this.#disk.read(sessionId);
    if (!record) {
      throw new Error("会话不存在，或不属于这个项目。");
    }
    await assertCwdBelongs(record.cwd, project.path);

    const [updates, rewindPoints] = await Promise.all([
      this.#disk.readUpdatesJsonl(sessionId),
      this.#disk.readRewindPointsJsonl(sessionId),
    ]);
    const turns = parseUpdatesJsonl(updates, {
      activePromptIndex: parseActivePromptIndex(rewindPoints),
    });
    const visibleStart = Math.max(0, turns.length - HISTORY_PAGE_SIZE);
    if (!meta) {
      await this.#store.writeMeta({
        id: sessionId,
        projectId,
        grokSessionId: sessionId,
        permissionMode: "ask",
        title: record.title,
        createdAt: record.createdAt,
        clientMessageIds: {},
        clientMessagePayloads: {},
      });
    }

    return {
      session: this.#toSummary(record),
      tasks: turns.slice(visibleStart),
      older: turns.slice(0, visibleStart),
      activeTurnId: null,
      alwaysApprove: meta?.permissionMode === "always-approve",
      lastSeq: await this.#store.lastSeq(sessionId),
      resumeAfterSeq: await this.#resumeAfterSeq(sessionId),
    };
  }

  archive(projectId: string, sessionIds: string[]): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, sessionIds, "archive", async (resolvedProjectId, sessionId) => {
      if (this.#layout.isTrashed(sessionId)) {
        throw new Error("这个会话已经在回收站中。");
      }
      await this.#assertCanManage(resolvedProjectId, sessionId);
      await this.#layout.archive(sessionId, resolvedProjectId);
    });
  }

  unarchive(projectId: string, sessionIds: string[]): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, sessionIds, "unarchive", async (resolvedProjectId, sessionId) => {
      if (this.#layout.isTrashed(sessionId)) {
        throw new Error("这个会话在回收站中，请从回收站恢复。");
      }
      await this.#assertCanManage(resolvedProjectId, sessionId);
      await this.#layout.unarchive(sessionId);
    });
  }

  moveToTrash(
    projectId: string,
    sessionIds: string[],
    origin: LayoutOrigin,
  ): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, sessionIds, "trash", async (resolvedProjectId, sessionId) => {
      if (this.#layout.isTrashed(sessionId)) return;
      await this.#assertCanManage(resolvedProjectId, sessionId);
      await this.#layout.moveToTrash({
        sessionId,
        projectId: resolvedProjectId,
        deletedAt: this.#now(),
        origin,
      });
    });
  }

  restoreTrash(projectId: string, sessionIds: string[]): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, sessionIds, "restore", async (resolvedProjectId, sessionId) => {
      const entry = this.#layout.trashEntry(sessionId);
      if (!entry || entry.projectId !== resolvedProjectId) {
        throw new Error("这个会话不在当前项目的回收站中。");
      }
      await this.#assertCanManage(resolvedProjectId, sessionId);
      await this.#layout.restoreTrash(sessionId);
    });
  }

  purgeExpired(): Promise<TrashCleanupResult> {
    return this.#serializeMutation(async () => {
      const threshold = this.#now() - TRASH_RETENTION_SECONDS;
      const expired = this.#layout.listTrash().filter((entry) => entry.deletedAt <= threshold);
      const result: TrashCleanupResult = { deleted: 0, failed: [] };
      for (const entry of expired) {
        try {
          await this.#permanentlyDelete(entry.sessionId);
          await this.#layout.removeTrash(entry.sessionId);
          result.deleted += 1;
          this.#emit({
            projectId: entry.projectId,
            sessionIds: [entry.sessionId],
            change: "delete",
          });
        } catch (error) {
          result.failed.push({
            sessionId: entry.sessionId,
            message: error instanceof Error ? error.message : "删除失败。",
          });
        }
      }
      return result;
    });
  }

  async discardUnboundPending(): Promise<number> {
    return this.#store.deleteUnboundPending();
  }

  async #listTrash(
    projectId: string,
    projectPath: string,
    offset: number,
    search: string,
  ): Promise<SessionPage> {
    const entries = this.#layout.listTrash(projectId)
      .sort((left, right) => right.deletedAt - left.deletedAt);
    const matched: SessionSummary[] = [];
    for (const entry of entries) {
      const record = await this.#disk.read(entry.sessionId);
      if (!record) continue;
      try {
        await assertCwdBelongs(record.cwd, projectPath);
      } catch {
        continue;
      }
      const summary: SessionSummary = {
        ...this.#toSummary(record),
        state: "idle",
        deletedAt: entry.deletedAt,
        purgeAt: entry.deletedAt + TRASH_RETENTION_SECONDS,
      };
      if (
        search &&
        !summary.title.toLowerCase().includes(search) &&
        !summary.preview.toLowerCase().includes(search)
      ) {
        continue;
      }
      matched.push(summary);
    }
    const page = matched.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + page.length;
    return {
      sessions: page,
      nextCursor: nextOffset < matched.length ? String(nextOffset) : null,
    };
  }

  async #resumeAfterSeq(sessionId: string): Promise<number> {
    const events = await this.#store.eventsSince(sessionId, 0);
    let seq = 0;
    for (const item of events) {
      if (item.event.type === "session.rewound") {
        seq = item.seq;
        continue;
      }
      if (item.event.type !== "turn.status") continue;
      const status = item.event.status;
      if (status === "completed" || status === "interrupted" || status === "failed") {
        seq = item.seq;
      }
    }
    return seq;
  }

  async #assertCanManage(projectId: string, sessionId: string): Promise<void> {
    if (sessionId.startsWith(PENDING_SESSION_PREFIX)) {
      throw new Error("这个会话还没有保存，不能整理。");
    }
    if (this.#isRunning(sessionId)) {
      throw new Error("这个会话仍有任务正在运行，暂时不能整理。");
    }
    const project = await this.#projects.resolve(projectId);
    const record = await this.#disk.read(sessionId);
    if (!record) {
      throw new Error("找不到这个会话。");
    }
    await assertCwdBelongs(record.cwd, project.path);
  }

  async #permanentlyDelete(sessionId: string): Promise<void> {
    await this.#disk.delete(sessionId);
    await this.#store.delete(sessionId);
  }

  #toSummary(record: {
    id: string;
    title: string;
    preview: string;
    createdAt: number;
    updatedAt: number;
  }): SessionSummary {
    return {
      id: record.id,
      title: record.title,
      preview: record.preview,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      state: this.#isRunning(record.id) ? "active" : "idle",
      pending: false,
      deletedAt: null,
      purgeAt: null,
    };
  }

  #mutateMany(
    projectId: string,
    sessionIds: string[],
    change: SessionChangeEvent["change"],
    operation: (resolvedProjectId: string, sessionId: string) => Promise<void>,
  ): Promise<SessionMutationResult> {
    return this.#serializeMutation(async () => {
      await this.#projects.resolve(projectId);
      const result: SessionMutationResult = { succeeded: [], failed: [] };
      for (const sessionId of [...new Set(sessionIds)]) {
        try {
          await operation(projectId, sessionId);
          result.succeeded.push(sessionId);
        } catch (error) {
          result.failed.push({
            sessionId,
            message: error instanceof Error ? error.message : "操作失败。",
          });
        }
      }
      if (result.succeeded.length > 0) {
        this.#emit({ projectId, sessionIds: result.succeeded, change });
      }
      return result;
    });
  }

  #serializeMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(() => {}, () => {});
    return result;
  }

  #emit(event: SessionChangeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // 一个浏览器连接的通知失败不应中断已经完成的会话整理操作。
      }
    }
  }
}

function pendingSummary(meta: {
  id: string;
  title: string;
  createdAt: number;
}): SessionSummary {
  return {
    id: meta.id,
    title: meta.title,
    preview: "",
    createdAt: meta.createdAt,
    updatedAt: meta.createdAt,
    state: "idle",
    pending: true,
    deletedAt: null,
    purgeAt: null,
  };
}

function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

async function assertCwdBelongs(sessionCwd: string, projectPath: string): Promise<void> {
  let realSession: string;
  try {
    realSession = await realpath(sessionCwd);
  } catch {
    throw new Error("会话工作目录无效。");
  }
  if (realSession !== projectPath) {
    throw new Error("会话不属于当前项目。");
  }
}
