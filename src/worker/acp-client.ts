import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import {
  encodeMessage,
  isNotification,
  isRequest,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "./jsonrpc.ts";

export type AcpPermissionRequest = {
  rpcId: number | string;
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: Array<{ optionId: string; name: string; kind: string }>;
};

export type AcpUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
};

export type AcpContextInfo = {
  used?: number;
  total?: number;
  systemPromptTokens?: number;
  toolDefinitionsCount?: number;
  toolDefinitionsTokens?: number;
  compactionCount?: number;
  turnCount?: number;
  toolCallCount?: number;
  messageCount?: number;
  messageTokens?: number;
  freeTokens?: number;
  usagePct?: number;
  autoCompactThresholdPercent?: number;
  usageCategories?: Array<{ label?: string; tokens?: number; detail?: string }>;
};

export type AcpSessionInfo = {
  sessionId: string;
  shellVersion?: string;
  cwd?: string;
  agentName?: string;
  model?: string;
  modelDisplayName?: string;
  resolvedModelId?: string | null;
  modelFingerprint?: string | null;
  apiBackend?: string;
  turns?: number;
  turnIndex?: number;
  context?: AcpContextInfo;
};

export type AcpRewindPoint = {
  prompt_index: number;
  created_at?: string;
  num_file_snapshots?: number;
  has_file_changes?: boolean;
  prompt_preview?: string;
};

export type AcpRewindResult = {
  success: boolean;
  target_prompt_index?: number;
  mode?: string;
  prompt_text?: string | null;
  error?: string | null;
};

export type AcpPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | {
    type: "resource";
    resource:
      | { uri: string; mimeType?: string; text: string }
      | { uri: string; mimeType?: string; blob: string };
  };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/**
 * 新建 Grok 会话时追加到系统提示。只在 session/new 发送；
 * session/resume 不再带，以免 Worker 按需重启时重复追加。
 */
export const GROK_REMOTE_SESSION_RULES = [
  "Grok Remote 是一个由浏览器 PWA 和本机后端组成的远程使用平台；它通过 Grok ACP 将 Grok 接到网页，让用户从手机或电脑使用。你正在通过 Grok Remote 与用户对话。用户通过网页发送消息，看到的是 Grok Remote 的浏览器界面，不是 Grok TUI 的终端界面。",
  "后端服务 `grok-remote` 承载这次对话，是当前会话运行环境的一部分。修改、重启或停止该服务的进程、配置或网络连接，可能中断当前会话。涉及 Grok Remote 自身的操作时，先说明影响；能由你完成的操作和核查由你完成，必要时使用延迟重启。如果必须由用户在当前会话之外重启服务，只提供完成重启所需的最简命令，不要求用户代为核查。重启前告知用户：如果服务未能恢复，可以通过 SSH 登录 node1，改用不依赖该后端的 Grok TUI 寻求帮助。连接恢复后，由你自行核查服务状态并继续后续工作。不要把本可在重连后完成的核查步骤交给用户。",
  "需要交给用户查看的 Markdown 或图片分两类：正式文件保存在当前项目内它本来应该在的位置；只用于比较、挑选或试验的临时预览一律写到 ~/preview，不分项目、不纳入 Git，用户看过后会自行删除。不要把这类文件放到 ~/.grok 或 /tmp。回复中提供 Markdown 链接，目标为 /view?path= 加 URL 编码后的绝对路径。",
].join("\n\n");

/**
 * ACP JSON-RPC 客户端。不向 Grok 声明 fs / terminal 能力。
 */
export class AcpClient extends EventEmitter {
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #rl: readline.Interface;
  #initialize: unknown = null;

  constructor(proc: ChildProcessWithoutNullStreams) {
    super();
    this.#proc = proc;
    this.#rl = readline.createInterface({ input: proc.stdout });
    this.#rl.on("line", (line) => this.#onLine(line));
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.emit("stderr", text);
    });
    proc.on("exit", (code, signal) => {
      this.#failAll(new Error(`Grok Worker 已退出（${signal ?? code ?? "unknown"}）。`));
      this.emit("exit", { code, signal });
    });
  }

  get initializeResult(): unknown {
    return this.#initialize;
  }

  async initialize(): Promise<unknown> {
    this.#initialize = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "grok_remote",
        title: "Grok Remote",
        version: "0.1.0",
      },
      clientCapabilities: {},
    });
    return this.#initialize;
  }

  async sessionNew(cwd: string, yoloMode: boolean): Promise<string> {
    const result = await this.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: { yoloMode, rules: GROK_REMOTE_SESSION_RULES },
    }) as { sessionId?: string };
    if (!result?.sessionId) {
      throw new Error("Grok 没有返回 session id。");
    }
    return result.sessionId;
  }

  async sessionResume(sessionId: string, cwd: string, yoloMode: boolean): Promise<void> {
    await this.request("session/resume", {
      sessionId,
      cwd,
      mcpServers: [],
      _meta: { yoloMode },
    });
  }

  async sessionSetModel(
    sessionId: string,
    modelId: string,
    reasoningEffort: string | null = null,
  ): Promise<void> {
    await this.request("session/set_model", {
      sessionId,
      modelId,
      ...(reasoningEffort ? { _meta: { reasoningEffort } } : {}),
    });
  }

  async sessionSetMode(sessionId: string, modeId: string): Promise<void> {
    await this.request("session/set_mode", { sessionId, modeId });
  }

  async sessionRename(sessionId: string, title: string): Promise<void> {
    const result = await this.request("_x.ai/session/rename", {
      sessionId,
      title,
      resetToAuto: false,
    }) as { success?: boolean };
    if (result?.success !== true) {
      throw new Error("Grok 没有完成会话重命名。");
    }
  }

  async sessionInfo(sessionId: string): Promise<AcpSessionInfo> {
    const response = await this.request("_x.ai/session/info", { sessionId }) as {
      result?: AcpSessionInfo;
    };
    if (!response?.result || typeof response.result.sessionId !== "string") {
      throw new Error("Grok 没有返回会话状态。");
    }
    return response.result;
  }

  async sessionCompact(sessionId: string): Promise<void> {
    await this.request("_x.ai/compact_conversation", { sessionId });
  }

  async rewindPoints(sessionId: string): Promise<AcpRewindPoint[]> {
    const response = await this.request("_x.ai/rewind/points", { sessionId }) as {
      rewind_points?: unknown;
    };
    if (!Array.isArray(response?.rewind_points)) return [];
    return response.rewind_points.filter(isRewindPoint);
  }

  async rewindConversation(sessionId: string, targetPromptIndex: number): Promise<AcpRewindResult> {
    return await this.request("_x.ai/rewind/execute", {
      sessionId,
      targetPromptIndex,
      force: true,
      mode: "conversation_only",
    }) as AcpRewindResult;
  }

  async sessionPrompt(
    sessionId: string,
    input: string | AcpPromptContent[],
  ): Promise<{ stopReason?: string }> {
    return await this.request("session/prompt", {
      sessionId,
      prompt: typeof input === "string" ? [{ type: "text", text: input }] : input,
    }) as { stopReason?: string };
  }

  sessionCancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  async sessionClose(sessionId: string): Promise<void> {
    try {
      await this.request("session/close", { sessionId });
    } catch {
      // close 能力因版本而异；失败时由进程组清理兜底。
    }
  }

  respondPermission(
    rpcId: number | string,
    outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string },
  ): void {
    this.#write({
      jsonrpc: "2.0",
      id: rpcId,
      result: { outcome },
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("Grok Worker 已经关闭。"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rl.close();
    this.#failAll(new Error("Grok Worker 已关闭。"));
    if (!this.#proc.killed) {
      this.#proc.stdin.end();
    }
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.emit("stderr", trimmed);
      return;
    }

    if (isRequest(message)) {
      this.#onServerRequest(message);
      return;
    }
    if (isNotification(message)) {
      if (message.method === "session/update" || message.method === "_x.ai/session/update") {
        const params = (message.params ?? {}) as Record<string, unknown>;
        this.emit("update", {
          sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
          update: (params.update ?? {}) as Record<string, unknown>,
        } satisfies AcpUpdate);
      }
      this.emit("notification", message);
      return;
    }
    if (message.id === null || message.id === undefined) return;
    const pending = this.#pending.get(Number(message.id));
    if (!pending) return;
    this.#pending.delete(Number(message.id));
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  #onServerRequest(message: JsonRpcRequest): void {
    if (message.method === "session/request_permission") {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const options = Array.isArray(params.options) ? params.options : [];
      this.emit("permission", {
        rpcId: message.id,
        sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
        toolCall: (params.toolCall ?? {}) as Record<string, unknown>,
        options: options.filter(isPermissionOption),
      } satisfies AcpPermissionRequest);
      return;
    }
    this.#write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
  }

  #write(message: JsonRpcMessage): void {
    if (this.#closed || this.#proc.stdin.destroyed) return;
    this.#proc.stdin.write(encodeMessage(message));
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isPermissionOption(
  value: unknown,
): value is { optionId: string; name: string; kind: string } {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { optionId?: unknown }).optionId === "string" &&
    typeof (value as { kind?: unknown }).kind === "string";
}

function isRewindPoint(value: unknown): value is AcpRewindPoint {
  return typeof value === "object" &&
    value !== null &&
    Number.isInteger((value as AcpRewindPoint).prompt_index) &&
    (value as AcpRewindPoint).prompt_index >= 0;
}
