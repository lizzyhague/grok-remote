import { renderMarkdown } from "./markdown.js";

const TOKEN_KEY = "grok-remote-token";
const PROJECT_KEY = "grok-remote.project";
const SIDEBAR_COLLAPSED_KEY = "grok-remote.sidebar-collapsed";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT = 100_000;
const TOOL_TITLE_LIMIT = 48;
/** 输入框失焦后稍等再点亮 rewind / always-approve，避免同一下既失焦又点到确认。 */
const COMPOSER_CONFIRM_UNLOCK_MS = 300;

const elements = {
  loginView: byId("login-view"),
  appView: byId("app-view"),
  tokenForm: byId("token-form"),
  tokenInput: byId("token-input"),
  connectButton: byId("connect-button"),
  loginStatus: byId("login-status"),
  sessionSidebar: byId("session-sidebar"),
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
  sessionTitle: "",
  lastSeq: 0,
  busy: false,
  taskRunning: false,
  alwaysApprove: false,
  sidebarCollapsed: stateGet(SIDEBAR_COLLAPSED_KEY) === "1",
  mobileSidebarOpen: false,
  composerLocksConfirms: false,
  composerFocusTimer: null,
  assistantStreams: new Map(),
  liveAssistant: null,
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
  stateSet(PROJECT_KEY, state.projectId);
  resetCurrentSession();
  void loadSessions();
});
elements.newSessionButton.addEventListener("click", () => void startSession());
elements.sessionSearchInput.addEventListener("input", debounce(() => void loadSessions(), 250));
elements.loadMoreSessionsButton.addEventListener("click", () => void loadSessions({ append: true }));
elements.collapseSidebarButton.addEventListener("click", closeSidebar);
elements.openSidebarButton.addEventListener("click", openSidebar);
elements.sidebarBackdrop.addEventListener("click", closeSidebar);
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
elements.messageInput.addEventListener("focus", () => {
  window.clearTimeout(state.composerFocusTimer);
  state.composerLocksConfirms = true;
  updateControls();
});
elements.messageInput.addEventListener("blur", () => {
  window.clearTimeout(state.composerFocusTimer);
  state.composerFocusTimer = window.setTimeout(() => {
    state.composerLocksConfirms = false;
    updateControls();
  }, COMPOSER_CONFIRM_UNLOCK_MS);
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

elements.appView.dataset.sidebarCollapsed = String(state.sidebarCollapsed);
syncSidebarState();

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
    setConnectionStatus("disconnected", "已断开，正在重连");
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
  const savedProject = stateGet(PROJECT_KEY);
  const selected = state.projects.some((project) => project.id === savedProject)
    ? savedProject
    : state.projects[0]?.id ?? "";
  state.projectId = selected;
  elements.projectSelect.value = selected;
  if (selected) stateSet(PROJECT_KEY, selected);
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
  state.sessionTitle = opened.session?.title || "";
  state.lastSeq = opened.lastSeq ?? 0;
  state.alwaysApprove = opened.alwaysApprove === true;
  state.taskRunning = Boolean(opened.activeTaskId);
  updateConversationTitle();
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
  if (state.sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "session-list-empty";
    empty.textContent = elements.sessionSearchInput.value.trim()
      ? "没有找到匹配的会话。"
      : "这个项目还没有会话。";
    elements.sessionList.append(empty);
    updateControls();
    return;
  }
  for (const session of state.sessions) {
    elements.sessionList.append(createSessionItem(session));
  }
  updateControls();
}

function createSessionItem(session) {
  const item = document.createElement("article");
  item.className = "session-item";
  item.dataset.current = String(session.id === state.currentSessionId);
  item.dataset.state = session.state || "not_loaded";
  item.setAttribute("role", "listitem");

  const open = document.createElement("button");
  open.className = "session-open";
  open.type = "button";
  appendSessionText(open, session);
  open.addEventListener("click", () => {
    if (session.id === state.currentSessionId) closeMobileSidebar();
    else void resumeSession(session.id);
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "session-menu-trigger quiet";
  remove.setAttribute("aria-label", `永久删除 ${session.title || "新会话"}`);
  remove.textContent = "⋯";
  remove.addEventListener("click", () => void deleteSession(session));
  item.append(open, remove);
  return item;
}

function appendSessionText(container, session) {
  const title = document.createElement("span");
  title.className = "session-item-title";
  title.textContent = session.title || "新会话";
  const preview = document.createElement("span");
  preview.className = "session-item-preview";
  preview.textContent = session.preview || "暂无内容";
  const meta = document.createElement("span");
  meta.className = "session-item-meta";
  const date = formatDate(session.updatedAt || session.createdAt);
  meta.textContent = session.state === "active"
    ? `运行中${date ? ` · ${date}` : ""}`
    : date;
  container.append(title, preview, meta);
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
  state.sessionTitle = "";
  state.lastSeq = 0;
  state.taskRunning = false;
  state.alwaysApprove = false;
  updateConversationTitle();
  clearTimeline();
  showEmpty("选择以前的会话，或者新建一个会话。");
  elements.approvalList.replaceChildren();
  updateControls();
}

function renderHistory(tasks, hasOlder) {
  clearTimeline();
  elements.timeline.append(elements.historyLoader);
  elements.historyLoader.hidden = !hasOlder;
  const rendered = renderTasks(tasks);
  if (rendered === 0 && !hasOlder) {
    showEmpty("这是一个新会话，可以发送第一条消息了。");
  } else {
    scrollToBottom(true);
  }
}

function renderTasks(tasks) {
  let rendered = 0;
  for (const task of tasks) {
    for (const item of task.items ?? []) {
      if (item.type === "message") {
        addMessage(item.role, item.text, item.id, false);
        rendered += 1;
      } else if (item.type === "note") {
        addTaskNote(item.text);
        rendered += 1;
      }
    }
    if (task.status === "interrupted" && task.error) {
      addTaskNote(task.error);
      rendered += 1;
    }
  }
  return rendered;
}

async function loadOlderHistory() {
  if (!state.currentSessionId || elements.loadOlderButton.disabled) return;
  const sessionId = state.currentSessionId;
  const oldHeight = elements.timeline.scrollHeight;
  const oldTop = elements.timeline.scrollTop;
  const existingNodes = new Set(elements.timeline.children);
  elements.loadOlderButton.disabled = true;
  elements.loadOlderButton.textContent = "加载中……";
  try {
    const data = await request("history.older");
    if (sessionId !== state.currentSessionId) return;
    renderTasks(Array.isArray(data?.tasks) ? data.tasks : []);
    const addedNodes = [...elements.timeline.children]
      .filter((node) => !existingNodes.has(node));
    let anchor = elements.historyLoader;
    for (const node of addedNodes) {
      anchor.after(node);
      anchor = node;
    }
    elements.historyLoader.hidden = data?.hasOlder !== true;
    elements.timeline.scrollTop = oldTop + (elements.timeline.scrollHeight - oldHeight);
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    elements.loadOlderButton.disabled = false;
    elements.loadOlderButton.textContent = "加载更早";
  }
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
        state.sessionTitle = event.title;
        updateConversationTitle();
        const found = state.sessions.find((session) => session.id === state.currentSessionId);
        if (found) found.title = event.title;
        renderSessionList();
      }
      break;
    case "message.user":
      hideThinking();
      hideEmpty();
      addMessage("user", event.text ?? "", event.itemId, false);
      if (state.taskRunning) showThinking();
      break;
    case "message.delta":
      hideThinking();
      appendAssistantDelta(event.itemId, event.text ?? "");
      break;
    case "message.completed":
      completeAssistant(event.itemId, event.text ?? "");
      break;
    case "command.started":
      sealAssistantStreams();
      hideThinking();
      startCommand(event);
      showThinking("正在执行工具");
      break;
    case "command.output.delta":
      appendCommandOutput(event.itemId, event.text ?? "");
      break;
    case "command.completed":
      completeCommand(event);
      if (state.taskRunning) showThinking();
      break;
    case "file_change.completed":
      addFileChange(event);
      if (state.taskRunning) showThinking();
      break;
    case "approval.requested":
      addApproval(event);
      break;
    case "approval.resolved":
      removeApproval(event.approvalId);
      if (state.taskRunning) showThinking();
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
  appendToTimeline(element);
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
  return element;
}

function createMessageElement(role, text, id, buffered) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.dataset.itemId = id ?? "";
  if (buffered) {
    const span = document.createElement("pre");
    span.className = "message-text";
    span.textContent = text;
    article.append(span);
  } else {
    article.append(renderMarkdown(text));
  }
  return article;
}

function appendAssistantDelta(itemId, delta) {
  if (!delta) return;
  let stream = state.liveAssistant;
  if (!stream || stream.completed || stream.markdownRendered) {
    const id = itemId || `assistant-${state.assistantStreams.size + 1}`;
    addMessage("assistant", "", id, true);
    stream = state.assistantStreams.get(id);
    state.liveAssistant = stream;
    scrollToBottom(true);
  }
  if (!stream) return;
  stream.target += delta;
  stream.element.classList.add("pending");
  scheduleAssistantFrame(stream);
}

function sealAssistantStreams() {
  const streams = new Set(state.assistantStreams.values());
  if (state.liveAssistant) streams.add(state.liveAssistant);
  for (const stream of streams) {
    if (!stream.completed && stream.target) {
      completeAssistant(stream.itemId, stream.target);
    }
  }
  state.liveAssistant = null;
}

function completeAssistant(itemId, text) {
  let stream = state.assistantStreams.get(itemId);
  const finalText = text || stream?.target || "";
  if (!stream) {
    if (!finalText) return;
    addMessage("assistant", "", itemId, true);
    stream = state.assistantStreams.get(itemId);
  }
  if (!stream) return;
  if (stream.textElement && !finalText.startsWith(stream.shown)) {
    stream.shown = "";
    stream.textElement.textContent = "";
  }
  stream.target = finalText;
  stream.completed = true;
  if (stream.markdownRendered || stream.shown === finalText) {
    finishAssistant(stream);
    return;
  }
  stream.element.classList.add("pending");
  scheduleAssistantFrame(stream);
}

function finishAssistant(stream) {
  stream.completed = true;
  stream.shown = stream.target;
  stream.element.classList.remove("pending");
  if (stream.target) {
    stream.element.replaceChildren(renderMarkdown(stream.target));
    stream.markdownRendered = true;
    stream.textElement = null;
  }
  if (state.liveAssistant === stream) state.liveAssistant = null;
}

function scheduleAssistantFrame(stream) {
  if (stream.frame !== null) return;
  stream.frame = requestAnimationFrame(() => animateAssistant(stream));
}

function animateAssistant(stream) {
  stream.frame = null;
  if (stream.markdownRendered || (stream.completed && stream.shown === stream.target)) {
    const stickToBottom = isNearBottom();
    finishAssistant(stream);
    if (stickToBottom) scrollToBottom(false);
    return;
  }
  const remaining = stream.target.length - stream.shown.length;
  if (remaining <= 0) {
    if (stream.completed) {
      const stickToBottom = isNearBottom();
      finishAssistant(stream);
      if (stickToBottom) scrollToBottom(false);
    }
    return;
  }
  if (!stream.textElement || !stream.textElement.isConnected) {
    const pre = document.createElement("pre");
    pre.className = "message-text";
    stream.element.replaceChildren(pre);
    stream.textElement = pre;
    stream.shown = "";
  }
  const stickToBottom = isNearBottom();
  let amount = Math.min(80, Math.max(1, Math.ceil(remaining / 24)));
  const end = stream.shown.length + amount;
  const lastCode = stream.target.charCodeAt(end - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) amount += 1;
  stream.shown = stream.target.slice(0, stream.shown.length + amount);
  stream.textElement.textContent = stream.shown;
  if (stickToBottom) scrollToBottom(false);
  scheduleAssistantFrame(stream);
}

function startCommand(event) {
  hideEmpty();
  const itemId = event.itemId ?? event.id;
  if (state.commands.has(itemId)) return;
  const details = document.createElement("details");
  details.className = "command";
  details.dataset.itemId = itemId;
  const summary = document.createElement("summary");
  const pane = document.createElement("div");
  pane.className = "command-pane";
  const inputWrap = document.createElement("div");
  inputWrap.className = "command-block";
  const inputLabel = document.createElement("div");
  inputLabel.className = "command-kicker";
  inputLabel.textContent = "输入";
  const input = document.createElement("pre");
  input.className = "command-input";
  inputWrap.append(inputLabel, input);
  const split = document.createElement("div");
  split.className = "command-split";
  const outputWrap = document.createElement("div");
  outputWrap.className = "command-block";
  const outputLabel = document.createElement("div");
  outputLabel.className = "command-kicker";
  outputLabel.textContent = "输出";
  const output = document.createElement("pre");
  output.className = "command-output";
  outputWrap.append(outputLabel, output);
  pane.append(inputWrap, split, outputWrap);
  details.append(summary, pane);
  appendToTimeline(details);
  const command = {
    details,
    summary,
    inputWrap,
    inputElement: input,
    split,
    outputWrap,
    outputElement: output,
    title: event.title || "工具",
    status: "in_progress",
    input: typeof event.input === "string" ? event.input : "",
    output: "",
    truncated: false,
  };
  state.commands.set(itemId, command);
  renderToolCard(command);
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
  renderToolCard(command);
}

function completeCommand(event) {
  const itemId = event.id ?? event.itemId;
  if (!state.commands.has(itemId)) {
    startCommand({
      itemId,
      title: event.title,
      input: event.input,
    });
  }
  const command = state.commands.get(itemId);
  if (!command) return;
  if (event.title) command.title = event.title;
  if (typeof event.input === "string" && event.input) command.input = event.input;
  if (event.status) command.status = event.status;
  if (typeof event.output === "string" && (event.output || !command.output)) {
    command.output = event.output.length > MAX_COMMAND_OUTPUT
      ? event.output.slice(-MAX_COMMAND_OUTPUT)
      : event.output;
    command.truncated = event.outputTruncated === true || event.output.length > MAX_COMMAND_OUTPUT;
  }
  renderToolCard(command);
}

function renderToolCard(command) {
  const status = commandStatus(command.status);
  const title = clipTitle(command.title);
  command.summary.textContent = `工具：${title} · ${status}`;
  const inputText = command.input.trim();
  if (inputText) {
    command.inputElement.textContent = inputText;
    command.inputWrap.hidden = false;
    command.split.hidden = false;
  } else {
    command.inputWrap.hidden = true;
    command.split.hidden = true;
  }
  command.outputElement.textContent = command.output
    ? `${command.truncated ? "（较早输出已省略）\n" : ""}${command.output}`
    : command.status === "in_progress" || command.status === "pending"
      ? "等待输出……"
      : "没有输出。";
}

function clipTitle(title) {
  const value = title || "工具";
  if (value.length <= TOOL_TITLE_LIMIT) return value;
  return `${value.slice(0, TOOL_TITLE_LIMIT - 1)}…`;
}

function addFileChange(event) {
  hideEmpty();
  const note = document.createElement("p");
  note.className = "file-change";
  note.textContent = `文件改动完成：${event.changedFiles ?? 0} 个文件。`;
  appendToTimeline(note);
  scrollToBottom(false);
}

function addTaskNote(text) {
  const note = document.createElement("p");
  note.className = "task-note";
  note.textContent = text;
  appendToTimeline(note);
  scrollToBottom(false);
}

function appendToTimeline(node) {
  if (elements.thinkingIndicator.parentNode === elements.timeline) {
    elements.thinkingIndicator.before(node);
    return;
  }
  elements.timeline.append(node);
}

function addApproval(approval) {
  removeApproval(approval.approvalId);
  const card = document.createElement("section");
  card.className = "approval-card";
  card.dataset.approvalId = approval.approvalId;
  card.dataset.kind = approval.kind || "tool";
  const reason = document.createElement("p");
  reason.textContent = approval.reason || (approval.kind === "user_input"
    ? "Grok 需要你回答一个问题。"
    : "Grok 需要你批准一次操作。");
  if (approval.kind === "user_input" && Array.isArray(approval.options) && approval.options.length) {
    const actions = document.createElement("div");
    actions.className = "approval-actions";
    for (const option of approval.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option.name;
      button.addEventListener("click", () => void answerApproval(card, approval.approvalId, "approve_once", option.optionId));
      actions.append(button);
    }
    card.append(reason, actions);
  } else {
    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "danger";
    decline.textContent = "拒绝";
    decline.addEventListener("click", () => void answerApproval(card, approval.approvalId, "decline", null));
    const allow = document.createElement("button");
    allow.type = "button";
    allow.className = "primary";
    allow.textContent = "本次允许";
    allow.addEventListener("click", () => void answerApproval(card, approval.approvalId, "approve_once", null));
    card.append(reason, decline, allow);
  }
  elements.approvalList.append(card);
}

async function answerApproval(card, approvalId, decision, optionId) {
  const buttons = card.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await request("approval.answer", { approvalId, decision, optionId });
    removeApproval(approvalId);
    if (state.taskRunning) showThinking();
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    showNotice(errorMessage(error));
  }
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
  const hasText = Boolean(elements.messageInput.value.trim());
  const confirmLocked = state.composerLocksConfirms;
  elements.projectSelect.disabled = !connected || state.busy;
  elements.newSessionButton.disabled = !connected || !state.projectId || state.busy;
  elements.sessionSearchInput.disabled = !connected || !state.projectId || state.busy;
  elements.loadMoreSessionsButton.disabled = !connected || state.busy;
  for (const item of elements.sessionList.querySelectorAll(".session-item")) {
    for (const button of item.querySelectorAll("button")) {
      button.disabled = state.busy;
    }
  }
  elements.messageInput.disabled = !connected || !hasSession;
  elements.messageInput.placeholder = !hasSession
    ? "先选择或新建会话"
    : state.taskRunning
    ? "可以先写，当前回复结束后再发送"
    : state.busy
    ? "快捷操作执行中，可以继续写"
    : "在浏览器里写好，再发送给 Grok";
  elements.commandMenuButton.disabled = !connected || !hasSession || state.taskRunning || state.busy || hasText;
  elements.rewindShortcut.disabled = !connected || !hasSession || state.taskRunning || state.busy || confirmLocked;
  elements.rewindShortcut.title = confirmLocked ? "请先点开输入框再回退" : "";
  elements.sessionInfoShortcut.disabled = !connected || !hasSession || state.busy;
  elements.alwaysApproveShortcut.disabled = !connected || !hasSession || state.busy || confirmLocked;
  elements.alwaysApproveShortcut.setAttribute("aria-pressed", String(state.alwaysApprove));
  elements.alwaysApproveShortcut.title = confirmLocked
    ? "请先点开输入框再切换权限"
    : state.alwaysApprove
    ? "关闭 always-approve，恢复手动审批"
    : "为当前会话打开 always-approve";
  elements.taskButton.textContent = state.taskRunning ? "停止" : "发送";
  elements.taskButton.classList.toggle("primary", !state.taskRunning);
  elements.taskButton.classList.toggle("danger", state.taskRunning);
  elements.taskButton.disabled = state.taskRunning
    ? !connected || !hasSession
    : !connected || !hasSession || state.busy || !hasText;
}

function openSidebar() {
  if (isMobileNavigation()) {
    state.mobileSidebarOpen = true;
    elements.appView.dataset.mobileSidebarOpen = "true";
  } else {
    state.sidebarCollapsed = false;
    elements.appView.dataset.sidebarCollapsed = "false";
    stateSet(SIDEBAR_COLLAPSED_KEY, "0");
  }
  syncSidebarState();
}

function closeSidebar() {
  if (isMobileNavigation()) {
    closeMobileSidebar();
  } else {
    state.sidebarCollapsed = true;
    elements.appView.dataset.sidebarCollapsed = "true";
    stateSet(SIDEBAR_COLLAPSED_KEY, "1");
  }
  syncSidebarState();
}

function closeMobileSidebar() {
  state.mobileSidebarOpen = false;
  elements.appView.dataset.mobileSidebarOpen = "false";
  syncSidebarState();
}

function isMobileNavigation() {
  return window.matchMedia("(max-width: 800px)").matches;
}

function updateConversationTitle() {
  const privateTitle = isMobileNavigation() || state.sidebarCollapsed;
  elements.currentSessionTitle.textContent = privateTitle
    ? "Grok Remote"
    : state.sessionTitle || "Grok Remote";
  elements.collapseSidebarButton.textContent = isMobileNavigation() ? "关闭" : "收起";
}

function syncSidebarState() {
  const sidebarVisible = isMobileNavigation()
    ? state.mobileSidebarOpen
    : !state.sidebarCollapsed;
  elements.sessionSidebar.inert = !sidebarVisible;
  elements.sessionSidebar.setAttribute("aria-hidden", String(!sidebarVisible));
  elements.openSidebarButton.setAttribute("aria-expanded", String(sidebarVisible));
  updateConversationTitle();
}

window.addEventListener("resize", syncSidebarState);

function clearTimeline() {
  for (const stream of state.assistantStreams.values()) {
    if (stream.frame !== null) cancelAnimationFrame(stream.frame);
  }
  state.assistantStreams.clear();
  state.liveAssistant = null;
  state.commands.clear();
  state.slashMenu?.close();
  elements.historyLoader.hidden = true;
  hideThinking();
  elements.timeline.replaceChildren();
}

function showEmpty(text) {
  clearTimeline();
  elements.emptyState.querySelector("p").textContent = text;
  elements.emptyState.hidden = false;
  elements.timeline.append(elements.emptyState);
}

function hideEmpty() {
  if (elements.emptyState.parentElement) elements.emptyState.remove();
}

function showThinking(label = "正在思考") {
  hideEmpty();
  elements.thinkingLabel.textContent = label;
  elements.timeline.append(elements.thinkingIndicator);
  elements.thinkingIndicator.hidden = false;
  scrollToBottom(false);
}

function hideThinking() {
  elements.thinkingIndicator.hidden = true;
}

function resizeComposer() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, window.innerHeight * 0.34)}px`;
}

function isNearBottom() {
  const distance = elements.timeline.scrollHeight - elements.timeline.scrollTop - elements.timeline.clientHeight;
  return distance < 140;
}

function scrollToBottom(force) {
  if (force || isNearBottom()) {
    elements.timeline.scrollTop = elements.timeline.scrollHeight;
  }
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
  if (status === "in_progress" || status === "pending") return "运行中";
  return status || "完成";
}

function formatDate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(milliseconds));
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
