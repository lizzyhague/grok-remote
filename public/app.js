import { renderMarkdown, sanitizeHref } from "./markdown.js?v=13";

const TOKEN_KEY = "grok-remote-token";
const PROJECT_KEY = "grok-remote.project";
const SIDEBAR_COLLAPSED_KEY = "grok-remote.sidebar-collapsed";
const OUTBOX_KEY = "grok-remote.outbox-v1";
const ATTACHMENT_DRAFTS_KEY = "grok-remote.attachment-drafts-v1";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_ATTACHMENTS = 100;
const MAX_COMMAND_OUTPUT = 100_000;
const TOOL_TITLE_LIMIT = 48;
const WAITING_APPROVAL_NOTICE = "正在等待审批。";
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
  sessionViewBackButton: byId("session-view-back-button"),
  sessionViewTitle: byId("session-view-title"),
  selectSessionsButton: byId("select-sessions-button"),
  selectionHeading: byId("selection-heading"),
  cancelSelectionButton: byId("cancel-selection-button"),
  selectionCount: byId("selection-count"),
  selectAllSessionsButton: byId("select-all-sessions-button"),
  sessionList: byId("session-list"),
  loadMoreSessionsButton: byId("load-more-sessions-button"),
  sessionDestinations: byId("session-destinations"),
  archivedSessionsButton: byId("archived-sessions-button"),
  trashSessionsButton: byId("trash-sessions-button"),
  bulkSessionActions: byId("bulk-session-actions"),
  bulkPrimaryButton: byId("bulk-primary-button"),
  bulkTrashButton: byId("bulk-trash-button"),
  appAlertDialog: byId("app-alert-dialog"),
  appAlertTitle: byId("app-alert-title"),
  appAlertMessage: byId("app-alert-message"),
  collapseSidebarButton: byId("collapse-sidebar-button"),
  openSidebarButton: byId("open-sidebar-button"),
  sidebarBackdrop: byId("sidebar-backdrop"),
  currentSessionTitle: byId("current-session-title"),
  connectionStatus: byId("connection-status"),
  timeline: byId("timeline"),
  historyLoader: byId("history-loader"),
  loadOlderButton: byId("load-older-button"),
  emptyState: byId("empty-state"),
  thinkingIndicator: byId("thinking-indicator"),
  thinkingLabel: byId("thinking-label"),
  approvalList: byId("approval-list"),
  notice: byId("notice"),
  noticeText: byId("notice-text"),
  noticeActionButton: byId("notice-action-button"),
  composer: byId("composer"),
  attachmentInput: byId("attachment-input"),
  attachmentList: byId("attachment-list"),
  attachmentButton: byId("attachment-button"),
  messageInput: byId("message-input"),
  commandMenuButton: byId("command-menu-button"),
  rewindShortcut: byId("rewind-shortcut"),
  alwaysApproveShortcut: byId("always-approve-shortcut"),
  taskButton: byId("task-button"),
};

const state = {
  reconnectEnabled: true,
  connectAttempt: 0,
  socket: null,
  requestId: 0,
  pending: new Map(),
  reconnectTimer: null,
  projects: [],
  projectId: "",
  sessions: [],
  markedSessions: [],
  sessionCursor: null,
  sessionView: "active",
  sessionLoading: false,
  navigationBusy: false,
  sessionLoadGeneration: 0,
  selectionMode: false,
  selectedSessions: new Set(),
  noticeAction: null,
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
  pendingUserMessages: new Map(),
  pendingAttachments: [],
  attachmentUploads: new Map(),
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
elements.projectSelect.addEventListener("change", () => {
  state.projectId = elements.projectSelect.value;
  stateSet(PROJECT_KEY, state.projectId);
  hideNotice();
  resetCurrentSession();
  elements.sessionSearchInput.value = "";
  setSessionView("active", false);
  void loadSessions();
});
elements.newSessionButton.addEventListener("click", () => void startSession());
elements.sessionSearchInput.addEventListener("input", debounce(() => void loadSessions(), 250));
elements.loadMoreSessionsButton.addEventListener("click", () => void loadSessions({ append: true }));
elements.sessionViewBackButton.addEventListener("click", () => {
  setSessionView("active");
});
elements.archivedSessionsButton.addEventListener("click", () => {
  setSessionView("archived");
});
elements.trashSessionsButton.addEventListener("click", () => {
  setSessionView("trash");
});
elements.selectSessionsButton.addEventListener("click", () => {
  setSelectionMode(true);
});
elements.cancelSelectionButton.addEventListener("click", () => {
  setSelectionMode(false);
});
elements.selectAllSessionsButton.addEventListener("click", () => {
  toggleSelectAllSessions();
});
elements.bulkPrimaryButton.addEventListener("click", () => {
  void runBulkPrimaryAction();
});
elements.bulkTrashButton.addEventListener("click", () => {
  void runBulkDangerAction();
});
elements.noticeActionButton.addEventListener("click", () => {
  const action = state.noticeAction;
  hideNotice();
  if (action) void action();
});
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
elements.alwaysApproveShortcut.addEventListener("click", () => void toggleAlwaysApprove());
elements.attachmentButton.addEventListener("click", () => {
  elements.attachmentInput.click();
});
elements.attachmentInput.addEventListener("change", () => {
  const files = [...elements.attachmentInput.files];
  elements.attachmentInput.value = "";
  void uploadFiles(files);
});

elements.appView.dataset.sidebarCollapsed = String(state.sidebarCollapsed);
syncSidebarState();

markReady();
removeStored(TOKEN_KEY);
void connect();

function markReady() {
  window.grokRemoteReady = true;
  window.grokRemoteMarkReady?.();
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js");
  }
}

async function connect(token) {
  const attempt = ++state.connectAttempt;
  closeSocket();
  state.reconnectEnabled = true;
  try {
    const response = token
      ? await fetch("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        cache: "no-store",
      })
      : await fetch("/auth/session", { cache: "no-store" });
    if (attempt !== state.connectAttempt) return;
    elements.tokenInput.value = "";
    if (response.status === 401) {
      state.reconnectEnabled = false;
      showLogin();
      elements.loginStatus.textContent = token ? "访问令牌不正确。" : "请登录。";
      return;
    }
    if (!response.ok) throw new Error("登录服务暂时不可用。");
    const returnTo = new URLSearchParams(location.search).get("returnTo");
    if (returnTo?.startsWith("/view?")) {
      const target = new URL(returnTo, location.origin);
      if (target.origin === location.origin && target.pathname === "/view") {
        location.replace(target.href);
        return;
      }
    }
  } catch (error) {
    if (attempt !== state.connectAttempt) return;
    elements.loginStatus.textContent = errorMessage(error);
    setConnectionStatus("disconnected", "已断开，正在重连");
    scheduleReconnect();
    return;
  }
  setConnectionStatus("connecting", "正在连接");
  elements.loginStatus.textContent = "正在连接……";
  closeSocket();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener("open", () => {
    if (state.socket !== socket) return;
    void (async () => {
      // 会话是绑在连接上的（服务端 #requireSession），重连换了连接就等于没打开
      // 会话：发消息和申请上传票据都会被拒。所以这里要把断线前那个会话接回来。
      const previousSessionId = state.currentSessionId;
      try {
        showApp();
        setConnectionStatus("connected", "已连接");
        await loadProjects();
        await ensureSlashMenu();
        if (previousSessionId) await restoreSessionAfterReconnect(previousSessionId);
      } catch (error) {
        if (state.socket !== socket) return;
        closeSocket();
        setConnectionStatus("disconnected", "已断开，正在重连");
        elements.loginStatus.textContent = errorMessage(error);
        scheduleReconnect();
      }
    })();
  });
  socket.addEventListener("message", (event) => {
    if (state.socket === socket) handleSocketMessage(String(event.data));
  });
  socket.addEventListener("close", () => {
    if (state.socket !== socket) return;
    rejectPending(new Error("连接已断开。"));
    setConnectionStatus("disconnected", "已断开，正在重连");
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    if (state.socket !== socket) return;
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
    const error = new Error(message.error?.message || "请求失败。");
    error.code = message.error?.code;
    pending.reject(error);
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
      const error = new Error("请求超时。");
      error.code = "request_timeout";
      reject(error);
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
  const projectId = state.projectId;
  const view = state.sessionView;
  const generation = ++state.sessionLoadGeneration;
  state.sessionLoading = true;
  renderSessionList();
  try {
    const data = await request("sessions.list", {
      projectId,
      cursor: append ? state.sessionCursor : null,
      view,
      searchTerm: elements.sessionSearchInput.value.trim() || null,
    });
    if (generation !== state.sessionLoadGeneration || projectId !== state.projectId || view !== state.sessionView) {
      return;
    }
    const incoming = Array.isArray(data?.sessions) ? data.sessions : [];
    const marked = Array.isArray(data?.marked) ? data.marked : [];
    state.sessions = append ? mergeSessions(state.sessions, incoming) : incoming;
    state.markedSessions = view === "active" ? marked : [];
    state.sessionCursor = data?.nextCursor ?? null;
    keepOpenPendingSession();
  } catch (error) {
    if (generation === state.sessionLoadGeneration) showNotice(errorMessage(error));
  } finally {
    if (generation === state.sessionLoadGeneration) {
      state.sessionLoading = false;
      renderSessionList();
    }
  }
}

async function startSession() {
  if (!state.projectId) return;
  if (state.sessionView !== "active") setSessionView("active", false);
  setNavigationBusy(true);
  hideNotice();
  try {
    const opened = await request("session.start", { projectId: state.projectId });
    applyOpenedSession(opened);
    upsertSession(opened.session);
    renderSessionList();
    closeMobileSidebar();
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    setNavigationBusy(false);
    updateControls();
  }
}

async function resumeSession(sessionId) {
  const selected = findSessionSummary(sessionId);
  if (selected && !directoryAvailable(selected.projectId)) {
    showAlert("这个会话的工作目录已经不在了。", "无法打开会话");
    return;
  }
  if (selected?.projectId && selected.projectId !== state.projectId) {
    state.projectId = selected.projectId;
    stateSet(PROJECT_KEY, state.projectId);
    elements.projectSelect.value = state.projectId;
    await loadSessions();
  }
  const opened = await request("session.resume", {
    projectId: state.projectId,
    sessionId,
  });
  applyOpenedSession(opened);
  closeMobileSidebar();
}

/**
 * 重连后自动回到断线前的会话，不必再去列表里点一次。会话可能在断线期间被
 * 归档或删掉了，那就退回列表并说明原因，而不是把错误顶在界面上不动。
 */
async function restoreSessionAfterReconnect(sessionId) {
  try {
    const opened = await request("session.resume", {
      projectId: state.projectId,
      sessionId,
    });
    // 屏幕上已经铺着这个会话，就别再重铺一遍：clearTimeline() 加整段重建会让
    // 对话肉眼可见地翻一次。断线期间漏掉的用 events.resume 按 seq 补进来就够了，
    // 服务端的事件是落盘按 seq 读的，不是内存里的短缓冲。
    if (opened?.session?.id === state.currentSessionId) {
      applyResumedSessionInPlace(opened);
    } else {
      applyOpenedSession(opened);
    }
  } catch (error) {
    resetCurrentSession();
    showEmpty("选择以前的会话，或者新建一个会话。");
    showNotice(`${errorMessage(error)}断线前的会话没能接回来。`);
    return;
  }
  // 断线期间挑的附件在这里接着传完。
  await flushQueuedAttachments();
}

/**
 * 重连接回同一个会话时用的轻量版 applyOpenedSession：不动时间线、不动附件草稿，
 * 只把跟着连接走的那些状态接回来，再补上断线期间错过的事件。
 */
function applyResumedSessionInPlace(opened) {
  const missedAfterSeq = state.lastSeq;
  state.sessionTitle = opened.session?.title || state.sessionTitle;
  state.alwaysApprove = opened.alwaysApprove === true;
  state.taskRunning = Boolean(opened.activeTaskId);
  upsertSession(opened.session);
  updateConversationTitle();
  elements.approvalList.replaceChildren();
  for (const approval of opened.pendingApprovals ?? []) addApproval(approval);
  hideNotice();
  syncApprovalNotice();
  void request("events.resume", { afterSeq: missedAfterSeq })
    .then((data) => {
      for (const event of data?.events ?? []) handleServerEvent(event);
    })
    .catch((error) => showNotice(errorMessage(error)));
  updateControls();
  renderSessionList();
  void retryOutboxForCurrentSession();
}

async function reloadAfterRewind(sessionId, promptText) {
  try {
    const opened = await request("session.resume", {
      projectId: state.projectId,
      sessionId,
    });
    applyOpenedSession(opened);
    if (typeof promptText === "string" && promptText) {
      elements.messageInput.value = promptText;
      resizeComposer();
    }
    showNotice("已回退最近一轮；文件改动没有撤销。");
  } catch (error) {
    showNotice(errorMessage(error));
  }
}

function applyOpenedSession(opened) {
  state.currentSessionId = opened.session?.id ?? null;
  state.sessionTitle = opened.session?.title || "";
  state.lastSeq = opened.lastSeq ?? 0;
  state.alwaysApprove = opened.alwaysApprove === true;
  state.taskRunning = Boolean(opened.activeTaskId);
  loadAttachmentDraftForCurrentSession();
  upsertSession(opened.session);
  updateConversationTitle();
  renderHistory(Array.isArray(opened.tasks) ? opened.tasks : [], opened.hasOlder === true);
  elements.approvalList.replaceChildren();
  for (const approval of opened.pendingApprovals ?? []) addApproval(approval);
  hideNotice();
  syncApprovalNotice();
  const resumeAfterSeq = opened.resumeAfterSeq ?? 0;
  if (resumeAfterSeq < state.lastSeq || state.taskRunning) {
    void request("events.resume", { afterSeq: resumeAfterSeq }).then((data) => {
      for (const event of data?.events ?? []) handleServerEvent(event);
    }).catch((error) => showNotice(errorMessage(error)));
  }
  updateControls();
  renderSessionList();
  void retryOutboxForCurrentSession();
}

function setSessionView(view, load = true) {
  state.sessionView = view;
  state.sessions = [];
  state.markedSessions = [];
  state.sessionCursor = null;
  setSelectionMode(false, false);
  elements.sessionViewTitle.textContent = view === "active"
    ? "最近会话"
    : view === "archived"
    ? "已归档"
    : "回收站";
  elements.sessionViewBackButton.hidden = view === "active";
  elements.archivedSessionsButton.dataset.active = String(view === "archived");
  elements.trashSessionsButton.dataset.active = String(view === "trash");
  renderSessionList();
  if (load) void loadSessions();
}

function setSelectionMode(enabled, render = true) {
  state.selectionMode = enabled;
  state.selectedSessions.clear();
  elements.sessionViewTitle.parentElement.hidden = enabled;
  elements.selectionHeading.hidden = !enabled;
  elements.sessionDestinations.hidden = enabled;
  elements.bulkSessionActions.hidden = !enabled;
  if (render) renderSessionList();
  updateSelectionControls();
}

function setNavigationBusy(busy) {
  state.navigationBusy = busy;
  updateControls();
}

function renderSessionList() {
  elements.sessionList.replaceChildren();
  const marked = state.sessionView === "active" ? state.markedSessions : [];
  if (marked.length > 0) {
    const group = document.createElement("div");
    group.className = "session-mark-group";
    for (const session of marked) group.append(createSessionItem(session));
    const divider = document.createElement("hr");
    divider.className = "session-mark-divider";
    elements.sessionList.append(group, divider);
  }
  const listEmpty = state.sessions.length === 0 && marked.length === 0;
  if (state.sessionLoading && listEmpty) {
    const loading = document.createElement("p");
    loading.className = "session-list-empty";
    loading.textContent = "正在加载会话……";
    elements.sessionList.append(loading);
  } else if (state.sessions.length === 0) {
    if (marked.length === 0) {
      const empty = document.createElement("p");
      empty.className = "session-list-empty";
      const searching = Boolean(elements.sessionSearchInput.value.trim());
      empty.textContent = searching
        ? "没有找到匹配的会话。"
        : state.sessionView === "active"
        ? "这个项目还没有会话。"
        : state.sessionView === "archived"
        ? "还没有归档会话。"
        : "回收站是空的。";
      elements.sessionList.append(empty);
    }
  } else {
    for (const session of state.sessions) {
      elements.sessionList.append(createSessionItem(session));
    }
  }
  elements.loadMoreSessionsButton.hidden = !state.sessionCursor;
  updateSelectionControls();
  updateControls();
}

function createSessionItem(session) {
  const item = document.createElement("article");
  item.className = "session-item";
  item.dataset.current = String(session.id === state.currentSessionId);
  item.dataset.state = session.state || "not_loaded";
  item.setAttribute("role", "listitem");

  if (state.selectionMode) {
    const label = document.createElement("label");
    label.className = "session-select-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedSessions.has(session.id);
    checkbox.disabled = session.state === "active" || session.pending === true;
    checkbox.setAttribute("aria-label", `选择 ${session.title || "新会话"}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked && state.selectedSessions.size >= 100) {
        checkbox.checked = false;
        showNotice("一次最多整理 100 个会话。");
      } else if (checkbox.checked) {
        state.selectedSessions.add(session.id);
      } else {
        state.selectedSessions.delete(session.id);
      }
      updateSelectionControls();
    });
    const text = document.createElement("span");
    appendSessionText(text, session);
    label.append(checkbox, text);
    item.append(label);
    return item;
  }

  const open = document.createElement("button");
  open.className = "session-open";
  open.type = "button";
  open.disabled = state.sessionView !== "active";
  appendSessionText(open, session);
  if (state.sessionView === "active") {
    open.addEventListener("click", () => {
      if (session.id === state.currentSessionId) closeMobileSidebar();
      else void resumeSession(session.id);
    });
  }
  item.append(open);
  if (session.pending !== true) item.append(createSessionMark(session));
  return item;
}

function appendSessionText(container, session) {
  const title = document.createElement("span");
  title.className = "session-item-title";
  title.textContent = session.title || "新会话";
  const preview = document.createElement("span");
  preview.className = "session-item-preview";
  preview.textContent = session.projectName ||
    state.projects.find((project) => project.id === session.projectId)?.name ||
    "";
  const meta = document.createElement("span");
  meta.className = "session-item-meta";
  if (state.sessionView === "trash") {
    meta.dataset.warning = "true";
    meta.textContent = trashRemainingText(session.purgeAt);
  } else {
    const date = formatDate(session.updatedAt || session.createdAt);
    meta.textContent = session.state === "active"
      ? `运行中${date ? ` · ${date}` : ""}`
      : date;
  }
  container.append(title, preview, meta);
}

function createSessionMark(session) {
  const button = document.createElement("button");
  button.className = "session-mark-trigger quiet";
  button.type = "button";
  button.setAttribute("aria-pressed", String(Boolean(session.marked)));
  button.setAttribute(
    "aria-label",
    session.marked
      ? `取消钉住 ${session.title || "新会话"}`
      : `钉住 ${session.title || "新会话"}`,
  );
  button.title = session.marked ? "取消钉住" : "钉住后会一直显示在最近会话顶部";
  button.append(sessionMarkIcon(Boolean(session.marked)));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void toggleSessionMark(session);
  });
  return button;
}

function sessionMarkIcon(pinned) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("session-mark-icon");
  /*
   * 图钉的形状取自 pocket-ai 里标记「已留材料」的那个 📌。画成 SVG 才能跟着
   * currentColor 走、拿到每个项目自己的主色——emoji 那身红是系统字体给的，改不掉。
   *
   * 两个状态换的是两副钉身，不是把同一副转个角度：
   *   没钉住 = 斜着、空心描边（--muted），像还捏在手里；
   *   钉住   = 正立、钉身填实（--accent），像已经扎正扎进去了。
   * 旋转正是上一版的毛病：转完钉头会跑到 viewBox 外面被切掉，而且每条边都变成
   * 斜切，小尺寸下发糊。两副横平竖直的路径才锐利。
   *
   * viewBox 用 24：路径按 Tabler 的 24 网格画，硬换算到 16 只会得到一串读不动
   * 的小数。渲染尺寸由 CSS 定在 17px，两者不冲突。
   */
  const LOOSE = {
    body: "M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5-1.5l1.5-4l4-4",
    needle: "M9 15l-4.5 4.5",
    cap: "M14.5 4l5.5 5.5",
  };
  const DRIVEN = {
    body: "M9 4v6l-2 4v2h10v-2l-2-4v-6z",
    needle: "M12 16l0 5",
    cap: "M8 4l8 0",
  };
  const shape = pinned ? DRIVEN : LOOSE;
  const body = document.createElementNS("http://www.w3.org/2000/svg", "path");
  body.setAttribute("d", shape.body);
  if (pinned) body.setAttribute("fill", "currentColor");
  const needle = document.createElementNS("http://www.w3.org/2000/svg", "path");
  needle.setAttribute("d", shape.needle);
  const cap = document.createElementNS("http://www.w3.org/2000/svg", "path");
  cap.setAttribute("d", shape.cap);
  svg.append(body, needle, cap);
  return svg;
}

async function toggleSessionMark(session) {
  const projectId = session.projectId || state.projectId;
  if (!projectId) return;
  try {
    const data = await request("session.mark", {
      projectId,
      sessionId: session.id,
      marked: !session.marked,
    });
    if (data?.session) upsertSession(data.session);
    renderSessionList();
  } catch (error) {
    showNotice(errorMessage(error));
  }
}

function findSessionSummary(sessionId) {
  return state.markedSessions.find((session) => session.id === sessionId) ??
    state.sessions.find((session) => session.id === sessionId) ??
    null;
}

function directoryAvailable(projectId) {
  return Boolean(projectId) && state.projects.some((project) => project.id === projectId);
}

function showAlert(message, title = "提示") {
  elements.appAlertTitle.textContent = title;
  elements.appAlertMessage.textContent = message;
  if (!elements.appAlertDialog.open) elements.appAlertDialog.showModal();
}

function visibleSessionSummaries() {
  const seen = new Set();
  const items = [];
  if (state.sessionView === "active") {
    for (const session of state.markedSessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      items.push(session);
    }
  }
  for (const session of state.sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    items.push(session);
  }
  return items;
}

function selectableSessions() {
  return visibleSessionSummaries().filter((session) => session.state !== "active" && session.pending !== true);
}

function toggleSelectAllSessions() {
  const ids = selectableSessions().map((session) => session.id);
  const capped = ids.slice(0, 100);
  const allSelected = capped.length > 0 && capped.every((id) => state.selectedSessions.has(id));
  if (allSelected) {
    state.selectedSessions.clear();
  } else {
    state.selectedSessions = new Set(capped);
    if (ids.length > 100) showNotice("一次最多整理 100 个会话。");
  }
  renderSessionList();
}

function updateSelectionControls() {
  const count = state.selectedSessions.size;
  const cappedIds = selectableSessions().map((session) => session.id).slice(0, 100);
  const allSelected = cappedIds.length > 0 &&
    cappedIds.every((id) => state.selectedSessions.has(id));
  elements.selectionCount.textContent = `已选择 ${count} 项`;
  elements.selectAllSessionsButton.textContent = allSelected ? "取消全选" : "全选";
  elements.bulkPrimaryButton.disabled = count === 0 || state.sessionLoading;
  elements.bulkTrashButton.disabled = count === 0 || state.sessionLoading;
  elements.bulkPrimaryButton.textContent = state.sessionView === "active" ? "归档" : "恢复";
  elements.bulkTrashButton.textContent = state.sessionView === "trash" ? "永久删除" : "删除";
  delete elements.bulkSessionActions.dataset.single;
}

async function runBulkPrimaryAction() {
  const action = state.sessionView === "active"
    ? "archive"
    : state.sessionView === "archived"
    ? "unarchive"
    : "restore-trash";
  await mutateSessions(action, [...state.selectedSessions]);
}

async function runBulkDangerAction() {
  const sessionIds = [...state.selectedSessions];
  if (sessionIds.length === 0) return;
  if (state.sessionView === "trash") {
    const selected = visibleSessionSummaries().filter((session) => state.selectedSessions.has(session.id));
    if (!window.confirm(
      selected.length === 1
        ? `立刻永久删除「${selected[0].title || "新会话"}」。这一步无法撤销，会话原文会一并删除。继续吗？`
        : `立刻永久删除 ${selected.length} 个会话。这一步无法撤销，会话原文会一并删除。继续吗？`,
    )) return;
    await mutateSessions("delete-trash", sessionIds);
    return;
  }
  if (sessionIds.length > 1 && !window.confirm(
    `删除 ${sessionIds.length} 个会话。30 天内可以在回收站里还原，到期后自动永久删除。继续吗？`,
  )) return;
  const action = state.sessionView === "archived" ? "trash-archived" : "trash-active";
  await mutateSessions(action, sessionIds);
}

async function mutateSessions(action, sessionIds) {
  if (!state.projectId || sessionIds.length === 0) return;
  const projectId = state.projectId;
  setNavigationBusy(true);
  hideNotice();
  try {
    const result = await request("sessions.mutate", { projectId, sessionIds, action });
    const succeeded = Array.isArray(result?.succeeded) ? result.succeeded : [];
    const failed = Array.isArray(result?.failed) ? result.failed : [];
    if (
      state.currentSessionId && succeeded.includes(state.currentSessionId) &&
      (action === "archive" || action.startsWith("trash-") || action === "delete-trash")
    ) {
      resetCurrentSession();
      showEmpty("选择以前的会话，或者新建一个会话。");
    }
    setSelectionMode(false, false);
    await loadSessions();

    if (succeeded.length > 0) {
      const undoAction = action === "archive"
        ? "unarchive"
        : action.startsWith("trash-")
        ? "restore-trash"
        : null;
      const label = action === "archive"
        ? `已归档 ${succeeded.length} 个会话。`
        : action.startsWith("trash-")
        ? `已删除 ${succeeded.length} 个会话，30 天后自动永久删除。`
        : action === "delete-trash"
        ? `已永久删除 ${succeeded.length} 个会话。`
        : `已恢复 ${succeeded.length} 个会话。`;
      const failureNote = failed.length > 0
        ? ` 另有 ${failed.length} 个未能处理：${failed[0]?.message || "操作失败。"}`
        : "";
      if (undoAction) {
        showActionNotice(`${label}${failureNote}`, "撤销", () =>
          mutateSessions(undoAction, succeeded));
      } else {
        showNotice(`${label}${failureNote}`);
      }
    } else if (failed.length > 0) {
      const first = failed[0]?.message || "操作失败。";
      showNotice(`${failed.length} 个会话未能处理：${first}`);
    }
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    setNavigationBusy(false);
    updateControls();
  }
}

function mergeSessions(existing, incoming) {
  const merged = [...existing];
  const seen = new Set(existing.map((session) => session.id));
  for (const session of incoming) {
    if (!seen.has(session.id)) {
      seen.add(session.id);
      merged.push(session);
    }
  }
  return merged;
}

function upsertSession(session) {
  if (!session?.id || state.sessionView !== "active") return;
  const markedIndex = state.markedSessions.findIndex((candidate) => candidate.id === session.id);
  const listIndex = state.sessions.findIndex((candidate) => candidate.id === session.id);
  if (session.marked) {
    if (listIndex >= 0) state.sessions.splice(listIndex, 1);
    if (markedIndex >= 0) {
      state.markedSessions[markedIndex] = { ...state.markedSessions[markedIndex], ...session };
    } else {
      state.markedSessions.unshift(session);
    }
    state.markedSessions.sort((left, right) =>
      (right.updatedAt || 0) - (left.updatedAt || 0) || String(right.id).localeCompare(String(left.id))
    );
    return;
  }
  if (markedIndex >= 0) state.markedSessions.splice(markedIndex, 1);
  if (session.projectId && session.projectId !== state.projectId && session.pending !== true) return;
  if (listIndex >= 0) state.sessions[listIndex] = { ...state.sessions[listIndex], ...session };
  else state.sessions.unshift(session);
}

function keepOpenPendingSession() {
  if (state.sessionView !== "active") return;
  if (!state.currentSessionId || !String(state.currentSessionId).startsWith("pending-")) return;
  if (state.sessions.some((session) => session.id === state.currentSessionId)) return;
  upsertSession({
    id: state.currentSessionId,
    title: state.sessionTitle || "新会话",
    preview: "",
    createdAt: Math.floor(Date.now() / 1_000),
    updatedAt: Math.floor(Date.now() / 1_000),
    state: "idle",
    pending: true,
    projectId: state.projectId,
    projectName: state.projects.find((project) => project.id === state.projectId)?.name || "",
    marked: false,
  });
}

function trashRemainingText(purgeAt) {
  if (typeof purgeAt !== "number" || !Number.isFinite(purgeAt)) return "30 天后自动删除";
  const remaining = purgeAt - Date.now() / 1_000;
  if (remaining <= 0) return "即将自动删除";
  const days = Math.max(1, Math.ceil(remaining / 86_400));
  return `${days} 天后自动删除`;
}

function resetCurrentSession() {
  abortAttachmentUploads();
  state.currentSessionId = null;
  state.sessionTitle = "";
  state.lastSeq = 0;
  state.taskRunning = false;
  state.alwaysApprove = false;
  state.pendingAttachments = [];
  renderAttachmentList();
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
  const attachments = readyAttachments();
  if ((!text && attachments.length === 0) || !state.currentSessionId ||
    hasUnfinishedUploads()) return;
  if (attachments.length === 0 && await state.slashMenu?.submit(text)) {
    updateControls();
    return;
  }
  await sendMessage(text, attachments);
}

async function sendMessage(text, attachments) {
  const clientMessageId = createClientMessageId();
  const displayText = displayTextWithAttachments(text, attachments);
  const pendingMessage = addMessage("user", displayText, `pending-${clientMessageId}`, false);
  state.pendingUserMessages.set(clientMessageId, { element: pendingMessage, text: displayText });
  elements.messageInput.value = "";
  setPendingAttachments(state.pendingAttachments.filter((attachment) => attachment.status !== "ready"));
  resizeComposer();
  state.taskRunning = true;
  updateControls();
  showThinking();
  saveOutbox({
    clientMessageId,
    projectId: state.projectId,
    sessionId: state.currentSessionId,
    text,
    attachmentIds: attachments.map((attachment) => attachment.id),
  });
  try {
    const result = await request("message.send", {
      text,
      clientMessageId,
      attachmentIds: attachments.map((attachment) => attachment.id),
    });
    clearOutbox(clientMessageId);
    if (result?.sessionId && result.sessionId !== state.currentSessionId) {
      migrateLocalSessionState(state.currentSessionId, result.sessionId);
      state.currentSessionId = result.sessionId;
    }
  } catch (error) {
    const uncertainDelivery = error?.code === "request_timeout" ||
      state.socket?.readyState !== WebSocket.OPEN;
    if (uncertainDelivery) {
      showNotice("连接在确认消息前中断。消息 ID 已保留；重新打开这个会话后会安全重试。");
      return;
    }
    clearOutbox(clientMessageId);
    const unconfirmedMessage = state.pendingUserMessages.get(clientMessageId);
    if (unconfirmedMessage) {
      unconfirmedMessage.element.remove();
      state.pendingUserMessages.delete(clientMessageId);
    }
    state.taskRunning = false;
    hideThinking();
    setPendingAttachments(mergeAttachments(attachments, state.pendingAttachments));
    const currentDraft = elements.messageInput.value;
    elements.messageInput.value = currentDraft.trim() ? `${text}\n\n${currentDraft}` : text;
    resizeComposer();
    state.slashMenu?.handleInput();
    showNotice(`${errorMessage(error)}未发送的正文和附件已恢复。`);
  }
  updateControls();
}

/*
 * 挑文件不看连接通不通：手机弹出系统选择器时网页会被切到后台，回来时连接往往
 * 已经断了、还在重连。这里要是拦一下，刚选的图就被无声丢掉了——连没连上交给
 * startUpload() 去分流，断着就先排队。
 */
async function uploadFiles(files) {
  if (!state.currentSessionId || !state.projectId || files.length === 0) return;
  const available = MAX_MESSAGE_ATTACHMENTS - state.pendingAttachments.length;
  if (available <= 0) {
    showNotice(`一条消息最多附加 ${MAX_MESSAGE_ATTACHMENTS} 个文件。`);
    return;
  }
  if (files.length > available) {
    showNotice(`一条消息最多附加 ${MAX_MESSAGE_ATTACHMENTS} 个文件，只处理了前 ${available} 个。`);
  }
  await Promise.all(files.slice(0, available).map((file) => uploadFile(file)));
}

async function uploadFile(file) {
  const draft = {
    clientId: createClientMessageId(),
    originalName: file.name || "未命名文件",
    size: file.size,
    declaredMime: file.type || "application/octet-stream",
    status: "requesting",
    statusText: "正在申请上传",
    // 排队和重试都要拿它再传一次，所以文件本身留在草稿上。
    file,
    projectId: state.projectId,
    sessionId: state.currentSessionId,
  };
  state.pendingAttachments.push(draft);
  renderAttachmentList();
  updateControls();
  await startUpload(draft);
}

/**
 * 一个草稿的上传全过程，可以重复进入：断线时排队，重连接回会话后由
 * flushQueuedAttachments() 再叫一次；失败后也可以由「重试」再叫一次。
 */
async function startUpload(draft) {
  if (!draft.file) return;
  if (state.socket?.readyState !== WebSocket.OPEN) {
    Object.assign(draft, { status: "queued", statusText: "等待重新连接" });
    renderAttachmentList();
    updateControls();
    return;
  }
  // 排队期间会话可能已经换了。附件是绑在会话上的，不能改投到新会话去。
  if (draft.projectId !== state.projectId || draft.sessionId !== state.currentSessionId) {
    Object.assign(draft, {
      status: "failed",
      statusText: "会话已切换，请重新选择文件",
      file: null,
    });
    renderAttachmentList();
    updateControls();
    return;
  }

  const { clientId, file } = draft;
  const controller = new AbortController();
  state.attachmentUploads.set(clientId, controller);
  Object.assign(draft, { status: "requesting", statusText: "正在申请上传" });
  renderAttachmentList();
  updateControls();
  try {
    const ticket = await request("attachment.ticket.create", {
      originalName: draft.originalName,
      declaredMime: draft.declaredMime,
      expectedSize: file.size,
    });
    if (state.projectId !== draft.projectId || state.currentSessionId !== draft.sessionId) {
      throw new Error("上传期间切换了会话，请重新选择文件。");
    }
    Object.assign(draft, { status: "uploading", statusText: "正在上传" });
    renderAttachmentList();
    const response = await fetch("/attachments/upload", {
      method: "POST",
      headers: { "x-upload-ticket": ticket.ticket },
      body: file,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.error?.message || "附件上传失败。");
      error.code = body?.error?.code;
      throw error;
    }
    if (!body?.attachment?.id) throw new Error("上传服务没有返回附件 ID。");
    Object.assign(draft, body.attachment, {
      clientId,
      status: "ready",
      statusText: "上传完成",
      file: null,
    });
    persistCurrentAttachmentDraft();
  } catch (error) {
    // 断线导致的失败不算失败，回到队列里等下一次接回会话。
    if (state.socket?.readyState !== WebSocket.OPEN && error?.name !== "AbortError") {
      Object.assign(draft, { status: "queued", statusText: "等待重新连接" });
    } else {
      Object.assign(draft, {
        status: "failed",
        statusText: error?.name === "AbortError" ? "已取消" : errorMessage(error),
      });
    }
  } finally {
    state.attachmentUploads.delete(clientId);
    renderAttachmentList();
    updateControls();
  }
}

/** 接回会话后，把排队的附件接着传完。 */
async function flushQueuedAttachments() {
  const queued = state.pendingAttachments.filter((draft) => draft.status === "queued");
  if (queued.length === 0) return;
  await Promise.all(queued.map((draft) => startUpload(draft)));
}

/** 还没传完的附件（排队中或正在传）。有这些就先别发送，否则它们会被落下。 */
function hasUnfinishedUploads() {
  return state.attachmentUploads.size > 0 ||
    state.pendingAttachments.some((draft) => draft.status === "queued");
}

function renderAttachmentList() {
  elements.attachmentList.replaceChildren();
  elements.attachmentList.hidden = state.pendingAttachments.length === 0;
  for (const attachment of state.pendingAttachments) {
    const item = document.createElement("div");
    item.className = "attachment-item";
    item.dataset.status = attachment.status;
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = attachment.originalName || "未命名文件";
    const meta = document.createElement("small");
    meta.className = "attachment-meta";
    meta.textContent = attachment.status === "ready"
      ? `${attachment.id} · 上传完成`
      : attachment.statusText || "处理中";
    const actions = document.createElement("div");
    actions.className = "attachment-actions";
    // 传失败但文件还在手上的，给一次重来的机会；不想要就用旁边的「移除」。
    if (attachment.status === "failed" && attachment.file) {
      const retry = document.createElement("button");
      retry.className = "quiet attachment-retry";
      retry.type = "button";
      retry.textContent = "重试";
      retry.setAttribute("aria-label", `重新上传附件 ${attachment.originalName || "未命名文件"}`);
      retry.addEventListener("click", () => void startUpload(attachment));
      actions.append(retry);
    }
    const remove = document.createElement("button");
    remove.className = "quiet attachment-remove";
    remove.type = "button";
    remove.textContent = "移除";
    remove.setAttribute("aria-label", `移除附件 ${attachment.originalName || "未命名文件"}`);
    remove.addEventListener("click", () => removeAttachment(attachment));
    actions.append(remove);
    item.append(name, meta, actions);
    elements.attachmentList.append(item);
  }
}

function removeAttachment(attachment) {
  state.attachmentUploads.get(attachment.clientId)?.abort();
  state.attachmentUploads.delete(attachment.clientId);
  setPendingAttachments(state.pendingAttachments.filter((candidate) => candidate !== attachment));
}

function abortAttachmentUploads() {
  for (const controller of state.attachmentUploads.values()) controller.abort();
  state.attachmentUploads.clear();
}

function readyAttachments() {
  return state.pendingAttachments.filter((attachment) =>
    attachment.status === "ready" && typeof attachment.id === "string");
}

function setPendingAttachments(attachments) {
  state.pendingAttachments = attachments;
  persistCurrentAttachmentDraft();
  renderAttachmentList();
  updateControls();
}

function mergeAttachments(first, second) {
  const merged = [];
  const seen = new Set();
  for (const attachment of [...first, ...second]) {
    const key = attachment.id || attachment.clientId;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(attachment);
  }
  return merged;
}

function displayTextWithAttachments(text, attachments) {
  if (attachments.length === 0) return text;
  const lines = attachments.map((attachment) =>
    `[附件：${attachment.originalName} · ${attachment.id}]`);
  return text ? `${text}\n\n${lines.join("\n")}` : lines.join("\n");
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
      if (event.sessionId) {
        migrateLocalSessionState(event.pendingId || state.currentSessionId, event.sessionId);
        state.currentSessionId = event.sessionId;
      }
      void loadSessions();
      break;
    case "session.changed":
      void loadSessions();
      if (
        event.sessionIds?.includes(state.currentSessionId) &&
        (event.change === "delete" || event.change === "archive" || event.change === "trash")
      ) {
        resetCurrentSession();
      }
      break;
    case "session.title":
      if (event.title) {
        state.sessionTitle = event.title;
        updateConversationTitle();
        const found = findSessionSummary(state.currentSessionId);
        if (found) found.title = event.title;
        renderSessionList();
      }
      break;
    case "session.rewound":
      state.taskRunning = false;
      hideThinking();
      if (state.currentSessionId) {
        void reloadAfterRewind(state.currentSessionId, event.promptText);
      }
      break;
    case "message.user":
      hideThinking();
      hideEmpty();
      let pendingClientMessageId = typeof event.clientMessageId === "string"
        ? event.clientMessageId
        : null;
      let pendingUserMessage = pendingClientMessageId
        ? state.pendingUserMessages.get(pendingClientMessageId)
        : null;
      if (!pendingUserMessage && !pendingClientMessageId && state.pendingUserMessages.size === 1) {
        const [fallbackClientMessageId, fallbackMessage] = state.pendingUserMessages.entries().next().value;
        if (fallbackMessage.text === (event.text ?? "")) {
          pendingClientMessageId = fallbackClientMessageId;
          pendingUserMessage = fallbackMessage;
        }
      }
      if (pendingUserMessage) {
        pendingUserMessage.element.dataset.itemId = event.itemId ?? "";
        state.pendingUserMessages.delete(pendingClientMessageId);
      } else {
        addMessage("user", event.text ?? "", event.itemId, false);
      }
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
      syncApprovalNotice();
      break;
    case "approval.resolved":
      removeApproval(event.approvalId);
      syncApprovalNotice();
      if (state.taskRunning) showThinking();
      break;
    case "turn.status":
      if (event.status === "running") {
        state.taskRunning = true;
        syncApprovalNotice();
        showThinking();
      }
      if (event.status === "waiting_for_permission") {
        hideThinking();
        showNotice(WAITING_APPROVAL_NOTICE);
      }
      if (event.status === "completed" || event.status === "interrupted" || event.status === "failed") {
        state.taskRunning = false;
        hideThinking();
        syncApprovalNotice();
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
  const kind = normalizeToolKind(event.kind);
  if (kind === "think") {
    state.commands.set(itemId, { mode: "hidden", kind });
    return;
  }
  if (isInlineToolKind(kind)) {
    const element = document.createElement("p");
    element.className = "tool-inline";
    element.dataset.itemId = itemId;
    appendToTimeline(element);
    const command = {
      mode: "inline",
      element,
      kind,
      title: event.title || kind,
      status: event.status || "in_progress",
    };
    state.commands.set(itemId, command);
    renderToolEntry(command);
    scrollToBottom(false);
    return;
  }
  const details = document.createElement("details");
  details.className = "command";
  details.dataset.itemId = itemId;
  details.dataset.kind = kind;
  const summary = document.createElement("summary");
  const pane = document.createElement("div");
  pane.className = "command-pane";
  details.append(summary, pane);
  appendToTimeline(details);
  const command = {
    mode: "card",
    details,
    summary,
    pane,
    kind,
    title: event.title || kind,
    status: event.status || "in_progress",
    input: typeof event.input === "string" ? event.input : "",
    query: typeof event.query === "string" ? event.query : "",
    resources: publicResources(event.resources),
    output: "",
    truncated: false,
  };
  state.commands.set(itemId, command);
  renderToolEntry(command);
  scrollToBottom(false);
}

function appendCommandOutput(itemId, delta) {
  const command = state.commands.get(itemId);
  if (!command || command.mode !== "card") return;
  command.output += delta;
  if (command.output.length > MAX_COMMAND_OUTPUT) {
    command.output = command.output.slice(-MAX_COMMAND_OUTPUT);
    command.truncated = true;
  }
  if (command.outputElement) command.outputElement.textContent = toolOutputText(command);
}

function completeCommand(event) {
  const itemId = event.id ?? event.itemId;
  if (!state.commands.has(itemId)) {
    startCommand({
      itemId,
      title: event.title,
      kind: event.kind,
      status: event.status,
      input: event.input,
      query: event.query,
      resources: event.resources,
    });
  }
  let command = state.commands.get(itemId);
  if (!command) return;
  const nextKind = normalizeToolKind(event.kind || command.kind);
  if (command.mode !== toolDisplayMode(nextKind)) {
    command = replaceToolEntry(itemId, command, nextKind, event);
    if (!command) return;
  }
  if (event.title) command.title = event.title;
  command.kind = nextKind;
  if (typeof event.input === "string" && event.input) command.input = event.input;
  if (typeof event.query === "string" && event.query) command.query = event.query;
  if (Array.isArray(event.resources)) command.resources = publicResources(event.resources);
  if (event.status) command.status = event.status;
  if (command.mode === "card" && typeof event.output === "string" && (event.output || !command.output)) {
    command.output = event.output.length > MAX_COMMAND_OUTPUT
      ? event.output.slice(-MAX_COMMAND_OUTPUT)
      : event.output;
    command.truncated = event.outputTruncated === true || event.output.length > MAX_COMMAND_OUTPUT;
  }
  renderToolEntry(command);
}

function replaceToolEntry(itemId, command, kind, event) {
  const previousNode = command.details || command.element || null;
  const marker = previousNode?.isConnected ? document.createComment("tool position") : null;
  if (marker) previousNode.replaceWith(marker);
  else previousNode?.remove();

  state.commands.delete(itemId);
  startCommand({
    itemId,
    kind,
    title: event.title || command.title || kind,
    status: event.status || command.status,
    input: typeof event.input === "string" ? event.input : command.input,
    query: typeof event.query === "string" ? event.query : command.query,
    resources: Array.isArray(event.resources) ? event.resources : command.resources,
  });

  const replacement = state.commands.get(itemId);
  const replacementNode = replacement?.details || replacement?.element || null;
  if (marker) {
    if (replacementNode) marker.replaceWith(replacementNode);
    else marker.remove();
  }
  if (replacement?.mode === "card" && command.mode === "card") {
    replacement.output = command.output;
    replacement.truncated = command.truncated;
  }
  return replacement;
}

function renderToolEntry(command) {
  if (command.mode === "hidden") return;
  const status = commandStatus(command.status);
  const title = clipTitle(command.title);
  if (command.mode === "inline") {
    command.element.textContent = `${command.kind} · ${title} · ${status}`;
    return;
  }
  command.details.dataset.kind = command.kind;
  command.summary.textContent = `${command.kind} · ${title} · ${status}`;
  command.pane.replaceChildren();
  command.outputElement = null;
  if (command.kind === "search") {
    appendToolTextBlock(
      command.pane,
      "关键词",
      command.query || (isRunningTool(command) ? "等待关键词……" : "没有可用的关键词。"),
      "command-input",
    );
    appendResourceBlock(command, "结果", "没有可用的结果地址。");
    return;
  }
  if (command.kind === "fetch") {
    appendResourceBlock(command, "地址", "没有可用的资源地址。");
    return;
  }
  appendToolTextBlock(command.pane, "输入", command.input || "没有输入。", "command-input");
  command.outputElement = appendToolTextBlock(
    command.pane,
    "输出",
    toolOutputText(command),
    "command-output",
  );
}

function appendToolTextBlock(pane, label, text, className) {
  const block = document.createElement("div");
  block.className = "command-block";
  const kicker = document.createElement("div");
  kicker.className = "command-kicker";
  kicker.textContent = label;
  const content = document.createElement("pre");
  content.className = className;
  content.textContent = text;
  block.append(kicker, content);
  pane.append(block);
  return content;
}

function appendResourceBlock(command, label, emptyText) {
  const block = document.createElement("div");
  block.className = "command-block";
  const kicker = document.createElement("div");
  kicker.className = "command-kicker";
  kicker.textContent = label;
  block.append(kicker);
  if (!command.resources.length) {
    const empty = document.createElement("p");
    empty.className = "command-resource-empty";
    empty.textContent = isRunningTool(command) ? "等待地址……" : emptyText;
    block.append(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "command-resources";
    for (const resource of command.resources) {
      const item = document.createElement("li");
      const text = resource.label ? `${resource.label} — ${resource.address}` : resource.address;
      const href = sanitizeHref(resource.address);
      if (href && /^https?:\/\//i.test(href)) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = text;
        item.append(link);
      } else {
        item.textContent = text;
      }
      list.append(item);
    }
    block.append(list);
  }
  command.pane.append(block);
}

function publicResources(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const resources = [];
  for (const item of value) {
    if (!item || typeof item.address !== "string") continue;
    const address = item.address.trim();
    if (!address || address.length > 2_048 || /[\u0000-\u001f\u007f]/.test(address) || seen.has(address)) {
      continue;
    }
    seen.add(address);
    resources.push({
      address,
      label: typeof item.label === "string"
        ? item.label.replace(/\s+/g, " ").trim().slice(0, 256)
        : "",
    });
  }
  return resources;
}

function isRunningTool(command) {
  return command.status === "in_progress" || command.status === "pending";
}

function toolOutputText(command) {
  if (command.output) {
    return `${command.truncated ? "（较早输出已省略）\n" : ""}${command.output}`;
  }
  return isRunningTool(command) ? "等待输出……" : "没有输出。";
}

function normalizeToolKind(kind) {
  return [
    "read", "edit", "delete", "move", "search", "execute",
    "think", "fetch", "switch_mode", "other",
  ].includes(kind) ? kind : "other";
}

function isInlineToolKind(kind) {
  return kind === "read" || kind === "edit" || kind === "delete" ||
    kind === "move" || kind === "switch_mode";
}

function toolDisplayMode(kind) {
  if (kind === "think") return "hidden";
  return isInlineToolKind(kind) ? "inline" : "card";
}

function clipTitle(title) {
  const normalized = String(title || "工具").replace(/\s+/g, " ").trim();
  const value = normalized || "工具";
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
    syncApprovalNotice();
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
  if (result?.kind === "rewind") return;
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
  const hasAttachments = readyAttachments().length > 0;
  const uploading = hasUnfinishedUploads();
  const confirmLocked = state.composerLocksConfirms;
  const navigationBusy = state.navigationBusy || state.sessionLoading;
  const navigationLocked = state.busy || navigationBusy || state.taskRunning || uploading;
  const projectHasActiveTask = state.sessions.some((session) => session.state === "active");
  elements.projectSelect.disabled = !connected || navigationLocked || state.selectionMode;
  elements.newSessionButton.disabled = !connected || !state.projectId || navigationLocked ||
    state.selectionMode;
  elements.sessionSearchInput.disabled = !connected || !state.projectId || navigationBusy ||
    state.selectionMode;
  elements.selectSessionsButton.disabled = !connected || navigationLocked ||
    projectHasActiveTask ||
    selectableSessions().length === 0;
  elements.selectAllSessionsButton.disabled = !connected || navigationBusy || state.busy ||
    state.taskRunning || selectableSessions().length === 0;
  elements.loadMoreSessionsButton.disabled = !connected || navigationBusy;
  elements.sessionViewBackButton.disabled = !connected || navigationBusy;
  elements.archivedSessionsButton.disabled = !connected || navigationBusy;
  elements.trashSessionsButton.disabled = !connected || navigationBusy;
  for (const item of elements.sessionList.querySelectorAll(".session-item")) {
    const itemIsActive = item.dataset.state === "active";
    for (const button of item.querySelectorAll("button")) {
      const opensSession = button.classList.contains("session-open");
      const cannotOpen = opensSession && state.sessionView !== "active";
      button.disabled = navigationLocked || cannotOpen ||
        (!opensSession && (state.taskRunning || projectHasActiveTask || itemIsActive));
    }
    for (const checkbox of item.querySelectorAll('input[type="checkbox"]')) {
      checkbox.disabled = navigationBusy || state.busy || state.taskRunning || itemIsActive;
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
  elements.attachmentButton.disabled = !connected || !hasSession || navigationBusy ||
    state.selectionMode || state.pendingAttachments.length >= MAX_MESSAGE_ATTACHMENTS;
  elements.commandMenuButton.disabled = !connected || !hasSession || state.taskRunning ||
    state.busy || hasText || hasAttachments;
  elements.rewindShortcut.disabled = !connected || !hasSession || state.taskRunning || state.busy || confirmLocked;
  elements.rewindShortcut.title = confirmLocked ? "请先点开输入框再回退" : "";
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
    : !connected || !hasSession || state.busy || uploading || (!hasText && !hasAttachments);
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
  state.pendingUserMessages.clear();
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
  abortAttachmentUploads();
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

function syncApprovalNotice() {
  if (elements.approvalList.children.length > 0) {
    showNotice(WAITING_APPROVAL_NOTICE);
    return;
  }
  hideApprovalNotice();
}

function hideApprovalNotice() {
  if (elements.noticeText.textContent === WAITING_APPROVAL_NOTICE) hideNotice();
}

function showNotice(text) {
  state.noticeAction = null;
  elements.noticeText.textContent = text ?? "";
  elements.noticeActionButton.hidden = true;
  elements.noticeActionButton.textContent = "";
  elements.notice.hidden = !text;
}

function showActionNotice(text, actionLabel, action) {
  state.noticeAction = action;
  elements.noticeText.textContent = text;
  elements.noticeActionButton.textContent = actionLabel;
  elements.noticeActionButton.hidden = false;
  elements.notice.hidden = false;
}

function hideNotice() {
  state.noticeAction = null;
  elements.notice.hidden = true;
  elements.noticeText.textContent = "";
  elements.noticeActionButton.hidden = true;
  elements.noticeActionButton.textContent = "";
}

function closeSocket() {
  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    rejectPending(new Error("连接已关闭。"));
    try { socket.close(); } catch {}
  }
}

async function retryOutboxForCurrentSession() {
  if (state.socket?.readyState !== WebSocket.OPEN) return;
  const matches = loadOutbox().filter((entry) =>
    entry.projectId === state.projectId && entry.sessionId === state.currentSessionId
  );
  for (const outbox of matches) {
    try {
      await request("message.send", {
        text: outbox.text,
        clientMessageId: outbox.clientMessageId,
        attachmentIds: outbox.attachmentIds,
      });
      clearOutbox(outbox.clientMessageId);
    } catch (error) {
      if (error?.code !== "request_timeout" && state.socket?.readyState === WebSocket.OPEN) {
        clearOutbox(outbox.clientMessageId);
        showNotice(`保留消息重试失败：${errorMessage(error)}`);
      }
      break;
    }
  }
}

function createClientMessageId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function saveOutbox(entry) {
  const entries = loadOutbox().filter((candidate) =>
    candidate.clientMessageId !== entry.clientMessageId
  );
  entries.push(entry);
  stateSet(OUTBOX_KEY, JSON.stringify(entries.slice(-20)));
}

function loadOutbox() {
  try {
    const value = JSON.parse(stateGet(OUTBOX_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((entry) => entry && typeof entry.clientMessageId === "string" &&
        typeof entry.projectId === "string" && typeof entry.sessionId === "string" &&
        typeof entry.text === "string" && Array.isArray(entry.attachmentIds) &&
        entry.attachmentIds.every((id) => typeof id === "string")
    );
  } catch {
    return [];
  }
}

function clearOutbox(clientMessageId) {
  const entries = loadOutbox().filter((entry) => entry.clientMessageId !== clientMessageId);
  if (entries.length === 0) removeStored(OUTBOX_KEY);
  else stateSet(OUTBOX_KEY, JSON.stringify(entries));
}

function attachmentDraftKey(sessionId = state.currentSessionId) {
  return state.projectId && sessionId ? `${state.projectId}\n${sessionId}` : null;
}

function loadAttachmentDraftForCurrentSession() {
  const key = attachmentDraftKey();
  const drafts = loadAttachmentDrafts();
  // localStorage 里只有传完的那些。还没传完的（断线时排队的、失败待重试的）只在
  // 内存里，重连接回同一个会话要留着它们；换会话则连同正在传的一起丢掉。
  const carried = state.pendingAttachments.filter((attachment) =>
    attachment.status !== "ready" && attachment.sessionId === state.currentSessionId
  );
  for (const attachment of state.pendingAttachments) {
    if (carried.includes(attachment)) continue;
    state.attachmentUploads.get(attachment.clientId)?.abort();
    state.attachmentUploads.delete(attachment.clientId);
  }
  const stored = key
    ? publicAttachments(drafts[key]).map((attachment) => ({
      ...attachment,
      clientId: createClientMessageId(),
      status: "ready",
      statusText: "上传完成",
    }))
    : [];
  state.pendingAttachments = [...stored, ...carried];
  renderAttachmentList();
}

function persistCurrentAttachmentDraft() {
  const key = attachmentDraftKey();
  if (!key) return;
  const drafts = loadAttachmentDrafts();
  // file / projectId / sessionId 只服务于排队和重试，不进 localStorage。
  const ready = readyAttachments().map(({
    clientId: _clientId,
    status: _status,
    statusText: _statusText,
    file: _file,
    projectId: _projectId,
    sessionId: _sessionId,
    ...attachment
  }) => attachment);
  if (ready.length > 0) drafts[key] = ready;
  else delete drafts[key];
  const entries = Object.entries(drafts).slice(-50);
  if (entries.length === 0) removeStored(ATTACHMENT_DRAFTS_KEY);
  else stateSet(ATTACHMENT_DRAFTS_KEY, JSON.stringify(Object.fromEntries(entries)));
}

function loadAttachmentDrafts() {
  try {
    const value = JSON.parse(stateGet(ATTACHMENT_DRAFTS_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function publicAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((attachment) =>
    attachment && typeof attachment === "object" &&
    typeof attachment.id === "string" && attachment.id.length <= 128 &&
    typeof attachment.originalName === "string" && attachment.originalName.length <= 1_024
  ).map((attachment) => ({
    id: attachment.id,
    originalName: attachment.originalName,
    size: Number.isFinite(attachment.size) ? attachment.size : NaN,
    declaredMime: typeof attachment.declaredMime === "string" ? attachment.declaredMime : "",
    detectedMime: typeof attachment.detectedMime === "string" ? attachment.detectedMime : "",
    kind: attachment.kind === "image" ? "image" : "file",
    expiresAtMs: Number.isFinite(attachment.expiresAtMs) ? attachment.expiresAtMs : null,
  }));
}

function migrateLocalSessionState(previousSessionId, nextSessionId) {
  if (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) return;
  const outbox = loadOutbox();
  let outboxChanged = false;
  for (const entry of outbox) {
    if (entry.projectId === state.projectId && entry.sessionId === previousSessionId) {
      entry.sessionId = nextSessionId;
      outboxChanged = true;
    }
  }
  if (outboxChanged) stateSet(OUTBOX_KEY, JSON.stringify(outbox));

  const drafts = loadAttachmentDrafts();
  const previousKey = attachmentDraftKey(previousSessionId);
  const nextKey = attachmentDraftKey(nextSessionId);
  if (previousKey && nextKey && drafts[previousKey]) {
    drafts[nextKey] = publicAttachments(mergeAttachments(
      Array.isArray(drafts[nextKey]) ? drafts[nextKey] : [],
      drafts[previousKey],
    ));
    delete drafts[previousKey];
    stateSet(ATTACHMENT_DRAFTS_KEY, JSON.stringify(drafts));
  }

  // 存起来的那些跟着换了 key，内存里还没传完的（排队、待重试）也得跟着换绑，
  // 否则它们会被当成「另一个会话的附件」丢掉或判成会话已切换。
  for (const attachment of state.pendingAttachments) {
    if (attachment.sessionId === previousSessionId) attachment.sessionId = nextSessionId;
  }
}

function scheduleReconnect() {
  if (state.reconnectTimer || !state.reconnectEnabled) return;
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    void connect();
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
