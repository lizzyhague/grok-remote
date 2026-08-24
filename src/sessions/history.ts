import {
  MAX_STORED_COMMAND_OUTPUT,
  type TimelineItem,
  type TurnSnapshot,
  type TurnStatus,
} from "./types.ts";

type JsonObject = Record<string, unknown>;

/**
 * 把 Grok 的 updates.jsonl 收成浏览器时间线。思考内容和 ACP 内部字段不进入浏览器。
 */
export function parseUpdatesJsonl(source: string): TurnSnapshot[] {
  const turns = new Map<string, MutableTurn>();
  const order: string[] = [];
  let fallback = 0;

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
    const promptId = stringField(meta.promptId) ??
      stringField(meta.prompt_id) ??
      stringField(update.prompt_id) ??
      `anon-${fallback}`;
    let turn = turns.get(promptId);
    if (!turn) {
      turn = {
        id: promptId,
        status: "completed",
        error: null,
        items: [],
        messages: new Map(),
        commands: new Map(),
        breakAssistantMessage: false,
      };
      turns.set(promptId, turn);
      order.push(promptId);
      fallback += 1;
    }
    applyUpdate(turn, update, meta);
  }

  return order.map((id) => freezeTurn(turns.get(id)!));
}

type MutableTurn = {
  id: string;
  status: TurnStatus;
  error: string | null;
  items: TimelineItem[];
  messages: Map<string, { role: "user" | "assistant"; text: string; item: Extract<TimelineItem, { type: "message" }> }>;
  commands: Map<string, Extract<TimelineItem, { type: "command" }>>;
  breakAssistantMessage: boolean;
};

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
    const command: Extract<TimelineItem, { type: "command" }> = {
      type: "command",
      id,
      title: publicToolTitle(update),
      kind: publicToolKind(update),
      status: stringField(update.status) ?? "pending",
      input: clipStoredText(publicToolInput(update)),
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
    const nextTitle = publicToolTitle(update);
    if (nextTitle && nextTitle !== "工具") command.title = command.title || nextTitle;
    const nextInput = publicToolInput(update);
    if (nextInput && !command.input) command.input = clipStoredText(nextInput);
    const output = toolOutputText(update.content);
    if (output) {
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
    items: turn.items.map((item) => {
      if (item.type === "command" && item.output && item.output.length > MAX_STORED_COMMAND_OUTPUT) {
        return {
          ...item,
          output: item.output.slice(-MAX_STORED_COMMAND_OUTPUT),
          outputTruncated: true,
        };
      }
      return item;
    }),
  };
}

function publicToolTitle(update: JsonObject): string {
  const tool = toolMeta(update);
  if (tool?.name) return tool.name;
  const title = stringField(update.title);
  if (title) return title;
  return "工具";
}

export function publicToolInput(update: Record<string, unknown>): string | null {
  const raw = "rawInput" in update ? update.rawInput : undefined;
  if (typeof raw === "string" && raw.trim()) return raw;
  if (!isObject(raw)) return null;
  if (typeof raw.command === "string" && raw.command.trim()) return raw.command;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "variant" || value == null) continue;
    fields[key] = value;
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;
  if (keys.length === 1 && typeof fields[keys[0]!] === "string") {
    return String(fields[keys[0]!]);
  }
  return JSON.stringify(fields, null, 2);
}

function clipStoredText(text: string | null): string | null {
  if (!text) return null;
  if (text.length <= MAX_STORED_COMMAND_OUTPUT) return text;
  return text.slice(-MAX_STORED_COMMAND_OUTPUT);
}

function publicToolKind(update: JsonObject): string {
  const kind = stringField(update.kind);
  if (kind) return kind;
  const tool = toolMeta(update);
  if (tool?.kind) return tool.kind;
  return "other";
}

function toolMeta(update: JsonObject): { name?: string; kind?: string } | null {
  const meta = asObject(update._meta);
  const tool = asObject(meta["x.ai/tool"]);
  if (!tool) return null;
  const result: { name?: string; kind?: string } = {};
  const name = stringField(tool.name);
  const kind = stringField(tool.kind);
  if (name) result.name = name;
  if (kind) result.kind = kind;
  return result;
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

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
