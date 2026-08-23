import { renderMarkdown } from "./markdown.js";

const TOKEN_KEY = "grok-remote-token";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT = 100_000;
const COMMAND_TITLE_LIMIT = 48;

const elements = {
  loginView: byId("login-view"),
  appView: byId("app-view"),
  tokenForm: byId("token-form"),
  tokenInput: byId("token-input"),
  connectButton: byId("connect-button"),
  loginStatus: byId("login-status"),
  projectSelect: byId("project-select"),
  newSessionButton: byId("new-session-button"),
  sessionSearchInput: byId("session-search-input"),
  sessionList: byId("session-list"),
  loadMoreSessionsButton: byId("load-more-sessions-button"),
  collapseSidebarButton: byId("collapse-sidebar-button"),
  openSidebarButton: byId("open-sidebar-button"),
  sidebarBackdrop: byId("sidebar-backdrop"),
  currentSessionTitle: byId("current-session-title"),
  connectionStatus: byId("connection-status"),
  changeTokenButton: byId("change-token-button"),
  timeline: byId("timeline"),
  historyLoader: byId("history-loader"),
  loadOlderButton: byId("load-older-button"),
  emptyState: byId("empty-state"),
  thinkingIndicator: byId("thinking-indicator"),
  thinkingLabel: byId("thinking-label"),
  approvalList: byId("approval-list"),
  notice: byId("notice"),
  noticeText: byId("notice-text"),
  composer: byId("composer"),
  messageInput: byId("message-input"),
  commandMenuButton: byId("command-menu-button"),
  rewindShortcut: byId("rewind-shortcut"),
  sessionInfoShortcut: byId("session-info-shortcut"),
  alwaysApproveShortcut: byId("always-approve-shortcut"),
  taskButton: byId("task-button"),
};

const state = {
  token: "",
  socket: null,
  requestId: 0,
  pending: new Map(),
  reconnectTimer: null,
  projects: [],
  projectId: "",
  sessions: [],
  sessionCursor: null,
  currentSessionId: null,
  lastSeq: 0,
  busy: false,
  taskRunning: false,
  alwaysApprove: false,
  assistantStreams: new Map(),
  commands: new Map(),
  slashMenu: null,
};

elements.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!window.grokRemoteReady) return;
  const token = elements.tokenInput.value.trim();
  if (token) void connect(token);
});
elements.changeTokenButton.addEventListener("click", showLogin);
elements.projectSelect.addEventListener("change", () => {
  state.projectId = elements.projectSelect.value;
  resetCurrentSession();
  void loadSessions();
});
elements.newSessionButton.addEventListener("click", () => void startSession());
elements.sessionSearchInput.addEventListener("input", debounce(() => void loadSessions(), 250));
elements.loadMoreSessionsButton.addEventListener("click", () => void loadSessions({ append: true }));
elements.collapseSidebarButton.addEventListener("click", () => {
  elements.appView.dataset.sidebarCollapsed = "true";
});
elements.openSidebarButton.addEventListener("click", openSidebar);
elements.sidebarBackdrop.addEventListener("click", closeMobileSidebar);
elements.loadOlderButton.addEventListener("click", () => void loadOlderHistory());
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendOrStop();
});
elements.messageInput.addEventListener("input", () => {
  resizeComposer();
  state.slashMenu?.handleInput();
  updateControls();
});
elements.messageInput.addEventListener("keydown", (event) => {
  if (state.slashMenu?.handleKeydown(event)) return;
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void sendOrStop();
  }
});
elements.commandMenuButton.addEventListener("click", () => {
  elements.messageInput.value = "/";
  elements.messageInput.focus();
  state.slashMenu?.handleInput();
});
elements.rewindShortcut.addEventListener("click", () => void state.slashMenu?.runShortcut("rewind"));
elements.sessionInfoShortcut.addEventListener("click", () => void state.slashMenu?.runShortcut("session-info"));
elements.alwaysApproveShortcut.addEventListener("click", () => void toggleAlwaysApprove());

markReady();
const saved = stateGet(TOKEN_KEY);
if (saved) {
  elements.tokenInput.value = saved;
  void connect(saved);
}

function markReady() {
  window.grokRemoteReady = true;
  window.grokRemoteMarkReady?.();
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js");
  }
}

async function connect(token) {
  state.token = token;
  stateSet(TOKEN_KEY, token);
  setConnectionStatus("connecting", "正在连接");
  elements.loginStatus.textContent = "正在连接……";
  closeSocket();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener("open", () => {
    void (async () => {
      try {
        await request("auth", { token });
        showApp();
        setConnectionStatus("connected", "已连接");
        await loadProjects();
        await ensureSlashMenu();
      } catch (error) {
        elements.loginStatus.textContent = errorMessage(error);
        showLogin();
      }
    })();
  });
  socket.addEventListener("message", (event) => handleSocketMessage(String(event.data)));
  socket.addEventListener("close", () => {
    rejectPending(new Error("连接已断开。"));
    setConnectionStatus("error", "已断开，正在重连");
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    elements.loginStatus.textContent = "无法连接到主机。";
  });
}

function handleSocketMessage(source) {
  let message;
  try {
    message = JSON.parse(source);
  } catch {
    return;
  }
  if (message.type === "event") {
    handleServerEvent(message.event);
    return;
  }
  const pending = state.pending.get(message.requestId);
  if (!pending) return;
  state.pending.delete(message.requestId);
  if (message.ok === false || message.type === "error") {
    pending.reject(new Error(message.error?.message || "请求失败。"));
    return;
  }
  pending.resolve(message.data);
}

function request(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      reject(new Error("尚未连接到主机。"));
      return;
    }
    const requestId = `r${++state.requestId}`;
    const timer = window.setTimeout(() => {
      state.pending.delete(requestId);
      reject(new Error("请求超时。"));
      try { state.socket?.close(); } catch {}
    }, REQUEST_TIMEOUT_MS);
    state.pending.set(requestId, {
      resolve: (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    });
    state.socket.send(JSON.stringify({ type, requestId, ...payload }));
  });
}

function rejectPending(error) {
  for (const pending of state.pending.values()) pending.reject(error);
  state.pending.clear();
}

async function loadProjects() {
  const data = await request("projects.list");
  state.projects = Array.isArray(data?.projects) ? data.projects : [];
  elements.projectSelect.replaceChildren();
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    elements.projectSelect.append(option);
  }
  state.projectId = state.projects[0]?.id ?? "";
  elements.projectSelect.value = state.projectId;
  await loadSessions();
}

async function loadSessions({ append = false } = {}) {
  if (!state.projectId) return;
  const data = await request("sessions.list", {
    projectId: state.projectId,
    cursor: append ? state.sessionCursor : null,
    searchTerm: elements.sessionSearchInput.value.trim() || null,
  });
  const incoming = Array.isArray(data?.sessions) ? data.sessions : [];
  state.sessions = append ? [...state.sessions, ...incoming] : incoming;
  state.sessionCursor = data?.nextCursor ?? null;
  elements.loadMoreSessionsButton.hidden = !state.sessionCursor;
  renderSessionList();
}

async function startSession() {
  if (!state.projectId) return;
  const opened = await request("session.start", { projectId: state.projectId });
  applyOpenedSession(opened);
  await loadSessions();
  closeMobileSidebar();
}

async function resumeSession(sessionId) {
  const opened = await request("session.resume", {
    projectId: state.projectId,
    sessionId,
  });
  applyOpenedSession(opened);
  closeMobileSidebar();
}

function applyOpenedSession(opened) {
  state.currentSessionId = opened.session?.id ?? null;
  state.lastSeq = opened.lastSeq ?? 0;
  state.alwaysApprove = opened.alwaysApprove === true;
  state.taskRunning = Boolean(opened.activeTaskId);
  elements.currentSessionTitle.textContent = opened.session?.title || "Grok Remote";
  renderHistory(Array.isArray(opened.tasks) ? opened.tasks : [], opened.hasOlder === true);
  elements.approvalList.replaceChildren();
  for (const approval of opened.pendingApprovals ?? []) addApproval(approval);
  const resumeAfterSeq = opened.resumeAfterSeq ?? 0;
  if (resumeAfterSeq < state.lastSeq || state.taskRunning) {
    void request("events.resume", { afterSeq: resumeAfterSeq }).then((data) => {
      for (const event of data?.events ?? []) handleServerEvent(event);
    }).catch((error) => showNotice(errorMessage(error)));
  }
  updateControls();
  renderSessionList();
}

function renderSessionList() {
  elements.sessionList.replaceChildren();
  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-item";
    button.setAttribute("role", "listitem");
    if (session.id === state.currentSessionId) button.setAttribute("aria-current", "true");
    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = session.title || "未命名会话";
    const preview = document.createElement("span");
    preview.textContent = session.preview || formatDate(session.updatedAt);
    text.append(title, preview);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet small danger";
    remove.textContent = "删除";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteSession(session);
    });
    button.append(text, remove);
    button.addEventListener("click", () => void resumeSession(session.id));
    elements.sessionList.append(button);
  }
}

async function deleteSession(session) {
  if (!window.confirm(`永久删除「${session.title || "未命名会话"}」？此操作不能恢复。`)) return;
  await request("sessions.delete", {
    projectId: state.projectId,
    sessionIds: [session.id],
  });
  if (state.currentSessionId === session.id) resetCurrentSession();
  await loadSessions();
}

function resetCurrentSession() {
  state.currentSessionId = null;
  state.lastSeq = 0;
  state.taskRunning = false;
  state.alwaysApprove = false;
  state.assistantStreams.clear();
  state.commands.clear();
  elements.currentSessionTitle.textContent = "Grok Remote";
  clearTimeline();
  showEmpty("选择以前的会话，或者新建一个会话。");
  elements.approvalList.replaceChildren();
  updateControls();
}

function renderHistory(tasks, hasOlder) {
  clearTimeline();
  elements.historyLoader.hidden = !hasOlder;
  if (!tasks.length) {
    showEmpty("还没有消息。直接输入，或用 / 查看命令。");
    return;
  }
  hideEmpty();
  renderTasks(tasks);
  scrollToBottom(true);
}

function renderTasks(tasks) {
  for (const task of tasks) {
    for (const item of task.items ?? []) {
      if (item.type === "message") {
        addMessage(item.role, item.text, item.id, false);
      } else if (item.type === "command") {
        completeCommand({
          id: item.id,
          title: item.title,
          status: item.status,
          output: item.output,
          outputTruncated: item.outputTruncated,
        });
      } else if (item.type === "file_change") {
        addFileChange(item);
      } else if (item.type === "note") {
        addTaskNote(item.text);
      }
    }
    if (task.status === "interrupted" && task.error) addTaskNote(task.error);
  }
}

async function loadOlderHistory() {
  const data = await request("history.older");
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  elements.historyLoader.hidden = data?.hasOlder !== true;
  const fragment = document.createDocumentFragment();
  const marker = elements.timeline.firstChild;
  for (const task of tasks) {
    for (const item of task.items ?? []) {
      if (item.type === "message") {
        fragment.append(createMessageElement(item.role, item.text, item.id, false));
      }
    }
  }
  elements.timeline.insertBefore(fragment, marker);
}

async function sendOrStop() {
  if (state.taskRunning) {
    await request("task.stop");
    return;
  }
  const text = elements.messageInput.value.trim();
  if (!text || !state.currentSessionId) return;
  if (await state.slashMenu?.submit(text)) {
    updateControls();
    return;
  }
  await sendMessage(text);
}

async function sendMessage(text) {
  const clientMessageId = crypto.randomUUID();
  state.taskRunning = true;
  updateControls();
  showThinking();
  try {
    const result = await request("message.send", { text, clientMessageId });
    elements.messageInput.value = "";
    resizeComposer();
    if (result?.sessionId && result.sessionId !== state.currentSessionId) {
      state.currentSessionId = result.sessionId;
    }
  } catch (error) {
    state.taskRunning = false;
    hideThinking();
    showNotice(errorMessage(error));
  }
  updateControls();
}

async function toggleAlwaysApprove() {
  const result = await request("permissions.always-approve.toggle");
  state.alwaysApprove = result?.enabled === true;
  updateControls();
}

function handleServerEvent(event) {
  if (!event || typeof event.type !== "string") return;
  if (typeof event.seq === "number") state.lastSeq = Math.max(state.lastSeq, event.seq);
  switch (event.type) {
    case "session.bound":
      if (event.sessionId) state.currentSessionId = event.sessionId;
      void loadSessions();
      break;
    case "session.changed":
      void loadSessions();
      if (event.change === "delete" && event.sessionIds?.includes(state.currentSessionId)) {
        resetCurrentSession();
      }
      break;
    case "session.title":
      if (event.title) {
        elements.currentSessionTitle.textContent = event.title;
        const found = state.sessions.find((session) => session.id === state.currentSessionId);
        if (found) found.title = event.title;
        renderSessionList();
      }
      break;
    case "message.user":
      hideEmpty();
      addMessage("user", event.text ?? "", event.itemId, false);
      break;
    case "message.delta":
      hideThinking();
      appendAssistantDelta(event.itemId, event.text ?? "");
      break;
    case "message.completed":
      completeAssistant(event.itemId, event.text ?? "");
      break;
    case "command.started":
      hideThinking();
      startCommand(event);
      break;
    case "command.output.delta":
      appendCommandOutput(event.itemId, event.text ?? "");
      break;
    case "command.completed":
      completeCommand(event);
      break;
    case "file_change.completed":
      addFileChange(event);
      break;
    case "approval.requested":
      addApproval(event);
      break;
    case "approval.resolved":
      removeApproval(event.approvalId);
      break;
    case "turn.status":
      if (event.status === "running") {
        state.taskRunning = true;
        showThinking();
      }
      if (event.status === "waiting_for_permission") {
        hideThinking();
        showNotice("正在等待审批。");
      }
      if (event.status === "completed" || event.status === "interrupted" || event.status === "failed") {
        state.taskRunning = false;
        hideThinking();
        if (event.status !== "completed") {
          addTaskNote(event.reason || (event.status === "interrupted" ? "本轮已中止。" : "本轮失败。"));
        }
        for (const stream of state.assistantStreams.values()) {
          if (!stream.markdownRendered && stream.target) completeAssistant(stream.itemId, stream.target);
        }
      }
      updateControls();
      break;
    default:
      break;
  }
}

function addMessage(role, text, id, buffered) {
  hideEmpty();
  const element = createMessageElement(role, text, id, buffered);
  elements.timeline.append(element);
  if (role === "assistant" && buffered) {
    state.assistantStreams.set(id, {
      itemId: id,
      element,
      textElement: element.querySelector(".message-text"),
      target: text,
      shown: "",
      completed: false,
      markdownRendered: false,
      frame: null,
    });
  }
  scrollToBottom(false);
}

function createMessageElement(role, text, id, buffered) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.dataset.itemId = id ?? "";
  if (buffered) {
    const span = document.createElement("div");
    span.className = "message-text";
    span.textContent = text;
    article.append(span);
  } else if (role === "assistant") {
    article.append(renderMarkdown(text));
  } else {
    article.textContent = text;
  }
  return article;
}

function appendAssistantDelta(itemId, delta) {
  let stream = state.assistantStreams.get(itemId);
  if (!stream) {
    addMessage("assistant", "", itemId, true);
    stream = state.assistantStreams.get(itemId);
  }
  stream.target += delta;
  scheduleAssistantFrame(stream);
}

function completeAssistant(itemId, text) {
  let stream = state.assistantStreams.get(itemId);
  if (!stream) {
    addMessage("assistant", "", itemId, true);
    stream = state.assistantStreams.get(itemId);
  }
  stream.target = text || stream.target;
  stream.completed = true;
  scheduleAssistantFrame(stream);
}

function scheduleAssistantFrame(stream) {
  if (stream.frame !== null) return;
  stream.frame = requestAnimationFrame(() => animateAssistant(stream));
}

function animateAssistant(stream) {
  stream.frame = null;
  if (stream.markdownRendered) {
    const stick = isNearBottom();
    stream.shown = stream.target;
    stream.element.replaceChildren(renderMarkdown(stream.target));
    if (stick) scrollToBottom(false);
    return;
  }
  const remaining = stream.target.length - stream.shown.length;
  if (remaining <= 0) {
    if (stream.completed && !stream.markdownRendered) {
      const stick = isNearBottom();
      stream.element.replaceChildren(renderMarkdown(stream.target));
      stream.markdownRendered = true;
      if (stick) scrollToBottom(false);
    }
    return;
  }
  const stick = isNearBottom();
  let amount = Math.min(80, Math.max(1, Math.ceil(remaining / 24)));
  const end = stream.shown.length + amount;
  const lastCode = stream.target.charCodeAt(end - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) amount += 1;
  stream.shown = stream.target.slice(0, stream.shown.length + amount);
  stream.textElement.textContent = stream.shown;
  if (stick) scrollToBottom(false);
  scheduleAssistantFrame(stream);
}

function startCommand(event) {
  hideEmpty();
  const itemId = event.itemId ?? event.id;
  if (state.commands.has(itemId)) return;
  const details = document.createElement("details");
  details.className = "command";
  const summary = document.createElement("summary");
  const output = document.createElement("pre");
  const fullTitle = event.title || "命令";
  summary.textContent = `${truncateTitle(fullTitle)} · 运行中`;
  summary.title = fullTitle;
  output.textContent = "等待输出……";
  details.append(summary, output);
  elements.timeline.append(details);
  state.commands.set(itemId, {
    details,
    summary,
    outputElement: output,
    title: fullTitle,
    output: "",
    truncated: false,
  });
  scrollToBottom(false);
}

function appendCommandOutput(itemId, delta) {
  const command = state.commands.get(itemId);
  if (!command) return;
  command.output += delta;
  if (command.output.length > MAX_COMMAND_OUTPUT) {
    command.output = command.output.slice(-MAX_COMMAND_OUTPUT);
    command.truncated = true;
  }
  command.outputElement.textContent = `${command.truncated ? "（较早输出已省略）\n" : ""}${command.output}`;
}

function completeCommand(event) {
  const itemId = event.id ?? event.itemId;
  if (!state.commands.has(itemId)) {
    startCommand({ itemId, title: event.title });
  }
  const command = state.commands.get(itemId);
  if (!command) return;
  if (event.title) command.title = event.title;
  const status = commandStatus(event.status);
  command.summary.textContent = `${truncateTitle(command.title)} · ${status}`;
  command.summary.title = command.title;
  if (typeof event.output === "string") {
    command.output = event.output.length > MAX_COMMAND_OUTPUT
      ? event.output.slice(-MAX_COMMAND_OUTPUT)
      : event.output;
    command.truncated = event.outputTruncated === true || event.output.length > MAX_COMMAND_OUTPUT;
  }
  command.outputElement.textContent = command.output
    ? `${command.truncated ? "（较早输出已省略）\n" : ""}${command.output}`
    : "没有输出。";
}

function addFileChange(event) {
  hideEmpty();
  const note = document.createElement("p");
  note.className = "file-change";
  note.textContent = `文件改动完成：${event.changedFiles ?? 0} 个文件。`;
  elements.timeline.append(note);
  scrollToBottom(false);
}

function addTaskNote(text) {
  const note = document.createElement("p");
  note.className = "task-note";
  note.textContent = text;
  elements.timeline.append(note);
  scrollToBottom(false);
}

function addApproval(approval) {
  removeApproval(approval.approvalId);
  const card = document.createElement("div");
  card.className = "approval-card";
  card.dataset.approvalId = approval.approvalId;
  const reason = document.createElement("p");
  reason.textContent = approval.reason || (approval.kind === "user_input"
    ? "Grok 需要你回答一个问题。"
    : "Grok 需要你批准一次操作。");
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  if (approval.kind === "user_input" && Array.isArray(approval.options) && approval.options.length) {
    for (const option of approval.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option.name;
      button.addEventListener("click", () => void answerApproval(card, approval.approvalId, "approve_once", option.optionId));
      actions.append(button);
    }
  } else {
    const allow = document.createElement("button");
    allow.type = "button";
    allow.className = "primary";
    allow.textContent = "本次允许";
    allow.addEventListener("click", () => void answerApproval(card, approval.approvalId, "approve_once", null));
    const decline = document.createElement("button");
    decline.type = "button";
    decline.textContent = "拒绝";
    decline.addEventListener("click", () => void answerApproval(card, approval.approvalId, "decline", null));
    actions.append(allow, decline);
  }
  card.append(reason, actions);
  elements.approvalList.append(card);
}

async function answerApproval(card, approvalId, decision, optionId) {
  card.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  await request("approval.answer", { approvalId, decision, optionId });
  removeApproval(approvalId);
}

function removeApproval(approvalId) {
  elements.approvalList.querySelector(`[data-approval-id="${CSS.escape(String(approvalId ?? ""))}"]`)?.remove();
}

function handleCommandResult(result) {
  if (typeof result?.enabled === "boolean") {
    state.alwaysApprove = result.enabled;
    updateControls();
    showNotice(result.enabled ? "已打开 always-approve。" : "已关闭 always-approve。");
    return;
  }
  if (result?.kind === "info") {
    addTaskNote([result.title, ...(result.lines ?? [])].filter(Boolean).join("\n"));
    return;
  }
  if (result?.turnId) {
    state.taskRunning = true;
    showThinking();
    updateControls();
  }
}

async function ensureSlashMenu() {
  const Menu = window.SlashCommandMenu;
  if (!Menu || state.slashMenu) {
    if (state.slashMenu) await state.slashMenu.load();
    return;
  }
  state.slashMenu = new Menu({
    input: elements.messageInput,
    element: byId("slash-menu"),
    request,
    onResult: handleCommandResult,
    onError: (error) => showNotice(errorMessage(error)),
    onBusy: (busy) => {
      state.busy = busy;
      updateControls();
    },
    onInputChanged: () => {
      resizeComposer();
      updateControls();
    },
  });
  await state.slashMenu.load();
}

function updateControls() {
  const connected = state.socket?.readyState === WebSocket.OPEN;
  const hasSession = Boolean(state.currentSessionId);
  const canType = connected && hasSession && !state.busy;
  elements.messageInput.disabled = !canType;
  elements.commandMenuButton.disabled = !canType;
  elements.rewindShortcut.disabled = !canType || state.taskRunning;
  elements.sessionInfoShortcut.disabled = !canType;
  elements.alwaysApproveShortcut.disabled = !canType;
  elements.alwaysApproveShortcut.setAttribute("aria-pressed", String(state.alwaysApprove));
  elements.newSessionButton.disabled = !connected || !state.projectId || state.busy;
  elements.taskButton.disabled = !canType && !(connected && hasSession && state.taskRunning);
  elements.taskButton.textContent = state.taskRunning ? "停止" : "发送";
  elements.messageInput.placeholder = hasSession ? "输入消息，或输入 / 查看命令" : "先选择或新建会话";
}

function openSidebar() {
  elements.appView.dataset.sidebarCollapsed = "false";
  elements.appView.dataset.mobileSidebarOpen = "true";
}

function closeMobileSidebar() {
  elements.appView.dataset.mobileSidebarOpen = "false";
}

function clearTimeline() {
  for (const node of [...elements.timeline.children]) {
    if (node.id === "history-loader" || node.id === "empty-state" || node.id === "thinking-indicator") continue;
    node.remove();
  }
}

function showEmpty(text) {
  elements.emptyState.hidden = false;
  elements.emptyState.querySelector("p").textContent = text;
}

function hideEmpty() {
  elements.emptyState.hidden = true;
}

function showThinking(label = "正在思考") {
  elements.thinkingLabel.textContent = label;
  elements.thinkingIndicator.hidden = false;
}

function hideThinking() {
  elements.thinkingIndicator.hidden = true;
}

function resizeComposer() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 180)}px`;
}

function isNearBottom() {
  const node = elements.timeline;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

function scrollToBottom(force) {
  if (!force && !isNearBottom()) return;
  elements.timeline.scrollTop = elements.timeline.scrollHeight;
}

function showLogin() {
  closeSocket();
  removeStored(TOKEN_KEY);
  elements.appView.hidden = true;
  elements.loginView.hidden = false;
  elements.loginStatus.textContent = "";
  elements.tokenInput.focus();
}

function showApp() {
  elements.loginView.hidden = true;
  elements.appView.hidden = false;
  resetCurrentSession();
}

function setConnectionStatus(status, text) {
  elements.connectionStatus.dataset.state = status;
  elements.connectionStatus.textContent = text;
}

function showNotice(text) {
  elements.notice.hidden = !text;
  elements.noticeText.textContent = text ?? "";
}

function closeSocket() {
  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.socket) {
    state.socket.onclose = null;
    try { state.socket.close(); } catch {}
    state.socket = null;
  }
}

function scheduleReconnect() {
  if (state.reconnectTimer || !state.token) return;
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    void connect(state.token);
  }, 1200);
}

function commandStatus(status) {
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "in_progress") return "运行中";
  return status || "完成";
}

function truncateTitle(title) {
  const chars = [...String(title ?? "")];
  if (chars.length <= COMMAND_TITLE_LIMIT) return title;
  return `${chars.slice(0, COMMAND_TITLE_LIMIT).join("")}…`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "请求失败。";
}

function stateGet(key) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function stateSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function removeStored(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function debounce(fn, wait) {
  let timer = 0;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, wait);
  };
}

function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少页面元素 ${id}`);
  return node;
}
