import { readFileSync } from "node:fs";
import vm from "node:vm";

export type LocalText = { key: string; params?: Record<string, LocalTextParam> };
export type LocalTextParam = string | number | LocalText;
export type DisplayText = string | LocalText;
export type TextLanguage = "zh" | "en";

type Translation = string | { one: string; other: string };
const STRINGS_URL = new URL("../../public/strings.js", import.meta.url);
const context: { window: { grokRemoteStrings?: Record<string, Record<string, Translation>> } } = { window: {} };
vm.runInNewContext(readFileSync(STRINGS_URL, "utf8"), context);
const strings = context.window.grokRemoteStrings ?? {};

export function localText(key: string, params?: Record<string, LocalTextParam>): LocalText {
  return params ? { key, params } : { key };
}

export function hasText(key: string): boolean {
  return Object.hasOwn(strings, key);
}

export function englishText(text: LocalText): string {
  return renderText(text, "en");
}

export function renderText(text: DisplayText, language: TextLanguage): string {
  if (typeof text === "string") return text;
  const entry = strings[text.key];
  let template = entry?.[language] ?? entry?.zh ?? text.key;
  if (typeof template === "object") template = text.params?.count === 1 ? template.one : template.other;
  if (!text.params) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    if (!Object.hasOwn(text.params!, name)) return match;
    const value = text.params![name]!;
    return typeof value === "object" ? renderText(value, language) : String(value);
  });
}

export function isLocalText(value: unknown): value is LocalText {
  if (typeof value !== "object" || value === null) return false;
  const { key, params } = value as { key?: unknown; params?: unknown };
  return typeof key === "string" && (params === undefined || (typeof params === "object" && params !== null &&
    Object.values(params).every((item) =>
      typeof item === "string" || typeof item === "number" || isLocalText(item))));
}

const KNOWN_TEXT = new Map<string, string>([
  ["The request failed.", "request.failed"],
  ["Open a session first.", "backend.openSessionFirst"],
  ["This backend does not have attachments enabled.", "backend.attachmentsUnavailable"],
  ["A task is running in this project, so sessions cannot be organized right now.", "session.organizingBusy"],
  ["Another task is already running in this project.", "backend.projectBusy"],
  ["This device cannot stop this task.", "backend.cannotStopTask"],
  ["This approval has already ended.", "backend.approvalEnded"],
  ["The project does not exist or is outside the allowed roots.", "backend.projectMissing"],
  ["This session has not been saved and cannot be pinned.", "backend.unsavedCannotPin"],
  ["This session has not been saved and cannot be renamed.", "backend.unsavedCannotRename"],
  ["This session has not been saved and cannot be organized.", "backend.unsavedCannotOrganize"],
  ["This session could not be found.", "backend.sessionMissing"],
  ["The session does not exist.", "backend.sessionDoesNotExist"],
  ["This session does not belong to the current project.", "backend.sessionWrongProject"],
  ["The session does not exist or does not belong to this project.", "backend.sessionMissingOrWrongProject"],
  ["This session is in trash. Restore it before opening it.", "backend.restoreBeforeOpen"],
  ["This session is already in trash.", "backend.alreadyInTrash"],
  ["This session is in trash. Restore it from trash.", "backend.restoreFromTrash"],
  ["This session is not in this project’s trash.", "backend.notInProjectTrash"],
  ["Only sessions in trash can be permanently deleted.", "backend.deleteTrashOnly"],
  ["A task is still running in this session, so it cannot be organized right now.", "backend.sessionBusy"],
  ["The session working directory is invalid.", "backend.invalidSessionDirectory"],
  ["The current session is stopping a task. Try again shortly.", "backend.sessionStopping"],
  ["The current session is running a task. Try again shortly.", "backend.sessionRunning"],
  ["This session has no turn to rewind.", "backend.nothingToRewind"],
  ["Grok did not complete the rewind.", "backend.rewindFailed"],
  ["Grok did not return the current model, so reasoning effort cannot be changed alone.", "backend.modelUnavailable"],
  ["The backend restarted, so the previous turn could not continue.", "backend.restartInterrupted"],
  ["The active Grok session limit has been reached. Wait for one to end and try again.", "backend.sessionLimit"],
  ["Sessions in trash cannot be pinned. Restore the session first.", "backend.trashCannotPin"],
  ["Grok is requesting to run a command.", "backend.approvalCommand"],
  ["Grok is requesting to modify files.", "backend.approvalFileChange"],
  ["Grok is requesting to perform an action.", "backend.approvalAction"],
  ["Enter a session name after /rename.", "backend.renameArgument"],
  ["Choose a model first.", "backend.chooseModel"],
  ["Choose a reasoning effort first.", "backend.chooseEffort"],
  ["Grok ACP currently supports direct compaction only; compaction instructions cannot be added.", "backend.compactArgumentUnsupported"],
  ["This slash command is not supported.", "backend.commandUnsupported"],
  ["The message is too large. The limit is 2 MiB.", "backend.messageTooLarge"],
  ["The message is not valid JSON.", "backend.invalidJson"],
  ["The message must be a JSON object.", "backend.invalidMessage"],
  ["The request ID must not be empty.", "backend.requestIdRequired"],
  ["The message is missing a type.", "backend.messageTypeRequired"],
  ["The approval decision is not recognized.", "backend.invalidApprovalDecision"],
  ["This message type is not supported.", "backend.messageTypeUnsupported"],
  ["The session list view is not recognized.", "backend.invalidSessionView"],
  ["The session organization action is not recognized.", "backend.invalidSessionAction"],
  ["The session name must not be empty.", "rename.empty"],
  ["The session name is too long.", "backend.sessionNameTooLong"],
  ["The session name must not contain line breaks.", "backend.sessionNameLineBreak"],
  ["The shared upload service returned an oversized response.", "backend.uploadResponseTooLarge"],
  ["The shared upload service returned an invalid response.", "backend.uploadInvalidResponse"],
  ["The shared upload service rejected the request.", "backend.uploadRejected"],
  ["The shared upload service is temporarily unavailable.", "backend.uploadUnavailable"],
  ["Turn always-approve on or off. When enabled, approvable tools no longer prompt.", "command.alwaysApproveDescription"],
  ["Compact session", "command.compactTitle"],
  ["Summarize earlier conversation to free context space.", "command.compactDescription"],
  ["Compaction summarizes earlier conversation to free context space. Start now?", "command.compactConfirmation"],
  ["View context", "command.contextTitle"],
  ["Show context usage for the current session.", "command.contextDescription"],
  ["Reasoning effort", "command.effortTitle"],
  ["Change reasoning effort for the current model without switching models.", "command.effortDescription"],
  ["Switch model", "command.modelTitle"],
  ["Choose the model to use for subsequent turns in this session.", "command.modelDescription"],
  ["Plan mode", "command.planTitle"],
  ["Enter plan mode; a question may follow the command.", "command.planDescription"],
  ["Rename session", "command.renameTitle"],
  ["Give the current session an easy-to-find name.", "command.renameDescription"],
  ["Rewind one turn", "command.rewindTitle"],
  ["Remove the latest turn from conversation context without undoing file changes.", "command.rewindDescription"],
  ["Rewinding removes the latest turn from this session but does not undo its file changes. Continue?", "command.rewindConfirmation"],
  ["View status", "command.statusTitle"],
  ["Show the current model, session, and context usage. You can also enter /status.", "command.statusDescription"],
  ["Choose model", "command.chooseModel"],
  ["Choose reasoning effort", "command.chooseEffort"],
  ["Model", "command.resultModel"],
  ["Context", "command.resultContext"],
  ["Session status", "command.resultStatus"],
  ["Session name", "command.resultSessionName"],
  ["Entered plan mode; subsequent messages will be handled in plan mode.", "command.planEntered"],
  ["Grok did not return context usage.", "command.noContext"],
  ["The user stopped this turn.", "backend.userStopped"],
  ["No one was available to handle permissions or user input, so this turn was interrupted.", "backend.noFrontendHandler"],
  ["User input is required, but no frontend is connected.", "backend.noFrontendInput"],
  ["This turn failed.", "task.failed"],
  ["This turn was cancelled.", "backend.turnCancelled"],
  ["Deletion failed.", "backend.deletionFailed"],
  ["The operation failed.", "selection.failed"],
  ["The server could not access a local file. Check the service log.", "backend.systemFileError"],
  ["The attachment upload failed.", "attachment.failed"],
  ["This client message ID was already used for different text or attachments.", "backend.clientMessageConflict"],
  ["Could not start the Grok worker.", "backend.workerStartFailed"],
  ["The working directory is resolved by the backend and is not sent to the browser.", "command.cwdHidden"],
  ["Grok did not return a session ID.", "backend.noSessionId"],
  ["Grok did not complete the session rename.", "backend.renameIncomplete"],
  ["Grok did not return the session status.", "backend.noSessionStatus"],
  ["The Grok worker is already closed.", "backend.workerAlreadyClosed"],
  ["The Grok worker is closed.", "backend.workerClosed"],
  ["The session does not belong to the current project.", "backend.sessionForeign"],
  ["The pending session to bind could not be found.", "backend.pendingBindMissing"],
  ["The session ID is invalid.", "backend.invalidSessionId"],
  ["The shared upload service request timed out.", "backend.uploadTimeout"],
  ["The browser aborted the upload.", "backend.uploadAborted"],
]);

const FIELD_TEXT = new Map<string, string>([
  ["project ID", "field.projectId"], ["pagination cursor", "field.cursor"],
  ["search text", "field.search"], ["session ID", "field.sessionId"], ["marked", "field.marked"],
  ["event sequence number", "field.eventSequence"], ["command option", "field.commandOption"],
  ["command argument", "field.commandArgument"], ["file name", "field.fileName"],
  ["file size", "field.fileSize"], ["attachment ID", "field.attachmentId"],
  ["client message ID", "field.clientMessageId"], ["approval ID", "field.approvalId"],
  ["option ID", "field.optionId"], ["message", "field.message"],
]);

function fieldText(value: string): LocalTextParam {
  const key = FIELD_TEXT.get(value);
  return key ? localText(key) : value;
}

/** Converts only backend-owned, known interface text. Unknown strings, including Grok output, pass through. */
export function localizeKnownText(value: string): DisplayText {
  const key = KNOWN_TEXT.get(value);
  if (key) return localText(key);
  let match = /^Grok Remote could not read the attachment: (.+)\.$/u.exec(value);
  if (match) return localText("backend.attachmentUnreadableName", { name: match[1]! });
  match = /^The Grok worker exited \((.+)\)\.$/u.exec(value);
  if (match) return localText("backend.workerExited", { detail: match[1]! });
  match = /^The host does not have enough available memory to start another Grok worker\. (\d+) MiB is available; the threshold is (\d+) MiB \(platform: ([^;]+); source: ([^)]+)\)\. New workers will be allowed automatically when memory recovers\. If this host is expected to operate at this level, adjust GROK_REMOTE_MIN_FREE_MEMORY_MB\.$/u.exec(value);
  if (match) return localText("backend.memoryLow", {
    available: Number(match[1]), threshold: Number(match[2]), platform: match[3]!, source: match[4]!,
  });
  match = /^(.+) must be a boolean\.$/u.exec(value);
  if (match) return localText("backend.fieldBoolean", { field: fieldText(match[1]!) });
  match = /^(.+) must be a non-negative integer\.$/u.exec(value);
  if (match) return localText("backend.fieldNonNegative", { field: fieldText(match[1]!) });
  match = /^(.+) must not be empty or too long\.$/u.exec(value);
  if (match) return localText("backend.fieldInvalid", { field: fieldText(match[1]!) });
  match = /^(.+) list must not be empty and may contain at most (\d+) items\.$/u.exec(value);
  if (match) return localText("backend.listRequired", { field: fieldText(match[1]!), count: Number(match[2]) });
  match = /^(.+) list may contain at most (\d+) items\.$/u.exec(value);
  if (match) return localText("backend.listLimit", { field: fieldText(match[1]!), count: Number(match[2]) });
  match = /^(.+) \(default\)$/u.exec(value);
  if (match) return localText("command.defaultOption", { label: match[1]! });
  match = /^Switched to (.+)\.$/u.exec(value);
  if (match) return localText("command.modelSwitched", { model: match[1]! });
  match = /^Renamed to “(.+)”\.$/u.exec(value);
  if (match) return localText("command.renamed", { title: match[1]! });
  match = /^(.+) switched to (.+)\.$/u.exec(value);
  if (match) return localText("command.effortSwitched", { model: match[1]!, effort: match[2]! });
  for (const [prefix, labelKey] of [
    ["Session: ", "command.lineSession"], ["Session ID: ", "command.lineSessionId"],
    ["Model: ", "command.lineModel"], ["Permission: ", "command.linePermission"],
    ["Shell: ", "command.lineShell"], ["Agent: ", "command.lineAgent"], ["API: ", "command.lineApi"],
    ["Recorded entries: ", "command.lineEntries"], ["Context: ", "command.lineContext"],
    ["Used: ", "command.lineUsed"], ["Available: ", "command.lineAvailable"],
    ["System prompt: ", "command.lineSystemPrompt"], ["Messages: ", "command.lineMessages"],
    ["Tool definitions: ", "command.lineToolDefinitions"],
  ] as const) {
    if (value.startsWith(prefix)) return localText(labelKey, { value: value.slice(prefix.length) });
  }
  match = /^Turns: (.+); tool calls: (.+); compactions: (.+)$/u.exec(value);
  if (match) return localText("command.lineCounts", { turns: match[1]!, tools: match[2]!, compactions: match[3]! });
  return value;
}

export function localizeKnownTexts(value: unknown): unknown {
  if (typeof value === "string") return localizeKnownText(value);
  if (Array.isArray(value)) return value.map(localizeKnownTexts);
  if (!value || typeof value !== "object" || isLocalText(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => {
    // These fields may contain user or Grok-authored text. Command metadata is the only backend-owned exception.
    if (["text", "delta", "input", "output"].includes(key)) return [key, item];
    if (key === "title") {
      const isCommandText = (record.kind === "info" && Array.isArray(record.lines)) ||
        (typeof record.name === "string" && Object.hasOwn(record, "description"));
      return [key, isCommandText && typeof item === "string" ? localizeKnownText(item) : item];
    }
    if (key === "description") {
      const isCommandText = typeof record.name === "string";
      return [key, isCommandText && typeof item === "string" ? localizeKnownText(item) : item];
    }
    if (key === "label") {
      return [key, typeof item === "string" && / \(default\)$/u.test(item) ? localizeKnownText(item) : item];
    }
    return [key, localizeKnownTexts(item)];
  }));
}
