import {
  MAX_STORED_COMMAND_OUTPUT,
  type TimelineItem,
  type TurnSnapshot,
  type TurnStatus,
} from "./types.ts";
import {
  createPublicToolView,
  exposesToolText,
  updatePublicToolView,
  type PublicToolKind,
} from "../turns/tool-view.ts";

type JsonObject = Record<string, unknown>;

export type ParseUpdatesOptions = {
  /**
   * Grok 当前有效分支上最后一个 prompt index。-1 表示有效分支还没有用户轮次；
   * undefined 表示没有可靠的 rewind point 数据，此时只做重复 index 去重。
   */
  activePromptIndex?: number | undefined;
};

/**
 * rewind_points.jsonl 会随 Grok 的当前分支一起回退，而 updates.jsonl 是追加日志。
 * 返回 undefined 时表示文件缺失或内容不可可靠解析，调用方应保留兼容回退行为。
 */
export function parseActivePromptIndex(source: string | null): number | undefined {
  if (source === null) return undefined;
  if (!source.trim()) return -1;

  let latest: number | undefined;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    const promptIndex = nonNegativeInteger(parsed.prompt_index) ??
      nonNegativeInteger(parsed.promptIndex);
    if (promptIndex === null) continue;
    latest = latest === undefined ? promptIndex : Math.max(latest, promptIndex);
  }
  return latest;
}

/**
 * 把 Grok 的 updates.jsonl 收成浏览器时间线。思考内容和 ACP 内部字段不进入浏览器。
 */
export function parseUpdatesJsonl(
  source: string,
  options: ParseUpdatesOptions = {},
): TurnSnapshot[] {
  const turns: MutableTurn[] = [];
  const unindexedTurns = new Map<string, MutableTurn>();
  let fallback = 0;
  let indexedOccurrence = 0;
  let currentIndexedTurn: MutableTurn | null = null;
  let currentIndexedTurnAcceptsUserChunks = false;

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    const method = parsed.method;
    if (method !== "session/update" && method !== "_x.ai/session/update") continue;
    const params = isObject(parsed.params) ? parsed.params : {};
    const update = isObject(params.update) ? params.update : {};
    const meta = {
      ...asObject(parsed._meta),
      ...asObject(params._meta),
      ...asObject(update._meta),
    };
    const kind = stringField(update.sessionUpdate);
    const promptId = stringField(meta.promptId) ??
      stringField(meta.prompt_id) ??
      stringField(update.prompt_id);
    const promptIndex = nonNegativeInteger(meta.promptIndex) ??
      nonNegativeInteger(meta.prompt_index) ??
      nonNegativeInteger(update.promptIndex) ??
      nonNegativeInteger(update.prompt_index);

    let turn: MutableTurn;
    if (kind === "user_message_chunk" && promptIndex !== null) {
      if (
        !currentIndexedTurn ||
        currentIndexedTurn.promptIndex !== promptIndex ||
        !currentIndexedTurnAcceptsUserChunks
      ) {
        turn = createTurn(
          promptId ?? `prompt-${promptIndex}-${indexedOccurrence}`,
          promptIndex,
        );
        indexedOccurrence += 1;
        turns.push(turn);
        currentIndexedTurn = turn;
      } else {
        turn = currentIndexedTurn;
      }
      currentIndexedTurnAcceptsUserChunks = true;
    } else if (kind === "user_message_chunk") {
      currentIndexedTurn = null;
      currentIndexedTurnAcceptsUserChunks = false;
      const key = promptId ?? `anon-${fallback++}`;
      turn = unindexedTurns.get(key) ?? createTurn(key, null);
      if (!unindexedTurns.has(key)) {
        unindexedTurns.set(key, turn);
        turns.push(turn);
      }
    } else if (currentIndexedTurn) {
      turn = currentIndexedTurn;
      currentIndexedTurnAcceptsUserChunks = false;
      if (promptId) turn.id = promptId;
    } else {
      const key = promptId ?? `anon-${fallback++}`;
      turn = unindexedTurns.get(key) ?? createTurn(key, null);
      if (!unindexedTurns.has(key)) {
        unindexedTurns.set(key, turn);
        turns.push(turn);
      }
    }
    applyUpdate(turn, update, meta);
  }

  const latestByPromptIndex = new Map<number, MutableTurn>();
  for (const turn of turns) {
    if (turn.promptIndex === null) continue;
    if (
      options.activePromptIndex !== undefined &&
      turn.promptIndex > options.activePromptIndex
    ) {
      continue;
    }
    latestByPromptIndex.set(turn.promptIndex, turn);
  }

  return turns
    .filter((turn) => {
      if (turn.promptIndex === null) return true;
      if (
        options.activePromptIndex !== undefined &&
        turn.promptIndex > options.activePromptIndex
      ) {
        return false;
      }
      return latestByPromptIndex.get(turn.promptIndex) === turn;
    })
    .map(freezeTurn);
}

type MutableTurn = {
  id: string;
  promptIndex: number | null;
  status: TurnStatus;
  error: string | null;
  items: TimelineItem[];
  messages: Map<string, { role: "user" | "assistant"; text: string; item: Extract<TimelineItem, { type: "message" }> }>;
  commands: Map<string, Extract<TimelineItem, { type: "command" }>>;
  breakAssistantMessage: boolean;
};

function createTurn(id: string, promptIndex: number | null): MutableTurn {
  return {
    id,
    promptIndex,
    status: "completed",
    error: null,
    items: [],
    messages: new Map(),
    commands: new Map(),
    breakAssistantMessage: false,
  };
}

function applyUpdate(turn: MutableTurn, update: JsonObject, meta: JsonObject): void {
  const kind = stringField(update.sessionUpdate);
  if (kind === "user_message_chunk") {
    appendMessage(turn, "user", textFromContent(update.content), stringField(update.messageId));
    return;
  }
  if (kind === "agent_message_chunk") {
    appendMessage(turn, "assistant", textFromContent(update.content), stringField(update.messageId));
    return;
  }
  if (kind === "agent_thought_chunk") {
    // 思考内容不进入历史，但它表示助手开始了新的工作阶段。
    // 下一段可见回复必须另起气泡，和实时事件流保持一致。
    turn.breakAssistantMessage = true;
    return;
  }
  if (kind === "tool_call") {
    const id = stringField(update.toolCallId) ?? `tool-${turn.commands.size}`;
    const tool = createPublicToolView(update);
    if (tool.kind === "think") {
      turn.breakAssistantMessage = true;
      return;
    }
    const command: Extract<TimelineItem, { type: "command" }> = {
      type: "command",
      id,
      title: tool.title,
      kind: tool.kind,
      status: stringField(update.status) ?? "pending",
      input: exposesToolText(tool.kind) ? clipStoredText(tool.input) : null,
      output: null,
      outputTruncated: false,
    };
    turn.commands.set(id, command);
    turn.items.push(command);
    return;
  }
  if (kind === "tool_call_update") {
    const id = stringField(update.toolCallId);
    if (!id) return;
    const command = turn.commands.get(id);
    if (!command) return;
    if (typeof update.status === "string") command.status = update.status;
    const tool = updatePublicToolView({
      kind: command.kind as PublicToolKind,
      title: command.title,
      input: command.input,
      query: null,
      resources: [],
    }, update);
    command.kind = tool.kind;
    command.title = tool.title;
    if (exposesToolText(tool.kind) && tool.input) command.input = clipStoredText(tool.input);
    const output = toolOutputText(update.content);
    if (output && exposesToolText(tool.kind)) {
      const combined = `${command.output ?? ""}${output}`;
      if (combined.length > MAX_STORED_COMMAND_OUTPUT) {
        command.output = combined.slice(-MAX_STORED_COMMAND_OUTPUT);
        command.outputTruncated = true;
      } else {
        command.output = combined;
      }
    }
    if (looksLikeFileChange(update, command)) {
      replaceWithFileChange(turn, command);
    }
    return;
  }
  if (kind === "turn_completed") {
    const stop = stringField(update.stop_reason) ?? stringField(update.stopReason);
    if (stop === "cancelled") {
      turn.status = "interrupted";
      turn.error = "本轮已取消。";
    } else if (stop && stop !== "end_turn") {
      turn.status = "failed";
      turn.error = stop;
    } else {
      turn.status = "completed";
    }
    return;
  }
  if (kind === "session_info" || kind === "usage_update") {
    return;
  }
}

function appendMessage(
  turn: MutableTurn,
  role: "user" | "assistant",
  text: string,
  messageId: string | null,
): void {
  if (!text) return;
  // 连续同角色文字并进当前气泡；中间插入工具后另起一段。
  const last = turn.items.at(-1);
  if (
    last?.type === "message" &&
    last.role === role &&
    !(role === "assistant" && turn.breakAssistantMessage)
  ) {
    last.text += text;
    const tracked = turn.messages.get(last.id);
    if (tracked) {
      tracked.text = last.text;
      tracked.item.text = last.text;
    }
    return;
  }
  let id = messageId ?? `${role}-${turn.messages.size}`;
  if (turn.messages.has(id)) {
    id = `${id}-${turn.messages.size}`;
  }
  const item: Extract<TimelineItem, { type: "message" }> = {
    type: "message",
    id,
    role,
    text,
  };
  turn.messages.set(id, { role, text, item });
  turn.items.push(item);
  if (role === "assistant") turn.breakAssistantMessage = false;
}

function freezeTurn(turn: MutableTurn): TurnSnapshot {
  return {
    id: turn.id,
    status: turn.status,
    error: turn.error,
    // 重新加载只恢复对话；工具条目只在解析时承担气泡分界作用。
    items: turn.items.filter((item) => item.type === "message" || item.type === "note"),
  };
}

function clipStoredText(text: string | null): string | null {
  if (!text) return null;
  if (text.length <= MAX_STORED_COMMAND_OUTPUT) return text;
  return text.slice(-MAX_STORED_COMMAND_OUTPUT);
}


function looksLikeFileChange(
  update: JsonObject,
  command: Extract<TimelineItem, { type: "command" }>,
): boolean {
  if (command.kind === "edit" || command.kind === "delete" || command.kind === "move") {
    return true;
  }
  return Array.isArray(update.content) &&
    update.content.some((entry) => isObject(entry) && entry.type === "diff");
}

function replaceWithFileChange(
  turn: MutableTurn,
  command: Extract<TimelineItem, { type: "command" }>,
): void {
  const index = turn.items.indexOf(command);
  if (index < 0) return;
  const changed: Extract<TimelineItem, { type: "file_change" }> = {
    type: "file_change",
    id: command.id,
    status: command.status,
    changedFiles: 1,
  };
  turn.items[index] = changed;
  turn.commands.delete(command.id);
}

function toolOutputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (!isObject(entry)) continue;
    if (entry.type === "content" && isObject(entry.content)) {
      const text = textFromContent(entry.content);
      if (text) parts.push(text);
    }
  }
  return parts.join("");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (isObject(content) && content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
