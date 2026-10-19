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
          label: `${effort.label}${effort.default ? " (default)" : ""}`,
        })),
      }));
      return { title: "Choose model", items };
    }
    if (command === "effort") {
      return {
        title: "Choose reasoning effort",
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
        if (!argument) throw new Error("Enter a session name after /rename.");
        return this.#rename(sessionId, argument);
      case "model": {
        if (!option) throw new Error("Choose a model first.");
        const selected = parseModelSelection(option, argument);
        const result = await this.#runtime.setModel(
          sessionId,
          selected.modelId,
          selected.reasoningEffort,
        );
        return {
          kind: "info",
          title: "Model",
          lines: [
            `Switched to ${result.modelId}${
              result.reasoningEffort ? ` (${result.reasoningEffort})` : ""
            }.`,
          ],
          sessionId: result.sessionId,
        };
      }
      case "effort":
        if (!option) throw new Error("Choose a reasoning effort first.");
        return this.#setEffort(sessionId, option);
      case "compact":
        if (argument) {
          throw new Error("Grok ACP currently supports direct compaction only; compaction instructions cannot be added.");
        }
        return this.#runtime.compact(sessionId);
      case "rewind":
        return this.#runtime.rewind(sessionId);
      case "plan": {
        const result = await this.#runtime.enterPlan(sessionId, argument);
        if (result.turnId) return { turnId: result.turnId };
        return {
          kind: "info",
          title: "Plan mode",
          lines: ["Entered plan mode; subsequent messages will be handled in plan mode."],
          sessionId: result.sessionId,
        };
      }
      default:
        throw new Error("This slash command is not supported.");
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
        title: "Context",
        lines: contextLines(info.context),
        sessionId: info.sessionId,
      };
    }
    const lines = [
      `Session: ${record?.title ?? meta?.title ?? info.sessionId}`,
      `Session ID: ${info.sessionId}`,
      `Model: ${info.modelDisplayName ?? info.model ?? record?.model ?? "unknown"}${
        record?.reasoningEffort ? ` (${record.reasoningEffort})` : ""
      }`,
      `Permission: ${meta?.permissionMode === "always-approve" ? "always-approve" : "ask"}`,
    ];
    if (info.shellVersion) lines.push(`Shell: Grok Build ${info.shellVersion}`);
    if (info.agentName) lines.push(`Agent: ${info.agentName}`);
    if (info.apiBackend) lines.push(`API: ${info.apiBackend}`);
    if (typeof info.turns === "number") lines.push(`Recorded entries: ${info.turns}`);
    if (info.context) {
      lines.push(`Context: ${usageSummary(info.context)}`);
    }
    if (info.cwd || record?.cwd) {
      lines.push("The working directory is resolved by the backend and is not sent to the browser.");
    }
    return { kind: "info", title: "Session status", lines, sessionId: info.sessionId };
  }

  async #rename(sessionId: string, title: string): Promise<unknown> {
    const result = await this.#runtime.renameSession(sessionId, title);
    return {
      kind: "info",
      title: "Session name",
      lines: [`Renamed to “${result.title}”.`],
      sessionId: result.sessionId,
    };
  }

  async #setEffort(sessionId: string, effort: string): Promise<unknown> {
    const result = await this.#runtime.setEffort(sessionId, effort);
    return {
      kind: "info",
      title: "Reasoning effort",
      lines: [`${result.modelId} switched to ${result.reasoningEffort}.`],
      sessionId: result.sessionId,
    };
  }
}

function parseModelSelection(
  option: string,
  argument: string | null,
): { modelId: string; reasoningEffort: string | null } {
  const [modelId, typedEffort] = option.trim().split(/\s+/, 2);
  if (!modelId) throw new Error("Choose a model first.");
  return {
    modelId,
    reasoningEffort: argument?.trim() || typedEffort?.trim() || null,
  };
}

function contextLines(context: AcpContextInfo | undefined): string[] {
  if (!context) return ["Grok did not return context usage."];
  const lines = [
    `Used: ${usageSummary(context)}`,
    `Available: ${formatTokens(context.freeTokens)}`,
    `System prompt: ${formatTokens(context.systemPromptTokens)}`,
    `Messages: ${formatTokens(context.messageTokens)}${countSuffix(context.messageCount, "messages")}`,
    `Tool definitions: ${formatTokens(context.toolDefinitionsTokens)}${
      countSuffix(context.toolDefinitionsCount, "tools")
    }`,
    `Turns: ${formatCount(context.turnCount)}; tool calls: ${formatCount(context.toolCallCount)}; compactions: ${
      formatCount(context.compactionCount)
    }`,
  ];
  for (const category of context.usageCategories ?? []) {
    if (!category.label) continue;
    lines.push(`${category.label}: ${formatTokens(category.tokens)}${
      category.detail ? ` (${category.detail})` : ""
    }`);
  }
  return lines;
}

function usageSummary(context: AcpContextInfo): string {
  const used = formatTokens(context.used);
  const total = formatTokens(context.total);
  const percent = typeof context.usagePct === "number" ? ` (${context.usagePct}%)` : "";
  return `${used} / ${total}${percent}`;
}

function formatTokens(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value).toLocaleString("en-US")} tokens`
    : "unknown";
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}

function countSuffix(value: number | undefined, unit: string): string {
  return typeof value === "number" && Number.isFinite(value) ? ` (${value} ${unit})` : "";
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
