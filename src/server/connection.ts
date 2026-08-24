import { timingSafeEqual } from "node:crypto";

import { COMMAND_CATALOG } from "../commands/catalog.ts";
import { CommandRunner } from "../commands/runner.ts";
import type { ProjectSummary } from "../projects/catalog.ts";
import type { PresenceTracker } from "./presence.ts";
import { publicErrorMessage } from "./public-error.ts";
import {
  parseBrowserRequest,
  ProtocolError,
  type BrowserMessage,
  type BrowserRequest,
} from "./protocol.ts";
import { ProjectTaskLocks } from "./project-locks.ts";
import type { OpenedSession, SessionChangeEvent, SessionPage } from "../sessions/service.ts";
import type { TurnSnapshot } from "../sessions/types.ts";
import type { ApprovalView, BrowserTurnEvent } from "../turns/runtime.ts";

export interface BrowserSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ProjectsApi {
  list(): Promise<ProjectSummary[]>;
}

export interface SessionsApi {
  list(projectId: string, options?: {
    cursor?: string | null;
    searchTerm?: string | null;
  }): Promise<SessionPage>;
  start(projectId: string): Promise<OpenedSession>;
  open(projectId: string, sessionId: string): Promise<OpenedSession>;
  delete(projectId: string, sessionIds: string[]): Promise<{
    succeeded: string[];
    failed: Array<{ sessionId: string; message: string }>;
  }>;
  onChange?(listener: (event: SessionChangeEvent) => void): () => void;
}

export type TurnApi = {
  onEvent(listener: (event: BrowserTurnEvent) => void): () => void;
  sendMessage(input: {
    projectId: string;
    sessionId: string;
    text: string;
    clientMessageId: string;
  }): Promise<{ accepted: true; turnId: string; sessionId: string; clientMessageId: string }>;
  stop(sessionId: string): Promise<void>;
  toggleAlwaysApprove(sessionId: string): Promise<{ enabled: boolean }>;
  answerApproval(
    approvalId: string,
    decision: "approve_once" | "decline",
    optionId: string | null,
  ): Promise<boolean>;
  eventsSince(sessionId: string, afterSeq: number): Promise<BrowserTurnEvent[]>;
  pendingApprovals(sessionId: string): ApprovalView[];
  activeTurnId(sessionId: string): string | null;
};

export type BrowserConnectionServices = {
  projects: ProjectsApi;
  sessions: SessionsApi;
  turns: TurnApi;
  commands: CommandRunner;
  locks: ProjectTaskLocks;
  presence: PresenceTracker;
};

export class BrowserRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserRequestError";
    this.code = code;
  }
}

export class BrowserConnection {
  readonly #id: string;
  readonly #socket: BrowserSocket;
  readonly #expectedToken: string;
  readonly #services: BrowserConnectionServices;
  readonly #unsubscribeTurns: () => void;
  readonly #unsubscribeSessionChanges: () => void;
  #authenticated = false;
  #countedPresence = false;
  #disconnected = false;
  #queue: Promise<void> = Promise.resolve();
  #projectId: string | null = null;
  #sessionId: string | null = null;
  #older: TurnSnapshot[] = [];
  #alwaysApprove = false;

  constructor(
    id: string,
    socket: BrowserSocket,
    expectedToken: string,
    services: BrowserConnectionServices,
  ) {
    if (!expectedToken) {
      throw new Error("WebSocket 访问令牌不能为空。");
    }
    this.#id = id;
    this.#socket = socket;
    this.#expectedToken = expectedToken;
    this.#services = services;
    this.#unsubscribeTurns = services.turns.onEvent((event) => {
      this.#handleTurnEvent(event);
    });
    this.#unsubscribeSessionChanges = services.sessions.onChange?.((event) => {
      this.#send({
        type: "event",
        event: { type: "session.changed", ...event },
      });
    }) ?? (() => {});
  }

  get authenticated(): boolean {
    return this.#authenticated;
  }

  receiveText(source: string): void {
    if (this.#disconnected) return;
    this.#queue = this.#queue.then(() => this.#process(source)).catch((error: unknown) => {
      this.#send({
        type: "error",
        requestId: null,
        error: { code: "internal_error", message: publicErrorMessage(error) },
      });
    });
  }

  whenIdle(): Promise<void> {
    return this.#queue;
  }

  async disconnect(): Promise<void> {
    if (this.#disconnected) return;
    this.#disconnected = true;
    this.#unsubscribeTurns();
    this.#unsubscribeSessionChanges();
    if (this.#countedPresence) {
      this.#services.presence.remove();
      this.#countedPresence = false;
    }
    if (this.#projectId) {
      this.#services.locks.release(this.#projectId, this.#id);
    }
  }

  async #process(source: string): Promise<void> {
    let request: BrowserRequest;
    try {
      request = parseBrowserRequest(source);
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.#send({
          type: "error",
          requestId: error.requestId,
          error: { code: error.code, message: error.message },
        });
        return;
      }
      throw error;
    }

    if (request.type === "auth") {
      this.#handleAuth(request);
      return;
    }
    if (!this.#authenticated) {
      this.#sendFailure(request.requestId, "not_authenticated", "请先验证访问令牌。");
      this.#socket.close(1008, "Authentication required");
      return;
    }

    try {
      const data = await this.#dispatch(request);
      this.#send({ type: "response", requestId: request.requestId, ok: true, data });
    } catch (error) {
      const code = error instanceof BrowserRequestError ? error.code : "request_failed";
      this.#sendFailure(request.requestId, code, publicErrorMessage(error));
    }
  }

  #handleAuth(request: Extract<BrowserRequest, { type: "auth" }>): void {
    if (this.#authenticated) {
      this.#sendFailure(request.requestId, "already_authenticated", "连接已经验证过了。");
      return;
    }
    if (!tokensEqual(request.token, this.#expectedToken)) {
      this.#sendFailure(request.requestId, "invalid_token", "访问令牌不正确。");
      this.#socket.close(1008, "Invalid token");
      return;
    }
    this.#authenticated = true;
    this.#services.presence.add();
    this.#countedPresence = true;
    this.#send({
      type: "response",
      requestId: request.requestId,
      ok: true,
      data: { authenticated: true },
    });
  }

  async #dispatch(request: Exclude<BrowserRequest, { type: "auth" }>): Promise<unknown> {
    switch (request.type) {
      case "projects.list":
        return { projects: await this.#services.projects.list() };
      case "sessions.list":
        return await this.#services.sessions.list(request.projectId, {
          cursor: request.cursor,
          searchTerm: request.searchTerm,
        });
      case "sessions.delete":
        return this.#deleteSessions(request.projectId, request.sessionIds);
      case "session.start":
        return this.#open(request.projectId, await this.#services.sessions.start(request.projectId));
      case "session.resume":
        return this.#open(
          request.projectId,
          await this.#services.sessions.open(request.projectId, request.sessionId),
        );
      case "history.older":
        return this.#loadOlder();
      case "events.resume":
        return {
          events: this.#sessionId
            ? await this.#services.turns.eventsSince(this.#sessionId, request.afterSeq)
            : [],
        };
      case "commands.list":
        return { commands: COMMAND_CATALOG };
      case "command.options":
        return this.#services.commands.options(request.command);
      case "command.run":
        return this.#runCommand(request);
      case "permissions.always-approve.toggle":
        return this.#toggleAlwaysApprove();
      case "message.send":
        return this.#sendMessage(request.text, request.clientMessageId);
      case "task.stop":
        return this.#stopTask();
      case "approval.answer":
        return this.#answerApproval(request.approvalId, request.decision, request.optionId);
    }
  }

  async #deleteSessions(projectId: string, sessionIds: string[]): Promise<unknown> {
    if (!this.#services.locks.acquire(projectId, this.#id, sessionIds[0] ?? "delete")) {
      throw new BrowserRequestError("project_busy", "这个项目正在执行任务，暂时不能删除会话。");
    }
    try {
      const result = await this.#services.sessions.delete(projectId, sessionIds);
      if (this.#sessionId && result.succeeded.includes(this.#sessionId)) {
        this.#clearSession();
      }
      return result;
    } finally {
      if (!this.#services.turns.activeTurnId(this.#sessionId ?? "")) {
        this.#services.locks.release(projectId, this.#id);
      }
    }
  }

  #open(projectId: string, opened: OpenedSession): unknown {
    this.#projectId = projectId;
    this.#sessionId = opened.session.id;
    this.#older = opened.older;
    this.#alwaysApprove = opened.alwaysApprove;
    const approvals = this.#services.turns.pendingApprovals(opened.session.id);
    return {
      session: opened.session,
      tasks: opened.tasks,
      activeTaskId: this.#services.turns.activeTurnId(opened.session.id) ?? opened.activeTurnId,
      hasOlder: opened.older.length > 0,
      alwaysApprove: opened.alwaysApprove,
      lastSeq: opened.lastSeq,
      resumeAfterSeq: opened.resumeAfterSeq,
      pendingApprovals: approvals,
      controlsActiveTask: this.#services.locks.owns(projectId, this.#id),
    };
  }

  #loadOlder(): { tasks: TurnSnapshot[]; hasOlder: boolean } {
    const start = Math.max(0, this.#older.length - 20);
    const tasks = this.#older.slice(start);
    this.#older.length = start;
    return { tasks, hasOlder: this.#older.length > 0 };
  }

  async #sendMessage(text: string, clientMessageId: string): Promise<unknown> {
    const sessionId = this.#requireSession();
    const projectId = this.#projectId!;
    if (!this.#services.locks.acquire(projectId, this.#id, sessionId)) {
      throw new BrowserRequestError("project_busy", "这个项目已有另一个任务正在运行。");
    }
    try {
      const result = await this.#services.turns.sendMessage({
        projectId,
        sessionId,
        text,
        clientMessageId,
      });
      if (result.sessionId !== sessionId) {
        this.#sessionId = result.sessionId;
      }
      this.#services.locks.setTaskId(projectId, this.#id, result.turnId);
      return result;
    } catch (error) {
      this.#services.locks.release(projectId, this.#id);
      throw error;
    }
  }

  async #stopTask(): Promise<unknown> {
    const sessionId = this.#requireSession();
    const projectId = this.#projectId!;
    if (!this.#services.locks.owns(projectId, this.#id)) {
      throw new BrowserRequestError("project_busy", "当前设备不能停止这个任务。");
    }
    await this.#services.turns.stop(sessionId);
    this.#services.locks.release(projectId, this.#id);
    return { stopped: true };
  }

  async #toggleAlwaysApprove(): Promise<unknown> {
    const sessionId = this.#requireSession();
    const result = await this.#services.turns.toggleAlwaysApprove(sessionId);
    this.#alwaysApprove = result.enabled;
    return result;
  }

  async #runCommand(request: Extract<BrowserRequest, { type: "command.run" }>): Promise<unknown> {
    const sessionId = this.#requireSession();
    if (request.command === "always-approve") {
      return this.#toggleAlwaysApprove();
    }
    const projectId = this.#projectId!;
    if (!this.#services.locks.acquire(projectId, this.#id, sessionId)) {
      throw new BrowserRequestError("project_busy", "这个项目已有另一个任务正在运行。");
    }
    try {
      const result = await this.#services.commands.run(
        sessionId,
        request.command,
        request.option,
        request.argument,
      );
      if (hasTurnId(result)) {
        this.#services.locks.setTaskId(projectId, this.#id, result.turnId);
      } else {
        this.#services.locks.release(projectId, this.#id);
      }
      return result;
    } catch (error) {
      this.#services.locks.release(projectId, this.#id);
      throw error;
    }
  }

  async #answerApproval(
    approvalId: string,
    decision: "approve_once" | "decline",
    optionId: string | null,
  ): Promise<unknown> {
    const ok = await this.#services.turns.answerApproval(approvalId, decision, optionId);
    if (!ok) {
      throw new BrowserRequestError("approval_missing", "这个审批已经结束。");
    }
    return { answered: true };
  }

  #handleTurnEvent(event: BrowserTurnEvent): void {
    if (!this.#authenticated) return;
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : null;
    const pendingId = typeof event.pendingId === "string" ? event.pendingId : null;
    if (
      this.#sessionId &&
      sessionId !== this.#sessionId &&
      pendingId !== this.#sessionId
    ) {
      return;
    }
    if (event.type === "session.bound" && typeof event.sessionId === "string") {
      this.#sessionId = event.sessionId;
    }
    if (event.type === "turn.status") {
      const status = event.status;
      if (status === "completed" || status === "interrupted" || status === "failed") {
        if (this.#projectId) this.#services.locks.release(this.#projectId, this.#id);
      }
    }
    this.#send({ type: "event", event });
  }

  #requireSession(): string {
    if (!this.#sessionId || !this.#projectId) {
      throw new BrowserRequestError("no_session", "请先打开一个会话。");
    }
    return this.#sessionId;
  }

  #clearSession(): void {
    this.#sessionId = null;
    this.#older = [];
    this.#alwaysApprove = false;
  }

  #sendFailure(requestId: string, code: string, message: string): void {
    this.#send({
      type: "response",
      requestId,
      ok: false,
      error: { code, message },
    });
  }

  #send(message: BrowserMessage): void {
    if (!this.#disconnected) {
      this.#socket.send(JSON.stringify(message));
    }
  }
}

function tokensEqual(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function hasTurnId(value: unknown): value is { turnId: string } {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { turnId?: unknown }).turnId === "string";
}

export type { ApprovalView };
