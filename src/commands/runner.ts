import { COMMAND_CATALOG, type CommandName } from "./catalog.ts";
import type { GrokSessionDisk } from "../sessions/disk.ts";
import type { RemoteSessionStore } from "../sessions/store.ts";
import type { ModelOption } from "../turns/runtime.ts";
import type { AcpContextInfo, AcpSessionInfo } from "../worker/acp-client.ts";

type CommandRuntime = {
  toggleAlwaysApprove(sessionId: string): Promise<{ enabled: boolean }>;
  cachedModels(): ModelOption[];
  inspectSession(sessionId: string): Promise<AcpSessionInfo>;
  setModel(
    sessionId: string,
    modelId: string,
    reasoningEffort: string | null,
  ): Promise<{ sessionId: string; modelId: string; reasoningEffort: string | null }>;
  setEffort(
    sessionId: string,
    reasoningEffort: string,
  ): Promise<{ sessionId: string; modelId: string; reasoningEffort: string }>;
  enterPlan(sessionId: string, prompt: string | null): Promise<{
    sessionId?: string;
    turnId?: string;
  }>;
  renameSession(sessionId: string, title: string): Promise<{ sessionId: string; title: string }>;
  compact(sessionId: string): Promise<{ turnId: string }>;
  rewind(sessionId: string): Promise<{
    kind: "rewind";
    sessionId: string;
    promptText: string | null;
  }>;
};

export class CommandRunner {
  readonly #runtime: CommandRuntime;
  readonly #disk: GrokSessionDisk;
  readonly #store: RemoteSessionStore;

  constructor(runtime: CommandRuntime, disk: GrokSessionDisk, store: RemoteSessionStore) {
    this.#runtime = runtime;
    this.#disk = disk;
    this.#store = store;
  }

  catalog() {
    return COMMAND_CATALOG;
  }

  async options(command: CommandName) {
    if (command === "model") {
      const models = this.#runtime.cachedModels();
      const items = (models.length ? models : fallbackModels()).map((model) => ({
        id: model.id,
        label: model.label,
        description: "",
        items: model.efforts.map((effort) => ({
          id: effort.id,
          label: `${effort.label}${effort.default ? "（默认）" : ""}`,
        })),
      }));
      return { title: "选择模型", items };
    }
    if (command === "effort") {
      return {
        title: "选择思考强度",
        items: [
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
          { id: "xhigh", label: "xhigh" },
        ],
      };
    }
    return { title: `/${command}`, items: [] };
  }

  async run(
    sessionId: string,
    command: CommandName,
    option: string | null,
    argument: string | null,
  ): Promise<unknown> {
    switch (command) {
      case "always-approve":
        return this.#runtime.toggleAlwaysApprove(sessionId);
      case "session-info":
        return this.#sessionInfo(sessionId, false);
      case "context":
        return this.#sessionInfo(sessionId, true);
      case "rename":
        if (!argument) throw new Error("请在 /rename 后面写一个会话名称。");
        return this.#rename(sessionId, argument);
      case "model": {
        if (!option) throw new Error("请先选择一个模型。");
        const selected = parseModelSelection(option, argument);
        const result = await this.#runtime.setModel(
          sessionId,
          selected.modelId,
          selected.reasoningEffort,
        );
        return {
          kind: "info",
          title: "模型",
          lines: [
            `已切换到 ${result.modelId}${
              result.reasoningEffort ? `（${result.reasoningEffort}）` : ""
            }。`,
          ],
          sessionId: result.sessionId,
        };
      }
      case "effort":
        if (!option) throw new Error("请先选择思考强度。");
        return this.#setEffort(sessionId, option);
      case "compact":
        if (argument) {
          throw new Error("当前 Grok ACP 只支持直接压缩，不能附加压缩说明。");
        }
        return this.#runtime.compact(sessionId);
      case "rewind":
        return this.#runtime.rewind(sessionId);
      case "plan": {
        const result = await this.#runtime.enterPlan(sessionId, argument);
        if (result.turnId) return { turnId: result.turnId };
        return {
          kind: "info",
          title: "计划模式",
          lines: ["已进入 plan；后续消息会在计划模式中处理。"],
          sessionId: result.sessionId,
        };
      }
      default:
        throw new Error("不支持这个斜杠命令。");
    }
  }

  async #sessionInfo(sessionId: string, contextOnly: boolean): Promise<{
    kind: "info";
    title: string;
    lines: string[];
    sessionId: string;
  }> {
    const info = await this.#runtime.inspectSession(sessionId);
    const meta = await this.#store.readMeta(info.sessionId);
    const record = await this.#disk.read(info.sessionId);
    if (contextOnly) {
      return {
        kind: "info",
        title: "上下文",
        lines: contextLines(info.context),
        sessionId: info.sessionId,
      };
    }
    const lines = [
      `会话：${record?.title ?? meta?.title ?? info.sessionId}`,
      `会话 ID：${info.sessionId}`,
      `模型：${info.modelDisplayName ?? info.model ?? record?.model ?? "未知"}${
        record?.reasoningEffort ? `（${record.reasoningEffort}）` : ""
      }`,
      `权限：${meta?.permissionMode === "always-approve" ? "always-approve" : "ask"}`,
    ];
    if (info.shellVersion) lines.push(`Shell：Grok Build ${info.shellVersion}`);
    if (info.agentName) lines.push(`代理：${info.agentName}`);
    if (info.apiBackend) lines.push(`API：${info.apiBackend}`);
    if (typeof info.turns === "number") lines.push(`记录条目：${info.turns}`);
    if (info.context) {
      lines.push(`上下文：${usageSummary(info.context)}`);
    }
    if (info.cwd || record?.cwd) {
      lines.push("工作目录已由后端解析，不会发给浏览器。");
    }
    return { kind: "info", title: "会话状态", lines, sessionId: info.sessionId };
  }

  async #rename(sessionId: string, title: string): Promise<unknown> {
    const result = await this.#runtime.renameSession(sessionId, title);
    return {
      kind: "info",
      title: "会话名称",
      lines: [`已重命名为「${result.title}」。`],
      sessionId: result.sessionId,
    };
  }

  async #setEffort(sessionId: string, effort: string): Promise<unknown> {
    const result = await this.#runtime.setEffort(sessionId, effort);
    return {
      kind: "info",
      title: "思考强度",
      lines: [`${result.modelId} 已切换到 ${result.reasoningEffort}。`],
      sessionId: result.sessionId,
    };
  }
}

function parseModelSelection(
  option: string,
  argument: string | null,
): { modelId: string; reasoningEffort: string | null } {
  const [modelId, typedEffort] = option.trim().split(/\s+/, 2);
  if (!modelId) throw new Error("请先选择一个模型。");
  return {
    modelId,
    reasoningEffort: argument?.trim() || typedEffort?.trim() || null,
  };
}

function contextLines(context: AcpContextInfo | undefined): string[] {
  if (!context) return ["Grok 没有返回上下文用量。"];
  const lines = [
    `已使用：${usageSummary(context)}`,
    `可用：${formatTokens(context.freeTokens)}`,
    `系统提示：${formatTokens(context.systemPromptTokens)}`,
    `消息：${formatTokens(context.messageTokens)}${countSuffix(context.messageCount, "条")}`,
    `工具定义：${formatTokens(context.toolDefinitionsTokens)}${
      countSuffix(context.toolDefinitionsCount, "个")
    }`,
    `轮次：${formatCount(context.turnCount)}；工具调用：${formatCount(context.toolCallCount)}；压缩：${
      formatCount(context.compactionCount)
    }`,
  ];
  for (const category of context.usageCategories ?? []) {
    if (!category.label) continue;
    lines.push(`${category.label}：${formatTokens(category.tokens)}${
      category.detail ? `（${category.detail}）` : ""
    }`);
  }
  return lines;
}

function usageSummary(context: AcpContextInfo): string {
  const used = formatTokens(context.used);
  const total = formatTokens(context.total);
  const percent = typeof context.usagePct === "number" ? `（${context.usagePct}%）` : "";
  return `${used} / ${total}${percent}`;
}

function formatTokens(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value).toLocaleString("en-US")} tokens`
    : "未知";
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "未知";
}

function countSuffix(value: number | undefined, unit: string): string {
  return typeof value === "number" && Number.isFinite(value) ? `（${value} ${unit}）` : "";
}

function fallbackModels() {
  return [
    {
      id: "grok-4.6",
      label: "Grok 4.6",
      efforts: [
        { id: "low", label: "low", default: false },
        { id: "medium", label: "medium", default: false },
        { id: "high", label: "high", default: true },
        { id: "xhigh", label: "xhigh", default: false },
      ],
    },
    {
      id: "grok-4.5",
      label: "Grok 4.5",
      efforts: [
        { id: "low", label: "low", default: false },
        { id: "medium", label: "medium", default: false },
        { id: "high", label: "high", default: true },
      ],
    },
  ];
}
