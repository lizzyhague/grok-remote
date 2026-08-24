import { realpath } from "node:fs/promises";

import type { ProjectCatalog } from "../projects/catalog.ts";
import { GrokSessionDisk } from "./disk.ts";
import { parseUpdatesJsonl } from "./history.ts";
import { RemoteSessionStore } from "./store.ts";
import {
  HISTORY_PAGE_SIZE,
  PENDING_SESSION_PREFIX,
  type SessionPage,
  type SessionSummary,
  type TurnSnapshot,
} from "./types.ts";

export type { SessionPage, SessionSummary };

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
  change: "delete" | "create" | "update";
};

export class SessionService {
  readonly #projects: ProjectCatalog;
  readonly #disk: GrokSessionDisk;
  readonly #store: RemoteSessionStore;
  readonly #listeners = new Set<(event: SessionChangeEvent) => void>();

  constructor(projects: ProjectCatalog, disk: GrokSessionDisk, store: RemoteSessionStore) {
    this.#projects = projects;
    this.#disk = disk;
    this.#store = store;
  }

  onChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async list(projectId: string, options: {
    cursor?: string | null;
    searchTerm?: string | null;
  } = {}): Promise<SessionPage> {
    const project = await this.#projects.resolve(projectId);
    const fromDisk = await this.#disk.listForCwd(project.path);
    const extra = (await this.#store.listMeta()).filter((meta) =>
      meta.projectId === projectId && meta.id.startsWith(PENDING_SESSION_PREFIX)
    );

    const sessions: SessionSummary[] = [
      ...extra.map((meta) => ({
        id: meta.id,
        title: meta.title,
        preview: "",
        createdAt: meta.createdAt,
        updatedAt: meta.createdAt,
        state: "idle" as const,
        pending: true,
      })),
      ...fromDisk.map((record) => ({
        id: record.id,
        title: record.title,
        preview: record.preview,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        state: "idle" as const,
        pending: false,
      })),
    ];

    const search = options.searchTerm?.trim().toLowerCase() ?? "";
    const filtered = search
      ? sessions.filter((session) =>
        session.title.toLowerCase().includes(search) ||
        session.preview.toLowerCase().includes(search)
      )
      : sessions;

    filtered.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));

    const offset = decodeCursor(options.cursor ?? null);
    const page = filtered.slice(offset, offset + 50);
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
      session: {
        id: meta.id,
        title: meta.title,
        preview: "",
        createdAt: meta.createdAt,
        updatedAt: meta.createdAt,
        state: "idle",
        pending: true,
      },
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
        session: {
          id: meta.id,
          title: meta.title,
          preview: "",
          createdAt: meta.createdAt,
          updatedAt: meta.createdAt,
          state: "idle",
          pending: true,
        },
        tasks: [],
        older: [],
        activeTurnId: null,
        alwaysApprove: meta.permissionMode === "always-approve",
        lastSeq: await this.#store.lastSeq(sessionId),
        resumeAfterSeq: await this.#resumeAfterSeq(sessionId),
      };
    }

    const record = await this.#disk.read(sessionId);
    if (!record) {
      throw new Error("会话不存在，或不属于这个项目。");
    }
    await assertCwdBelongs(record.cwd, project.path);

    const updates = await this.#disk.readUpdatesJsonl(sessionId);
    const turns = parseUpdatesJsonl(updates);
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
      });
    }

    return {
      session: {
        id: record.id,
        title: record.title,
        preview: record.preview,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        state: "idle",
        pending: false,
      },
      tasks: turns.slice(visibleStart),
      older: turns.slice(0, visibleStart),
      activeTurnId: null,
      alwaysApprove: meta?.permissionMode === "always-approve",
      lastSeq: await this.#store.lastSeq(sessionId),
      resumeAfterSeq: await this.#resumeAfterSeq(sessionId),
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

  async delete(projectId: string, sessionIds: string[]): Promise<{
    succeeded: string[];
    failed: Array<{ sessionId: string; message: string }>;
  }> {
    await this.#projects.resolve(projectId);
    const succeeded: string[] = [];
    const failed: Array<{ sessionId: string; message: string }> = [];
    for (const sessionId of sessionIds) {
      try {
        if (sessionId.startsWith(PENDING_SESSION_PREFIX)) {
          await this.#store.delete(sessionId);
        } else {
          const removed = await this.#disk.delete(sessionId);
          await this.#store.delete(sessionId);
          if (!removed) {
            throw new Error("找不到这个会话。");
          }
        }
        succeeded.push(sessionId);
      } catch (error) {
        failed.push({
          sessionId,
          message: error instanceof Error ? error.message : "删除失败。",
        });
      }
    }
    if (succeeded.length) {
      this.#emit({ projectId, sessionIds: succeeded, change: "delete" });
    }
    return { succeeded, failed };
  }

  #emit(event: SessionChangeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
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
