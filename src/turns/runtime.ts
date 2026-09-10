import { randomUUID } from "node:crypto";

import {
  attachmentDisplayText,
  buildGrokPrompt,
  GrokAttachmentError,
  validateGrokAttachments,
} from "../attachments/grok-input.ts";
import type { AttachmentDisplayMapping } from "../attachments/path-redaction.ts";
import {
  AttachmentPathStreamRedactor,
  redactKnownAttachmentPaths,
  redactKnownAttachmentPathsDeep,
} from "../attachments/path-redaction.ts";
import { stripPrivateAttachmentPaths } from "../attachments/private-paths.ts";
import {
  memoryDegradedMessage,
  readAvailableMemory,
  type MemoryReading,
} from "../platform/system-resources.ts";
import type { ResolvedProject } from "../projects/catalog.ts";
import type { PresenceTracker } from "../server/presence.ts";
import type { AttachmentDisplayIndex } from "../sessions/attachment-index.ts";
import { PENDING_SESSION_PREFIX } from "../sessions/types.ts";
import type { RemoteSessionStore, StoredSessionMeta } from "../sessions/store.ts";
import type { SharedUploadClient } from "../shared-upload/client.ts";
import {
  type AttachmentLease,
  type PublicAttachment,
  type ResolvedAttachment,
  SharedUploadError,
} from "../shared-upload/types.ts";
import {
  AcpClient,
  type AcpPermissionRequest,
  type AcpSessionInfo,
  type AcpUpdate,
} from "../worker/acp-client.ts";
import {
  createPublicToolView,
  exposesToolText,
  updatePublicToolView,
  type PublicToolView,
} from "./tool-view.ts";
import {
  assertWorkerCapacity,
  DEFAULT_MAX_WORKERS,
  DEFAULT_MIN_FREE_MEMORY_BYTES,
  spawnGrokAgent,
  terminateAgent,
  type SpawnAgent,
  type SpawnedAgent,
} from "../worker/process.ts";

export type BrowserTurnEvent = Record<string, unknown> & { type: string; sessionId?: string };

export type ApprovalView = {
  approvalId: string;
  sessionId: string;
  kind: "command" | "file_change" | "user_input" | "other";
  reason: string | null;
  options: Array<{ optionId: string; name: string }>;
  startedAtMs: number;
};

export class TurnRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TurnRuntimeError";
    this.code = code;
  }
}

type QueuedWork =
  | {
    kind: "prompt";
    turnId: string;
    text: string;
    clientMessageId: string | null;
    modeId: string | null;
    attachments: ResolvedAttachment[];
  }
  | { kind: "compact"; turnId: string };

type LiveWorker = {
  sessionKey: string;
  grokSessionId: string | null;
  cwd: string;
  yolo: boolean;
  agent: SpawnedAgent;
  client: AcpClient;
  queue: QueuedWork[];
  busy: boolean;
  enqueuing: number;
  closing: boolean;
  stopReason: string | null;
  attached: boolean;
  updates: Promise<void>;
  currentTurnId: string | null;
  currentAssistantItemId: string | null;
  assistantSegment: number;
  tools: Map<string, PublicToolView>;
  pathRedactors: Map<string, { kind: "message" | "command"; redactor: AttachmentPathStreamRedactor }>;
  pendingApproval: PendingApproval | null;
};

type PendingApproval = {
  approval: ApprovalView;
  rpcId: number | string;
  human: boolean;
};

export class TurnRuntime {
  readonly #store: RemoteSessionStore;
  readonly #projects: { resolve(projectId: string): Promise<ResolvedProject> };
  readonly #presence: PresenceTracker;
  readonly #grokBin: string;
  readonly #spawn: SpawnAgent;
  readonly #maxWorkers: number;
  readonly #minFreeMemoryBytes: number;
  readonly #availableMemory: () => Promise<MemoryReading>;
  readonly #uploads: Pick<
    SharedUploadClient,
    "createLease" | "renewLease" | "releaseLease"
  > | undefined;
  readonly #attachmentIndex: AttachmentDisplayIndex | null;
  readonly #listeners = new Set<(event: BrowserTurnEvent) => void>();
  readonly #workers = new Map<string, LiveWorker>();
  readonly #approvals = new Map<string, { worker: LiveWorker; pending: PendingApproval }>();
  readonly #attachmentLeases = new Map<string, AttachmentLease>();
  readonly #unsubscribePresence: () => void;
  #attachmentLeaseTimer: NodeJS.Timeout | null = null;
  #modelCache: ModelOption[] = [];

  constructor(options: {
    store: RemoteSessionStore;
    projects: { resolve(projectId: string): Promise<ResolvedProject> };
    presence: PresenceTracker;
    grokBin: string;
    spawnAgent?: SpawnAgent;
    maxWorkers?: number;
    minFreeMemoryBytes?: number;
    availableMemory?: () => Promise<MemoryReading>;
    uploads?: Pick<SharedUploadClient, "createLease" | "renewLease" | "releaseLease">;
    attachmentIndex?: AttachmentDisplayIndex;
  }) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#presence = options.presence;
    this.#grokBin = options.grokBin;
    this.#spawn = options.spawnAgent ?? spawnGrokAgent;
    this.#maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
    this.#minFreeMemoryBytes = options.minFreeMemoryBytes ?? DEFAULT_MIN_FREE_MEMORY_BYTES;
    this.#availableMemory = options.availableMemory ?? readAvailableMemory;
    this.#uploads = options.uploads;
    this.#attachmentIndex = options.attachmentIndex ?? null;
    if (this.#uploads) {
      this.#attachmentLeaseTimer = setInterval(() => {
        void this.#renewAttachmentLeases();
      }, 5 * 60 * 1_000);
      this.#attachmentLeaseTimer.unref();
    }
    this.#unsubscribePresence = this.#presence.subscribe({
      onGraceExpired: () => {
        void this.interruptUnattended();
      },
    });
  }

  onEvent(listener: (event: BrowserTurnEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  activeTurnId(sessionId: string): string | null {
    return this.#workers.get(sessionId)?.currentTurnId ?? null;
  }

  isBusy(sessionId: string): boolean {
    const worker = this.#workers.get(sessionId);
    if (!worker) return false;
    return worker.busy || worker.enqueuing > 0 || worker.closing ||
      worker.queue.length > 0 || worker.currentTurnId !== null;
  }

  pendingApprovals(sessionId: string): ApprovalView[] {
    const mappings = this.#peekMappings(sessionId);
    return [...this.#approvals.values()]
      .filter((entry) => entry.pending.approval.sessionId === sessionId)
      .map((entry) => redactKnownAttachmentPathsDeep(entry.pending.approval, mappings));
  }

  cachedModels(): ModelOption[] {
    return this.#modelCache;
  }

  async sendMessage(input: {
    projectId: string;
    sessionId: string;
    text: string;
    clientMessageId: string;
    attachmentIds: string[];
  }): Promise<{ accepted: true; turnId: string; sessionId: string; clientMessageId: string }> {
    const meta = await this.#requireMeta(input.projectId, input.sessionId);
    const existing = meta.clientMessageIds[input.clientMessageId];
    if (existing) {
      const previous = meta.clientMessagePayloads[input.clientMessageId];
      if (
        (previous && (previous.text !== input.text ||
          JSON.stringify(previous.attachmentIds) !== JSON.stringify(input.attachmentIds))) ||
        (!previous && input.attachmentIds.length > 0)
      ) {
        throw new TurnRuntimeError(
          "client_message_conflict",
          "这个客户端消息 ID 已用于另一组正文或附件。",
        );
      }
      return {
        accepted: true,
        turnId: existing,
        sessionId: meta.grokSessionId ?? meta.id,
        clientMessageId: input.clientMessageId,
      };
    }
    const turnId = randomUUID();
    let lease: AttachmentLease | null = null;
    try {
      if (input.attachmentIds.length > 0) {
        if (!this.#uploads) {
          throw new TurnRuntimeError("uploads_unavailable", "当前后端没有启用附件服务。");
        }
        lease = await this.#uploads.createLease(
          { caller: "grok", projectId: meta.projectId, sessionId: meta.id },
          turnId,
          input.attachmentIds,
        );
        validateGrokAttachments(lease.attachments);
      }
      const worker = await this.#ensureWorker(meta);
      await this.#enqueue(worker, async () => {
        meta.clientMessageIds[input.clientMessageId] = turnId;
        meta.clientMessagePayloads[input.clientMessageId] = {
          text: input.text,
          attachmentIds: [...input.attachmentIds],
        };
        await this.#store.writeMeta(meta);
        try {
          await this.#emit(meta.id, {
            type: "turn.accepted",
            turnId,
            clientMessageId: input.clientMessageId,
            status: "queued",
            attachments: lease?.attachments.map(publicAttachment) ?? [],
          });
        } catch (error) {
          delete meta.clientMessageIds[input.clientMessageId];
          delete meta.clientMessagePayloads[input.clientMessageId];
          await this.#store.writeMeta(meta).catch(() => {});
          throw error;
        }
        if (lease) this.#attachmentLeases.set(turnId, lease);
        worker.queue.push({
          kind: "prompt",
          turnId,
          text: input.text,
          clientMessageId: input.clientMessageId,
          modeId: null,
          attachments: lease?.attachments ?? [],
        });
      });
      return {
        accepted: true,
        turnId,
        sessionId: meta.grokSessionId ?? meta.id,
        clientMessageId: input.clientMessageId,
      };
    } catch (error) {
      if (lease) await this.#releaseAttachmentLease(turnId, lease);
      throw runtimeAttachmentError(error);
    }
  }

  async runPrompt(sessionId: string, text: string): Promise<{ turnId: string }> {
    const meta = await this.#store.readMeta(sessionId);
    if (!meta) throw new Error("请先打开一个会话。");
    const turnId = randomUUID();
    const worker = await this.#ensureWorker(meta);
    await this.#enqueue(worker, async () => {
      await this.#emit(meta.id, {
        type: "turn.accepted",
        turnId,
        status: "queued",
      });
      worker.queue.push({
        kind: "prompt",
        turnId,
        text,
        clientMessageId: null,
        modeId: null,
        attachments: [],
      });
    });
    return { turnId };
  }

  async inspectSession(sessionId: string): Promise<AcpSessionInfo> {
    return this.#withAttached(sessionId, async (worker, grokSessionId) => {
      const info = await worker.client.sessionInfo(grokSessionId);
      const shellVersion = initializeAgentVersion(worker.client.initializeResult);
      return shellVersion ? { ...info, shellVersion } : info;
    });
  }

  async setModel(
    sessionId: string,
    modelId: string,
    reasoningEffort: string | null,
  ): Promise<{ sessionId: string; modelId: string; reasoningEffort: string | null }> {
    return this.#withAttached(sessionId, async (worker, grokSessionId) => {
      await worker.client.sessionSetModel(grokSessionId, modelId, reasoningEffort);
      return { sessionId: grokSessionId, modelId, reasoningEffort };
    });
  }

  async setEffort(
    sessionId: string,
    reasoningEffort: string,
  ): Promise<{ sessionId: string; modelId: string; reasoningEffort: string }> {
    return this.#withAttached(sessionId, async (worker, grokSessionId) => {
      const info = await worker.client.sessionInfo(grokSessionId);
      if (!info.model) throw new Error("Grok 没有返回当前模型，无法只修改思考强度。");
      await worker.client.sessionSetModel(grokSessionId, info.model, reasoningEffort);
      return { sessionId: grokSessionId, modelId: info.model, reasoningEffort };
    });
  }

  async enterPlan(sessionId: string, prompt: string | null): Promise<{
    sessionId?: string;
    turnId?: string;
  }> {
    if (prompt) {
      const meta = await this.#requireExistingMeta(sessionId);
      const turnId = randomUUID();
      const worker = await this.#ensureWorker(meta);
      await this.#enqueue(worker, async () => {
        await this.#emit(meta.id, {
          type: "turn.accepted",
          turnId,
          status: "queued",
        });
        worker.queue.push({
          kind: "prompt",
          turnId,
          text: prompt,
          clientMessageId: null,
          modeId: "plan",
          attachments: [],
        });
      });
      return { turnId };
    }
    return this.#withAttached(sessionId, async (worker, grokSessionId) => {
      await worker.client.sessionSetMode(grokSessionId, "plan");
      return { sessionId: grokSessionId };
    });
  }

  async renameSession(
    sessionId: string,
    title: string,
  ): Promise<{ sessionId: string; title: string }> {
    return this.#withAttached(sessionId, async (worker, grokSessionId) => {
      await worker.client.sessionRename(grokSessionId, title);
      const meta = await this.#store.readMeta(worker.sessionKey);
      if (meta) {
        meta.title = title;
        await this.#store.writeMeta(meta);
      }
      await this.#emit(worker.sessionKey, { type: "session.title", title });
      return { sessionId: grokSessionId, title };
    });
  }

  async compact(sessionId: string): Promise<{ turnId: string }> {
    const meta = await this.#requireExistingMeta(sessionId);
    const turnId = randomUUID();
    const worker = await this.#ensureWorker(meta);
    await this.#enqueue(worker, async () => {
      await this.#emit(meta.id, {
        type: "turn.accepted",
        turnId,
        status: "queued",
      });
      worker.queue.push({ kind: "compact", turnId });
    });
    return { turnId };
  }

  async rewind(sessionId: string): Promise<{
    kind: "rewind";
    sessionId: string;
    promptText: string | null;
  }> {
    return this.#withAttached(sessionId, async (worker, grokSessionId) => {
      const points = await worker.client.rewindPoints(grokSessionId);
      const latest = points.toSorted((left, right) => right.prompt_index - left.prompt_index)[0];
      if (!latest) throw new Error("这个会话还没有可以回退的对话轮次。");
      const result = await worker.client.rewindConversation(grokSessionId, latest.prompt_index);
      if (!result.success) {
        throw new Error(result.error || "Grok 没有完成对话回退。");
      }
      const promptText = typeof result.prompt_text === "string" ? result.prompt_text : null;
      const visiblePrompt = promptText
        ? this.#redactText(worker.sessionKey, stripPrivateAttachmentPaths(promptText))
        : null;
      await this.#emit(worker.sessionKey, {
        type: "session.rewound",
        promptText: visiblePrompt,
      });
      return { kind: "rewind", sessionId: grokSessionId, promptText: visiblePrompt };
    });
  }

  async stop(sessionId: string): Promise<void> {
    const worker = this.#workers.get(sessionId);
    if (!worker) return;
    this.#requestStop(worker, "用户停止了本轮。");
  }

  #requestStop(worker: LiveWorker, reason: string): void {
    worker.stopReason ??= reason;
    if (worker.pendingApproval) {
      this.#resolveApproval(worker, { outcome: "cancelled" });
    }
    if (worker.grokSessionId) {
      worker.client.sessionCancel(worker.grokSessionId);
    }
  }

  async toggleAlwaysApprove(sessionId: string): Promise<{ enabled: boolean }> {
    const meta = await this.#store.readMeta(sessionId);
    if (!meta) throw new Error("请先打开一个会话。");
    meta.permissionMode = meta.permissionMode === "always-approve" ? "ask" : "always-approve";
    await this.#store.writeMeta(meta);
    const worker = this.#workers.get(sessionId) ??
      (meta.grokSessionId ? this.#workers.get(meta.grokSessionId) : undefined);
    if (worker) {
      worker.yolo = meta.permissionMode === "always-approve";
      if (worker.pendingApproval && worker.yolo && !worker.pendingApproval.human) {
        this.#autoAnswer(worker);
      }
    }
    return { enabled: meta.permissionMode === "always-approve" };
  }

  async answerApproval(
    approvalId: string,
    decision: "approve_once" | "decline",
    optionId: string | null,
  ): Promise<boolean> {
    const found = this.#approvals.get(approvalId);
    if (!found) return false;
    if (decision === "decline") {
      this.#resolveApproval(found.worker, { outcome: "cancelled" });
      return true;
    }
    const selected = optionId ??
      found.pending.approval.options.find((option) => option.optionId.includes("allow"))?.optionId ??
      found.pending.approval.options[0]?.optionId;
    if (!selected) {
      this.#resolveApproval(found.worker, { outcome: "cancelled" });
      return true;
    }
    this.#resolveApproval(found.worker, { outcome: "selected", optionId: selected });
    return true;
  }

  async eventsSince(sessionId: string, afterSeq: number): Promise<BrowserTurnEvent[]> {
    const stored = await this.#store.eventsSince(sessionId, afterSeq);
    return stored.map((item) => item.event);
  }

  async interruptUnattended(): Promise<void> {
    for (const worker of this.#workers.values()) {
      const meta = await this.#store.readMeta(worker.sessionKey);
      const always = meta?.permissionMode === "always-approve" || worker.yolo;
      const needsHuman = worker.pendingApproval?.human === true;
      if (worker.pendingApproval) {
        if (always && !worker.pendingApproval.human) {
          this.#autoAnswer(worker);
          continue;
        }
        this.#resolveApproval(worker, { outcome: "cancelled" });
      }
      if (always && !needsHuman) {
        continue;
      }
      this.#requestStop(worker, "没有人处理权限或需要用户输入，本轮已中止。");
    }
  }

  async markOrphanedTurnsInterrupted(): Promise<void> {
    for (const meta of await this.#store.listMeta()) {
      const events = await this.#store.eventsSince(meta.id, 0);
      const last = [...events].reverse().find((item) =>
        item.event.type === "turn.status" || item.event.type === "turn.accepted"
      );
      if (!last) continue;
      const status = itemStatus(last.event);
      if (status === "queued" || status === "running" || status === "waiting_for_permission") {
        await this.#emit(meta.id, {
          type: "turn.status",
          turnId: last.event.turnId,
          status: "interrupted",
          reason: "后端已重启，上一轮未能继续。",
        });
      }
    }
  }

  async dispose(): Promise<void> {
    this.#unsubscribePresence();
    if (this.#attachmentLeaseTimer) clearInterval(this.#attachmentLeaseTimer);
    this.#attachmentLeaseTimer = null;
    await Promise.all([...this.#workers.values()].map((worker) => this.#shutdown(worker)));
    await Promise.all([...this.#attachmentLeases.entries()].map(([turnId, lease]) =>
      this.#releaseAttachmentLease(turnId, lease)
    ));
    await this.#attachmentIndex?.drain();
  }

  async #ensureWorker(meta: StoredSessionMeta): Promise<LiveWorker> {
    const key = meta.grokSessionId ?? meta.id;
    const existing = this.#workers.get(meta.id) ?? (meta.grokSessionId
      ? this.#workers.get(meta.grokSessionId)
      : undefined);
    if (existing) {
      if (existing.closing || existing.stopReason) {
        throw new TurnRuntimeError("session_stopping", "当前会话正在结束任务，请稍后再试。");
      }
      return existing;
    }

    const project = await this.#projects.resolve(meta.projectId);
    const memory = await this.#availableMemory();
    assertWorkerCapacity({
      activeWorkers: this.#workers.size,
      maxWorkers: this.#maxWorkers,
      minFreeMemoryBytes: this.#minFreeMemoryBytes,
      memory,
    });
    if (memory.degradedReason) {
      console.warn(memoryDegradedMessage(memory, this.#minFreeMemoryBytes));
    }

    const agent = this.#spawn({ grokBin: this.#grokBin, cwd: project.path });
    const client = new AcpClient(agent.process);
    const worker: LiveWorker = {
      sessionKey: meta.id,
      grokSessionId: meta.grokSessionId,
      cwd: project.path,
      yolo: meta.permissionMode === "always-approve",
      agent,
      client,
      queue: [],
      busy: false,
      enqueuing: 0,
      closing: false,
      stopReason: null,
      attached: false,
      updates: Promise.resolve(),
      currentTurnId: null,
      currentAssistantItemId: null,
      assistantSegment: 0,
      tools: new Map(),
      pathRedactors: new Map(),
      pendingApproval: null,
    };

    client.on("update", (update: AcpUpdate) => {
      worker.updates = worker.updates
        .then(() => this.#onUpdate(worker, update))
        .catch((error: unknown) => {
          console.error(
            `处理 Grok 更新失败：${error instanceof Error ? error.message : String(error)}`,
          );
        });
    });
    client.on("permission", (request: AcpPermissionRequest) => {
      void this.#onPermission(worker, request);
    });
    client.on("stderr", (text: string) => {
      console.error(`Grok Worker：${text}`);
    });
    client.on("exit", () => {
      if (this.#workers.get(worker.sessionKey) === worker) {
        this.#workers.delete(worker.sessionKey);
        if (worker.grokSessionId) this.#workers.delete(worker.grokSessionId);
      }
    });

    await client.initialize();
    this.#captureModels(client.initializeResult);
    this.#workers.set(meta.id, worker);
    return worker;
  }

  async #withAttached<T>(
    sessionId: string,
    action: (worker: LiveWorker, grokSessionId: string) => Promise<T>,
  ): Promise<T> {
    const meta = await this.#requireExistingMeta(sessionId);
    const worker = await this.#ensureWorker(meta);
    if (worker.busy || worker.enqueuing > 0 || worker.queue.length > 0) {
      throw new Error("当前会话正在执行任务，请稍后再试。");
    }
    try {
      const grokSessionId = await this.#attachSession(worker);
      return await action(worker, grokSessionId);
    } finally {
      await this.#shutdown(worker);
    }
  }

  async #enqueue(worker: LiveWorker, accept: () => Promise<void>): Promise<void> {
    if (worker.closing || worker.stopReason) {
      throw new TurnRuntimeError("session_stopping", "当前会话正在结束任务，请稍后再试。");
    }
    // 落盘期间保留 Worker，不能让上一轮的清理关掉即将接收新消息的进程。
    worker.enqueuing += 1;
    try {
      await accept();
    } finally {
      worker.enqueuing -= 1;
      if (!worker.busy) {
        if (worker.queue.length > 0) void this.#drain(worker);
        else await this.#shutdown(worker);
      }
    }
  }

  async #drain(worker: LiveWorker): Promise<void> {
    if (worker.busy) return;
    worker.busy = true;
    try {
      while (worker.queue.length > 0) {
        const item = worker.queue.shift();
        if (!item) continue;
        worker.currentTurnId = item.turnId;
        worker.currentAssistantItemId = null;
        worker.assistantSegment = 0;
        worker.tools.clear();
        worker.pathRedactors.clear();
        let status: "completed" | "interrupted" | "failed" = "failed";
        let reason: string | null = null;
        await this.#emit(worker.sessionKey, {
          type: "turn.status",
          turnId: item.turnId,
          status: "running",
        });
        try {
          this.#throwIfStopped(worker);
          const grokSessionId = await this.#attachSession(worker);
          this.#throwIfStopped(worker);
          await this.#loadAttachmentMappings(worker.sessionKey);
          this.#throwIfStopped(worker);
          let stop = "end_turn";
          if (item.kind === "prompt") {
            if (item.modeId) {
              await worker.client.sessionSetMode(grokSessionId, item.modeId);
              this.#throwIfStopped(worker);
            }
            await this.#registerTaskAttachments(
              worker.sessionKey,
              item.turnId,
              item.attachments,
            );
            this.#throwIfStopped(worker);
            await this.#emit(worker.sessionKey, {
              type: "message.user",
              turnId: item.turnId,
              itemId: `${item.turnId}-user`,
              clientMessageId: item.clientMessageId,
              text: attachmentDisplayText(item.text, item.attachments),
              attachments: item.attachments.map(publicAttachment),
            });
            this.#throwIfStopped(worker);
            const result = await worker.client.sessionPrompt(
              grokSessionId,
              buildGrokPrompt(item.text, item.attachments),
            );
            stop = result.stopReason ?? "end_turn";
          } else {
            await worker.client.sessionCompact(grokSessionId);
          }
          await worker.updates;
          await this.#flushPathRedactors(worker);
          status = worker.stopReason || stop === "cancelled"
            ? "interrupted" : stop === "end_turn" ? "completed" : "failed";
          reason = worker.stopReason ?? (status === "completed" ? null : stop);
        } catch (error) {
          await this.#flushPathRedactors(worker);
          status = worker.stopReason ? "interrupted" : "failed";
          reason = worker.stopReason ?? (error instanceof Error ? error.message : "本轮失败。");
        } finally {
          await this.#releaseTaskAttachmentLease(item.turnId);
          if (worker.queue.length === 0) await this.#shutdown(worker);
          await worker.updates;
          await this.#flushPathRedactors(worker);
          worker.currentTurnId = null;
          worker.currentAssistantItemId = null;
          worker.tools.clear();
          worker.pathRedactors.clear();
        }
        await this.#emit(worker.sessionKey, {
          type: "turn.status",
          turnId: item.turnId,
          status: worker.stopReason ? "interrupted" : status,
          reason: worker.stopReason ?? reason,
        });
      }
    } finally {
      worker.busy = false;
      if (worker.queue.length > 0) {
        void this.#drain(worker);
      }
    }
  }

  #throwIfStopped(worker: LiveWorker): void {
    if (worker.stopReason) throw new Error(worker.stopReason);
  }

  async #attachSession(worker: LiveWorker): Promise<string> {
    if (worker.attached && worker.grokSessionId) {
      return worker.grokSessionId;
    }
    if (worker.grokSessionId) {
      await worker.client.sessionResume(worker.grokSessionId, worker.cwd, worker.yolo);
      worker.attached = true;
      return worker.grokSessionId;
    }

    const sessionId = await worker.client.sessionNew(worker.cwd, worker.yolo);
    const previousId = worker.sessionKey;
    const bound = await this.#store.bindGrokSession(previousId, sessionId);
    worker.grokSessionId = sessionId;
    worker.sessionKey = bound.id;
    worker.attached = true;
    this.#workers.delete(previousId);
    this.#workers.set(bound.id, worker);
    await this.#emit(bound.id, {
      type: "session.bound",
      pendingId: previousId,
      sessionId,
    });
    return sessionId;
  }

  async #onUpdate(worker: LiveWorker, payload: AcpUpdate): Promise<void> {
    const turnId = worker.currentTurnId;
    if (!turnId) return;
    const update = payload.update;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "user_message_chunk") return;
    if (kind === "agent_thought_chunk") {
      await this.#sealAssistant(worker);
      return;
    }
    if (kind === "agent_message_chunk") {
      const text = contentText(update.content);
      if (!text) return;
      if (!worker.currentAssistantItemId) {
        worker.assistantSegment += 1;
        worker.currentAssistantItemId = `${turnId}-assistant-${worker.assistantSegment}`;
      }
      await this.#emitStreamDelta(worker, {
        type: "message.delta",
        turnId,
        itemId: worker.currentAssistantItemId,
        kind: "message",
        text,
      });
      return;
    }
    if (kind === "tool_call") {
      await this.#sealAssistant(worker);
      const itemId = String(update.toolCallId ?? `${turnId}-tool`);
      const mappings = this.#peekMappings(worker.sessionKey);
      const tool = createPublicToolView(update, mappings);
      worker.tools.set(itemId, tool);
      if (tool.kind === "think") return;
      await this.#emit(worker.sessionKey, {
        type: "command.started",
        turnId,
        itemId,
        status: typeof update.status === "string" ? update.status : "pending",
        ...publicToolPayload(tool),
      });
      return;
    }
    if (kind === "tool_call_update") {
      const itemId = String(update.toolCallId ?? `${turnId}-tool`);
      const mappings = this.#peekMappings(worker.sessionKey);
      const previous = worker.tools.get(itemId) ?? createPublicToolView(update, mappings);
      const tool = updatePublicToolView(previous, update, mappings);
      worker.tools.set(itemId, tool);
      const output = toolContentText(update.content);
      if (output && exposesToolText(tool.kind) && tool.kind !== "think") {
        await this.#emitStreamDelta(worker, {
          type: "command.output.delta",
          turnId,
          itemId,
          kind: "command",
          text: output,
        });
      }
      if (update.status === "completed" || update.status === "failed") {
        if (tool.kind !== "think") {
          await this.#flushStreamDelta(worker, itemId, "command", turnId);
          await this.#emit(worker.sessionKey, {
            type: "command.completed",
            turnId,
            itemId,
            status: update.status,
            output: exposesToolText(tool.kind) ? output : null,
            ...publicToolPayload(tool),
          });
        }
        worker.tools.delete(itemId);
      }
    }
  }

  async #onPermission(worker: LiveWorker, request: AcpPermissionRequest): Promise<void> {
    if (worker.stopReason) {
      worker.client.respondPermission(request.rpcId, { outcome: "cancelled" });
      return;
    }
    const human = isHumanRequired(request.toolCall);
    const mappings = this.#peekMappings(worker.sessionKey);
    const rawReason = permissionReason(request.toolCall, human);
    const approval: ApprovalView = {
      approvalId: randomUUID(),
      sessionId: worker.sessionKey,
      kind: human ? "user_input" : permissionKind(request.toolCall),
      reason: rawReason
        ? clipApprovalReason(redactKnownAttachmentPaths(rawReason, mappings))
        : null,
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
      })),
      startedAtMs: Date.now(),
    };
    const pending: PendingApproval = { approval, rpcId: request.rpcId, human };
    worker.pendingApproval = pending;
    this.#approvals.set(approval.approvalId, { worker, pending });

    if (human && !this.#presence.online) {
      this.#requestStop(worker, "需要用户回答，但当前没有前端在线。");
      return;
    }

    if (!human && worker.yolo) {
      this.#autoAnswer(worker);
      return;
    }

    await this.#emit(worker.sessionKey, {
      type: "turn.status",
      turnId: worker.currentTurnId,
      status: "waiting_for_permission",
    });
    await this.#emit(worker.sessionKey, {
      type: "approval.requested",
      ...approval,
    });
  }

  #autoAnswer(worker: LiveWorker): void {
    const pending = worker.pendingApproval;
    if (!pending) return;
    const allow = pending.approval.options.find((option) => /allow/i.test(option.optionId)) ??
      pending.approval.options[0];
    if (!allow) {
      this.#resolveApproval(worker, { outcome: "cancelled" });
      return;
    }
    this.#resolveApproval(worker, { outcome: "selected", optionId: allow.optionId });
  }

  #resolveApproval(
    worker: LiveWorker,
    outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string },
  ): void {
    const pending = worker.pendingApproval;
    if (!pending) return;
    worker.client.respondPermission(pending.rpcId, outcome);
    worker.pendingApproval = null;
    this.#approvals.delete(pending.approval.approvalId);
    void this.#emit(worker.sessionKey, {
      type: "approval.resolved",
      approvalId: pending.approval.approvalId,
      resolution: outcome.outcome === "cancelled" ? "declined" : "approved",
    });
  }

  async #shutdown(worker: LiveWorker): Promise<void> {
    if (worker.closing || worker.enqueuing > 0) return;
    if (worker.queue.length > 0) {
      void this.#drain(worker);
      return;
    }
    worker.closing = true;
    if (worker.pendingApproval) {
      this.#resolveApproval(worker, { outcome: "cancelled" });
    }
    if (worker.grokSessionId) {
      worker.client.sessionCancel(worker.grokSessionId);
      await worker.client.sessionClose(worker.grokSessionId);
    }
    await worker.client.close();
    await terminateAgent(worker.agent);
    if (this.#workers.get(worker.sessionKey) === worker) {
      this.#workers.delete(worker.sessionKey);
    }
    if (worker.grokSessionId && this.#workers.get(worker.grokSessionId) === worker) {
      this.#workers.delete(worker.grokSessionId);
    }
  }

  async #sealAssistant(worker: LiveWorker): Promise<void> {
    if (!worker.currentAssistantItemId || !worker.currentTurnId) return;
    await this.#flushStreamDelta(
      worker,
      worker.currentAssistantItemId,
      "message",
      worker.currentTurnId,
    );
    await this.#emit(worker.sessionKey, {
      type: "message.completed",
      turnId: worker.currentTurnId,
      itemId: worker.currentAssistantItemId,
    });
    worker.currentAssistantItemId = null;
  }

  async #emit(sessionId: string, event: BrowserTurnEvent): Promise<void> {
    // 事件自带的 sessionId（例如 session.bound 上的原生 Grok id）优先，
    // 不要用落盘目录 id 盖掉。
    const redacted = redactKnownAttachmentPathsDeep(event, this.#peekMappings(sessionId));
    const stored = await this.#store.appendEvent(sessionId, { sessionId, ...redacted });
    const payload = stored.event;
    for (const listener of this.#listeners) listener(payload);
  }

  #peekMappings(sessionId: string): AttachmentDisplayMapping[] {
    return this.#attachmentIndex?.peek(sessionId) ?? [];
  }

  #redactText(sessionId: string, text: string): string {
    return redactKnownAttachmentPaths(text, this.#peekMappings(sessionId));
  }

  async #loadAttachmentMappings(sessionId: string): Promise<void> {
    if (!this.#attachmentIndex) return;
    await this.#attachmentIndex.mappingsFor(sessionId);
    this.#applyAttachmentMappings(sessionId, this.#attachmentIndex.peek(sessionId));
  }

  async #registerTaskAttachments(
    sessionId: string,
    messageId: string,
    attachments: readonly ResolvedAttachment[],
  ): Promise<void> {
    if (!this.#attachmentIndex || attachments.length === 0) return;
    await this.#attachmentIndex.register(
      sessionId,
      messageId,
      attachments.map((attachment) => ({
        id: attachment.id,
        originalName: attachment.originalName,
        path: attachment.path,
      })),
    );
    this.#applyAttachmentMappings(sessionId, this.#attachmentIndex.peek(sessionId));
  }

  #applyAttachmentMappings(
    sessionId: string,
    mappings: readonly AttachmentDisplayMapping[],
  ): void {
    const worker = this.#workers.get(sessionId);
    if (!worker) return;
    for (const entry of worker.pathRedactors.values()) {
      entry.redactor.setMappings(mappings);
    }
  }

  #pathRedactor(
    worker: LiveWorker,
    itemId: string,
    kind: "message" | "command",
  ): AttachmentPathStreamRedactor {
    const existing = worker.pathRedactors.get(itemId);
    if (existing) return existing.redactor;
    const created = new AttachmentPathStreamRedactor(this.#peekMappings(worker.sessionKey));
    worker.pathRedactors.set(itemId, { kind, redactor: created });
    return created;
  }

  async #emitStreamDelta(
    worker: LiveWorker,
    event: {
      type: "message.delta" | "command.output.delta";
      turnId: string;
      itemId: string;
      kind: "message" | "command";
      text: string;
    },
  ): Promise<void> {
    const text = this.#pathRedactor(worker, event.itemId, event.kind).push(event.text);
    if (!text) return;
    await this.#emit(worker.sessionKey, {
      type: event.type,
      turnId: event.turnId,
      itemId: event.itemId,
      text,
    });
  }

  async #flushStreamDelta(
    worker: LiveWorker,
    itemId: string,
    kind: "message" | "command",
    turnId: string,
  ): Promise<void> {
    const entry = worker.pathRedactors.get(itemId);
    if (!entry) return;
    const leftover = entry.redactor.flush();
    worker.pathRedactors.delete(itemId);
    if (!leftover) return;
    await this.#emit(worker.sessionKey, {
      type: kind === "message" ? "message.delta" : "command.output.delta",
      turnId,
      itemId,
      text: leftover,
    });
  }

  async #flushPathRedactors(worker: LiveWorker): Promise<void> {
    const turnId = worker.currentTurnId;
    if (!turnId) {
      worker.pathRedactors.clear();
      return;
    }
    for (const [itemId, entry] of [...worker.pathRedactors.entries()]) {
      await this.#flushStreamDelta(worker, itemId, entry.kind, turnId);
    }
  }

  async #requireMeta(projectId: string, sessionId: string): Promise<StoredSessionMeta> {
    const existing = await this.#store.readMeta(sessionId);
    if (existing) {
      if (existing.projectId !== projectId) {
        throw new TurnRuntimeError(
          "session_project_mismatch",
          "这个会话不属于当前项目。",
        );
      }
      return existing;
    }
    if (sessionId.startsWith(PENDING_SESSION_PREFIX)) {
      throw new Error("会话不存在。");
    }
    const meta: StoredSessionMeta = {
      id: sessionId,
      projectId,
      grokSessionId: sessionId,
      permissionMode: "ask",
      title: "会话",
      createdAt: Math.floor(Date.now() / 1_000),
      clientMessageIds: {},
      clientMessagePayloads: {},
    };
    await this.#store.writeMeta(meta);
    return meta;
  }

  async #requireExistingMeta(sessionId: string): Promise<StoredSessionMeta> {
    const meta = await this.#store.readMeta(sessionId);
    if (!meta) throw new Error("请先打开一个会话。");
    return meta;
  }

  #captureModels(initialize: unknown): void {
    if (!initialize || typeof initialize !== "object") return;
    const meta = (initialize as { _meta?: { modelState?: { availableModels?: unknown } } })._meta;
    const models = meta?.modelState?.availableModels;
    if (!Array.isArray(models)) return;
    this.#modelCache = models.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const model = entry as {
        modelId?: string;
        name?: string;
        _meta?: { reasoningEfforts?: Array<{ id?: string; label?: string; default?: boolean }> };
      };
      if (!model.modelId) return [];
      return [{
        id: model.modelId,
        label: model.name ?? model.modelId,
        efforts: (model._meta?.reasoningEfforts ?? []).flatMap((effort) =>
          effort.id
            ? [{
              id: effort.id,
              label: effort.label ?? effort.id,
              default: effort.default === true,
            }]
            : []
        ),
      }];
    });
  }

  async #renewAttachmentLeases(): Promise<void> {
    if (!this.#uploads) return;
    for (const lease of this.#attachmentLeases.values()) {
      try {
        const renewed = await this.#uploads.renewLease(lease.leaseId, lease.ownerId);
        lease.expiresAtMs = renewed.expiresAtMs;
      } catch (error) {
        console.error(
          `续期 Grok 附件租约失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async #releaseTaskAttachmentLease(turnId: string): Promise<void> {
    const lease = this.#attachmentLeases.get(turnId);
    if (lease) await this.#releaseAttachmentLease(turnId, lease);
  }

  async #releaseAttachmentLease(turnId: string, lease: AttachmentLease): Promise<void> {
    if (this.#attachmentLeases.get(turnId) === lease) {
      this.#attachmentLeases.delete(turnId);
    }
    await this.#uploads?.releaseLease(lease.leaseId, lease.ownerId).catch((error: unknown) => {
      console.error(
        `释放 Grok 附件租约失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

export type ModelOption = {
  id: string;
  label: string;
  efforts: Array<{ id: string; label: string; default: boolean }>;
};

function publicAttachment(attachment: ResolvedAttachment): PublicAttachment {
  const { path: _path, ...publicValue } = attachment;
  return publicValue;
}

function runtimeAttachmentError(error: unknown): unknown {
  if (error instanceof TurnRuntimeError) return error;
  if (error instanceof GrokAttachmentError || error instanceof SharedUploadError) {
    return new TurnRuntimeError(error.code, error.message);
  }
  return error;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((entry) => {
    if (!entry || typeof entry !== "object") return "";
    const inner = (entry as { content?: unknown }).content;
    return contentText(inner);
  }).join("");
}

const HUMAN_TOOL_NAMES = new Set([
  "ask_user_question",
  "ask_user",
  "request_user_input",
  "elicitation",
  "mcp_elicitation",
  "captcha",
  "verify",
  "login",
]);
const MAX_APPROVAL_REASON_LENGTH = 240;

function isHumanRequired(toolCall: Record<string, unknown>): boolean {
  const meta = objectField(toolCall._meta);
  const tool = objectField(meta["x.ai/tool"]);
  const candidates = [toolCall.name, toolCall.toolName, tool.name, toolCall.title];
  return candidates.some((candidate) => {
    if (typeof candidate !== "string") return false;
    const normalized = candidate.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return HUMAN_TOOL_NAMES.has(normalized);
  });
}

function permissionKind(toolCall: Record<string, unknown>): ApprovalView["kind"] {
  const kind = createPublicToolView(toolCall).kind;
  if (kind === "edit" || kind === "delete" || kind === "move") return "file_change";
  if (kind === "execute") return "command";
  return "other";
}

function publicToolPayload(tool: PublicToolView): Record<string, unknown> {
  const exposesText = exposesToolText(tool.kind);
  return {
    title: tool.title,
    kind: tool.kind,
    input: exposesText ? tool.input : null,
    query: tool.kind === "search" ? tool.query : null,
    resources: tool.kind === "search" || tool.kind === "fetch" ? tool.resources : [],
  };
}

function permissionReason(toolCall: Record<string, unknown>, human: boolean): string | null {
  const rawInput = objectField(toolCall.rawInput);
  const meta = objectField(toolCall._meta);
  const tool = objectField(meta["x.ai/tool"]);
  const toolInput = objectField(tool.input);
  const description = firstString(
    rawInput.description,
    toolInput.description,
    toolContentText(toolCall.content),
  );
  if (description) return description;
  if (human) return null;

  const kind = permissionKind(toolCall);
  if (kind === "command") return "Grok 请求执行一条命令。";
  if (kind === "file_change") return "Grok 请求修改文件。";
  const title = firstString(toolCall.title);
  return title ?? "Grok 请求执行一项操作。";
}

function objectField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function clipApprovalReason(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_APPROVAL_REASON_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_APPROVAL_REASON_LENGTH - 1)}…`;
}

function itemStatus(event: Record<string, unknown>): string | null {
  if (event.type === "turn.accepted") return "queued";
  return typeof event.status === "string" ? event.status : null;
}

function initializeAgentVersion(initialize: unknown): string | null {
  if (!initialize || typeof initialize !== "object") return null;
  const meta = (initialize as { _meta?: { agentVersion?: unknown } })._meta;
  return typeof meta?.agentVersion === "string" ? meta.agentVersion : null;
}
