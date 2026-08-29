import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PENDING_SESSION_PREFIX, type PermissionMode } from "./types.ts";

export type StoredSessionMeta = {
  id: string;
  projectId: string;
  grokSessionId: string | null;
  permissionMode: PermissionMode;
  title: string;
  createdAt: number;
  clientMessageIds: Record<string, string>;
  clientMessagePayloads: Record<string, { text: string; attachmentIds: string[] }>;
};

export type StoredEvent = {
  seq: number;
  ts: number;
  event: Record<string, unknown> & { type: string };
};

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GROK_REMOTE_STATE_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".grok-remote");
}

export class RemoteSessionStore {
  readonly #root: string;
  readonly #writeTails = new Map<string, Promise<void>>();
  readonly #seqs = new Map<string, number>();

  constructor(stateDir: string) {
    this.#root = stateDir;
  }

  sessionDir(sessionId: string): string {
    return path.join(this.#root, "sessions", sanitizeId(sessionId));
  }

  async readMeta(sessionId: string): Promise<StoredSessionMeta | null> {
    try {
      const raw = await readFile(path.join(this.sessionDir(sessionId), "meta.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isMeta(parsed)) return null;
      return {
        ...parsed,
        clientMessageIds: isStringRecord(parsed.clientMessageIds) ? parsed.clientMessageIds : {},
        clientMessagePayloads: isClientMessagePayloadRecord(parsed.clientMessagePayloads)
          ? parsed.clientMessagePayloads
          : {},
      };
    } catch {
      return null;
    }
  }

  async writeMeta(meta: StoredSessionMeta): Promise<void> {
    const dir = this.sessionDir(meta.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  async createPending(projectId: string, title = "新会话"): Promise<StoredSessionMeta> {
    const id = `${PENDING_SESSION_PREFIX}${randomUUID()}`;
    const meta: StoredSessionMeta = {
      id,
      projectId,
      grokSessionId: null,
      permissionMode: "ask",
      title,
      createdAt: Math.floor(Date.now() / 1_000),
      clientMessageIds: {},
      clientMessagePayloads: {},
    };
    await this.writeMeta(meta);
    return meta;
  }

  async bindGrokSession(pendingId: string, grokSessionId: string): Promise<StoredSessionMeta> {
    return this.#enqueue(pendingId, () => this.#bindGrokSessionNow(pendingId, grokSessionId));
  }

  async #bindGrokSessionNow(pendingId: string, grokSessionId: string): Promise<StoredSessionMeta> {
    const pending = await this.readMeta(pendingId);
    if (!pending) {
      throw new Error("找不到待绑定的会话。");
    }
    const bound: StoredSessionMeta = {
      ...pending,
      id: grokSessionId,
      grokSessionId,
    };
    await this.writeMeta(bound);
    if (pendingId !== grokSessionId) {
      const fromDir = this.sessionDir(pendingId);
      const toDir = this.sessionDir(grokSessionId);
      try {
        const events = await readFile(path.join(fromDir, "events.jsonl"));
        await writeFile(path.join(toDir, "events.jsonl"), events);
      } catch {
        // 还没有事件日志。
      }
      try {
        const seq = await readFile(path.join(fromDir, "seq"));
        await writeFile(path.join(toDir, "seq"), seq);
      } catch {
        // 还没有序号。
      }
      const pendingSeq = this.#seqs.get(pendingId);
      if (pendingSeq !== undefined) {
        this.#seqs.set(grokSessionId, pendingSeq);
        this.#seqs.delete(pendingId);
      }
      await rm(fromDir, { recursive: true, force: true });
    }
    return bound;
  }

  async listMeta(): Promise<StoredSessionMeta[]> {
    const root = path.join(this.#root, "sessions");
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch {
      return [];
    }
    const result: StoredSessionMeta[] = [];
    for (const name of names) {
      const meta = await this.readMeta(name);
      if (meta) result.push(meta);
    }
    return result;
  }

  async appendEvent(
    sessionId: string,
    event: Record<string, unknown> & { type: string },
  ): Promise<StoredEvent> {
    return this.#enqueue(sessionId, () => this.#appendEventNow(sessionId, event));
  }

  async #appendEventNow(
    sessionId: string,
    event: Record<string, unknown> & { type: string },
  ): Promise<StoredEvent> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    const seq = await this.#nextSeq(sessionId);
    this.#seqs.set(sessionId, seq);
    const stored: StoredEvent = {
      seq,
      ts: Date.now(),
      event: { sessionId, ...event, seq },
    };
    await writeFile(
      path.join(dir, "events.jsonl"),
      `${JSON.stringify(stored)}\n`,
      { encoding: "utf8", flag: "a" },
    );
    await writeFile(path.join(dir, "seq"), `${seq}\n`, "utf8");
    return stored;
  }

  async eventsSince(sessionId: string, afterSeq: number): Promise<StoredEvent[]> {
    const file = path.join(this.sessionDir(sessionId), "events.jsonl");
    let source = "";
    try {
      source = await readFile(file, "utf8");
    } catch {
      return [];
    }
    const events: StoredEvent[] = [];
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isStoredEvent(parsed)) continue;
        if (parsed.seq > afterSeq) events.push(parsed);
      } catch {
        continue;
      }
    }
    return events;
  }

  async lastSeq(sessionId: string): Promise<number> {
    try {
      const raw = await readFile(path.join(this.sessionDir(sessionId), "seq"), "utf8");
      const value = Number(raw.trim());
      return Number.isInteger(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  async delete(sessionId: string): Promise<void> {
    this.#seqs.delete(sessionId);
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  async deleteUnboundPending(): Promise<number> {
    const metas = await this.listMeta();
    let deleted = 0;
    for (const meta of metas) {
      if (!meta.id.startsWith(PENDING_SESSION_PREFIX)) continue;
      if (meta.grokSessionId) continue;
      await this.delete(meta.id);
      deleted += 1;
    }
    return deleted;
  }

  async #nextSeq(sessionId: string): Promise<number> {
    const cached = this.#seqs.get(sessionId);
    if (cached !== undefined) return cached + 1;
    return (await this.lastSeq(sessionId)) + 1;
  }

  #enqueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#writeTails.get(sessionId) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.#writeTails.set(sessionId, current.then(() => undefined, () => undefined));
    return current;
  }
}

function sanitizeId(sessionId: string): string {
  if (!/^[\w.-]+$/u.test(sessionId)) {
    throw new Error("会话 ID 不合法。");
  }
  return sessionId;
}

function isMeta(value: unknown): value is StoredSessionMeta {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as StoredSessionMeta).id === "string" &&
    typeof (value as StoredSessionMeta).projectId === "string";
}

function isStoredEvent(value: unknown): value is StoredEvent {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as StoredEvent).seq === "number" &&
    typeof (value as StoredEvent).event === "object";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

function isClientMessagePayloadRecord(
  value: unknown,
): value is Record<string, { text: string; attachmentIds: string[] }> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
      typeof (entry as { text?: unknown }).text === "string" &&
      Array.isArray((entry as { attachmentIds?: unknown }).attachmentIds) &&
      ((entry as { attachmentIds: unknown[] }).attachmentIds).every((id) =>
        typeof id === "string"
      )
    );
}
