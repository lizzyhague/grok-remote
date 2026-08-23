import { COMMAND_CATALOG, type CommandName } from "./catalog.ts";
import type { GrokSessionDisk } from "../sessions/disk.ts";
import type { RemoteSessionStore } from "../sessions/store.ts";
import type { ModelOption } from "../turns/runtime.ts";

type CommandRuntime = {
  toggleAlwaysApprove(sessionId: string): Promise<{ enabled: boolean }>;
  runPrompt(sessionId: string, text: string): Promise<{ turnId: string }>;
  cachedModels(): ModelOption[];
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
        return this.#sessionInfo(sessionId);
      case "context":
        return this.#sessionInfo(sessionId);
      case "rename":
        if (!argument) throw new Error("请在 /rename 后面写一个会话名称。");
        return this.#runtime.runPrompt(sessionId, `/rename ${argument}`);
      case "model":
        if (!option) throw new Error("请先选择一个模型。");
        return this.#runtime.runPrompt(
          sessionId,
          argument ? `/model ${option} ${argument}` : `/model ${option}`,
        );
      case "effort":
        if (!option) throw new Error("请先选择思考强度。");
        return this.#runtime.runPrompt(sessionId, `/effort ${option}`);
      case "compact":
        return this.#runtime.runPrompt(
          sessionId,
          argument ? `/compact ${argument}` : "/compact",
        );
      case "rewind":
        return this.#runtime.runPrompt(sessionId, "/rewind");
      case "plan":
        return this.#runtime.runPrompt(
          sessionId,
          argument ? `/plan ${argument}` : "/plan",
        );
      default:
        throw new Error("不支持这个斜杠命令。");
    }
  }

  async #sessionInfo(sessionId: string): Promise<{
    kind: "info";
    title: string;
    lines: string[];
  }> {
    const meta = await this.#store.readMeta(sessionId);
    const record = await this.#disk.read(sessionId);
    const lines = [
      `会话：${record?.title ?? meta?.title ?? sessionId}`,
      `会话 ID：${record?.id ?? sessionId}`,
      `模型：${record?.model ?? "未知"}`,
      `权限：${meta?.permissionMode === "always-approve" ? "always-approve" : "ask"}`,
    ];
    if (record?.cwd) {
      lines.push("工作目录已由后端解析，不会发给浏览器。");
    }
    return { kind: "info", title: "会话状态", lines };
  }
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
