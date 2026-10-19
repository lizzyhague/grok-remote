import { renderMarkdown, sanitizeHref } from "./markdown.js";
import { createConfirmDialog } from "./confirm-dialog.js";
import { createNoticeController } from "./notice.js";
import { createSelectionBar, trashRemainingText } from "./selection-bar.js";

/** Interface text from i18n.js, which loads in <head> before this module. */
const t = window.grokRemoteI18n ? window.grokRemoteI18n.t : (key) => key;
const localize = window.grokRemoteI18n ? window.grokRemoteI18n.localize : (value, fallback = "") =>
  typeof value === "string" ? value : fallback;

const TOKEN_KEY = "grok-remote-token";
const PROJECT_KEY = "grok-remote.project";
const SIDEBAR_COLLAPSED_KEY = "grok-remote.sidebar-collapsed";
const OUTBOX_KEY = "grok-remote.outbox-v1";
const ATTACHMENT_DRAFTS_KEY = "grok-remote.attachment-drafts-v1";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_ATTACHMENTS = 100;
const MAX_COMMAND_OUTPUT = 100_000;
const TOOL_TITLE_LIMIT = 48;
const TEMPORARY_INFO = Object.freeze({ lifetime: "temporary", tone: "info" });
const TEMPORARY_WARNING = Object.freeze({ lifetime: "temporary", tone: "warning" });
const TEMPORARY_ERROR = Object.freeze({ lifetime: "temporary", tone: "error" });
const SESSION_SELECTION_VIEWS = Object.freeze({
  active: { actions: [
    { id: "archive", labelKey: "selection.archive", doneKey: "selection.doneArchive", icon: "archive" },
    { id: "trash-active", labelKey: "common.delete", doneKey: "selection.doneTrash", icon: "delete", danger: true },
  ] },
  archived: { actions: [
    { id: "unarchive", labelKey: "selection.unarchive", doneKey: "selection.doneUnarchive", icon: "unarchive" },
    { id: "trash-archived", labelKey: "common.delete", doneKey: "selection.doneTrash", icon: "delete", danger: true },
  ] },
  trash: { actions: [
    { id: "restore-trash", labelKey: "selection.restore", doneKey: "selection.doneRestore", icon: "restore" },
    {
      id: "delete-trash",
      labelKey: "selection.purge",
      doneKey: "selection.donePurge",
      icon: "purge",
      danger: true,
      permanent: true,
    },
  ] },
});
/** Delay enabling rewind and always-approve after blur so one tap cannot both blur and confirm. */
const COMPOSER_CONFIRM_UNLOCK_MS = 300;

function measureScrollbarWidth() {
  const probe = document.createElement("div");
  probe.className = "scrollbar-measure";
  probe.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll;visibility:hidden;";
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}

document.documentElement.style.setProperty("--scrollbar-width", `${measureScrollbarWidth()}px`);

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
  sessionList: byId("session-list"),
  loadMoreSessionsButton: byId("load-more-sessions-button"),
  archivedSessionsButton: byId("archived-sessions-button"),
  trashSessionsButton: byId("trash-sessions-button"),
  appAlertDialog: byId("app-alert-dialog"),
  appAlertTitle: byId("app-alert-title"),
  appAlertMessage: byId("app-alert-message"),
  confirmDialog: byId("confirm-dialog"),
  confirmDialogTitle: byId("confirm-dialog-title"),
  confirmDialogMessage: byId("confirm-dialog-message"),
  confirmDialogAcceptButton: byId("confirm-dialog-accept-button"),
  confirmDialogCancelButton: byId("confirm-dialog-cancel-button"),
  renameSessionDialog: byId("rename-session-dialog"),
  renameSessionForm: byId("rename-session-form"),
  renameSessionInput: byId("rename-session-input"),
  renameSessionStatus: byId("rename-session-status"),
  renameSessionCancelButton: byId("rename-session-cancel-button"),
  appearanceSettingsButton: byId("appearance-settings-button"),
  appearanceSettingsDialog: byId("appearance-settings-dialog"),
  themeOptions: byId("theme-options"),
  languageSetting: byId("language-setting"),
  languageOptions: byId("language-options"),
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
  noticeCloseButton: byId("notice-close-button"),
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
  connectionReady: false,
  replayingEvents: false,
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
const noticeController = createNoticeController({
  element: elements.notice,
  textElement: elements.noticeText,
  actionButton: elements.noticeActionButton,
  closeButton: elements.noticeCloseButton,
  onActionError: (error) => showNotice(errorMessage(error), TEMPORARY_ERROR),
});
const confirmDialogController = createConfirmDialog({
  dialog: elements.confirmDialog,
  titleElement: elements.confirmDialogTitle,
  messageElement: elements.confirmDialogMessage,
  acceptButton: elements.confirmDialogAcceptButton,
  cancelButton: elements.confirmDialogCancelButton,
});
const selectionBar = createSelectionBar({
  container: elements.selectionHeading,
  views: SESSION_SELECTION_VIEWS,
  initialView: state.sessionView,
  getId: (session) => session.id,
  getTitle: (session) => session.title,
  isSelectable: sessionSelectable,
  isPinned: (session) => Boolean(session.marked),
  executeAction: executeSessionSelectionAction,
  refreshItems: () => loadSessions(),
  confirm: (message, options) => confirmDialogController.show(message, options),
  notify: (message, tone) => showNotice(
    message,
    tone === "error" ? TEMPORARY_ERROR : TEMPORARY_INFO,
  ),
  errorMessage,
  onSelectionChange: renderSessionList,
  onBusyChange: setNavigationBusy,
  onBack: () => setSessionView("active"),
});
labelScriptedText();

elements.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!window.grokRemoteReady) return;
  const token = elements.tokenInput.value.trim();
  if (!token) {
    setLoginStatus(t("login.tokenMissing"), "error");
    return;
  }
  void connect(token);
});
elements.projectSelect.addEventListener("change", () => {
  state.projectId = elements.projectSelect.value;
  stateSet(PROJECT_KEY, state.projectId);
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
  selectionBar.setManualSelection(true);
});
elements.appearanceSettingsButton.addEventListener("click", () => {
  renderThemeChoice();
  renderLanguageChoice();
  elements.appearanceSettingsDialog.showModal();
});
elements.themeOptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme-choice]");
  if (!button || !window.grokRemoteTheme) return;
  window.grokRemoteTheme.set(button.dataset.themeChoice);
  renderThemeChoice();
});
elements.languageOptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-language-choice]");
  if (button && window.grokRemoteI18n) window.grokRemoteI18n.set(button.dataset.languageChoice);
});
window.addEventListener("grok-remote-languagechange", () => {
  renderLanguageChoice();
  relabelInterface();
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

elements.renameSessionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitRename();
});
elements.renameSessionCancelButton.addEventListener("click", () => {
  elements.renameSessionDialog.close();
});
elements.appView.dataset.sidebarCollapsed = String(state.sidebarCollapsed);
syncSidebarState();

markReady();
removeStored(TOKEN_KEY);
void connect();

function markReady() {
  window.grokRemoteReady = true;
  window.grokRemoteMarkReady?.();
}

async function connect(token) {
  const attempt = ++state.connectAttempt;
  closeSocket();
  state.reconnectEnabled = true;
  updateControls();
  try {
    let response;
    try {
      response = token
        ? await fetch("/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
          cache: "no-store",
        })
        : await fetch("/auth/session", { cache: "no-store" });
    } catch {
      throw new Error(t("login.noResponse"));
    }
    if (attempt !== state.connectAttempt) return;
    elements.tokenInput.value = "";
    if (response.status === 401) {
      state.reconnectEnabled = false;
      showLogin();
      setLoginStatus(token ? t("login.tokenInvalid") : t("login.required"), token ? "error" : null);
      return;
    }
    if (!response.ok) throw new Error(t("login.unavailable"));
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
    setLoginStatus(errorMessage(error), "error");
    setConnectionStatus("disconnected", "connection.reconnecting");
    scheduleReconnect();
    return;
  }
  setConnectionStatus("connecting", "connection.connecting");
  setLoginStatus(t("login.connecting"), "progress");
  closeSocket();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener("open", () => {
    if (state.socket !== socket) return;
    void (async () => {
      // Sessions belong to connections (#requireSession server-side). Reconnecting creates a new connection with
      // no open session, so restore the previous session before messages or upload tickets can be accepted.
      const previousSessionId = state.currentSessionId;
      try {
        showApp();
        await loadProjects();
        if (state.socket !== socket) return;
        await ensureSlashMenu();
        if (state.socket !== socket) return;
        if (previousSessionId) await restoreSessionAfterReconnect(previousSessionId);
        if (state.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        state.connectionReady = true;
        setConnectionStatus("connected", "connection.connected");
        updateControls();
        await flushQueuedAttachments();
      } catch (error) {
        if (state.socket !== socket) return;
        closeSocket();
        setConnectionStatus("disconnected", "connection.reconnecting");
        setLoginStatus(errorMessage(error), "error");
        scheduleReconnect();
      }
    })();
  });
  socket.addEventListener("message", (event) => {
    if (state.socket === socket) handleSocketMessage(String(event.data));
  });
  socket.addEventListener("close", () => {
    if (state.socket !== socket) return;
    state.connectionReady = false;
    rejectPending(new Error(t("connection.lost")));
    setConnectionStatus("disconnected", "connection.reconnecting");
    updateControls();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    if (state.socket !== socket) return;
    setLoginStatus(t("login.hostUnreachable"), "error");
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
    const error = new Error(localize(message.error?.message, t("request.failed")));
    error.code = message.error?.code;
    pending.reject(error);
    return;
  }
  pending.resolve(message.data);
}

function request(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      reject(new Error(t("connection.notConnected")));
      return;
    }
    const requestId = `r${++state.requestId}`;
    const timer = window.setTimeout(() => {
      state.pending.delete(requestId);
      const error = new Error(t("request.timeout"));
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
    if (generation === state.sessionLoadGeneration) {
      showNotice(errorMessage(error), TEMPORARY_ERROR);
    }
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
  else if (selectionBar.isSelecting()) {
    selectionBar.setView("active");
    renderSessionList();
  }
  setNavigationBusy(true);
  try {
    const opened = await request("session.start", { projectId: state.projectId });
    applyOpenedSession(opened);
    upsertSession(opened.session);
    renderSessionList();
    closeMobileSidebar();
  } catch (error) {
    showNotice(errorMessage(error), TEMPORARY_ERROR);
  } finally {
    setNavigationBusy(false);
    updateControls();
  }
}

async function resumeSession(sessionId) {
  const selected = findSessionSummary(sessionId);
  if (selected && !directoryAvailable(selected.projectId)) {
    showAlert(t("session.directoryGone"), t("session.cannotOpen"));
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
 * Return automatically to the pre-disconnect session. If it was archived or deleted while disconnected,
 * return to the list and explain why.
 */
async function restoreSessionAfterReconnect(sessionId) {
  const socket = state.socket;
  try {
    const opened = await request("session.resume", {
      projectId: state.projectId,
      sessionId,
    });
    if (state.socket !== socket) return;
    // The session is already rendered. Rebuilding it would visibly flash the conversation; events.resume can
    // restore missed events by persisted sequence number.
    if (opened?.session?.id === state.currentSessionId) {
      applyResumedSessionInPlace(opened);
    } else {
      applyOpenedSession(opened);
    }
  } catch (error) {
    // Preserve the draft if recovery disconnects again so the next reconnect can continue.
    if (state.socket !== socket || socket.readyState !== WebSocket.OPEN) throw error;
    resetCurrentSession();
    showEmpty("empty.chooseSession");
    showNotice(t("reconnect.restoreFailed", { message: errorMessage(error) }), TEMPORARY_ERROR);
    return;
  }
}

/**
 * Lightweight applyOpenedSession for reconnecting to the same session. Preserve the timeline and attachment
 * draft, restore connection-bound state, and replay events missed while disconnected.
 */
function applyResumedSessionInPlace(opened) {
  const socket = state.socket;
  const sessionId = state.currentSessionId;
  const missedAfterSeq = state.lastSeq;
  state.sessionTitle = opened.session?.title || state.sessionTitle;
  state.alwaysApprove = opened.alwaysApprove === true;
  state.taskRunning = Boolean(opened.activeTaskId);
  upsertSession(opened.session);
  updateConversationTitle();
  elements.approvalList.replaceChildren();
  for (const approval of opened.pendingApprovals ?? []) addApproval(approval);
  syncApprovalNotice();
  void request("events.resume", { afterSeq: missedAfterSeq })
    .then((data) => {
      if (state.socket !== socket || state.currentSessionId !== sessionId) return;
      replayServerEvents(data?.events ?? []);
    })
    .catch((error) => showNotice(errorMessage(error), TEMPORARY_ERROR));
  updateControls();
  renderSessionList();
  void retryOutboxForCurrentSession();
}

/** Render recovered content at once, preserving reading position without replaying typing or scrolling. */
function replayServerEvents(events) {
  if (events.length === 0) return;
  const stickToBottom = isNearBottom();
  const scrollTop = elements.timeline.scrollTop;
  state.replayingEvents = true;
  try {
    for (const event of events) handleServerEvent(event);
    for (const stream of state.assistantStreams.values()) {
      if (stream.frame !== null) cancelAnimationFrame(stream.frame);
      stream.frame = null;
      if (stream.markdownRendered) continue;
      if (stream.completed) finishAssistant(stream);
      else {
        stream.shown = stream.target;
        if (stream.textElement) stream.textElement.textContent = stream.target;
      }
    }
  } finally {
    state.replayingEvents = false;
    elements.timeline.scrollTo({
      top: stickToBottom ? elements.timeline.scrollHeight : scrollTop,
      behavior: "instant",
    });
  }
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
    showNotice(t("rewind.done"), TEMPORARY_INFO);
  } catch (error) {
    showNotice(errorMessage(error), TEMPORARY_ERROR);
  }
}

function applyOpenedSession(opened) {
  if (state.currentSessionId && state.currentSessionId !== opened.session?.id) {
    clearCurrentSessionNotice(state.currentSessionId);
  }
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
  syncApprovalNotice();
  const resumeAfterSeq = opened.resumeAfterSeq ?? 0;
  if (resumeAfterSeq < state.lastSeq || state.taskRunning) {
    void request("events.resume", { afterSeq: resumeAfterSeq }).then((data) => {
      replayServerEvents(data?.events ?? []);
    }).catch((error) => showNotice(errorMessage(error), TEMPORARY_ERROR));
  }
  updateControls();
  renderSessionList();
  void retryOutboxForCurrentSession();
}

function setSessionView(view, load = true) {
  state.sessionView = view;
  selectionBar.setView(view);
  state.sessions = [];
  state.markedSessions = [];
  state.sessionCursor = null;
  renderSessionViewTitle();
  const activeView = view === "active";
  elements.sessionViewBackButton.hidden = activeView;
  elements.archivedSessionsButton.hidden = !activeView;
  elements.trashSessionsButton.hidden = !activeView;
  renderSessionList();
  if (load) void loadSessions();
}

function setNavigationBusy(busy) {
  state.navigationBusy = busy;
  updateControls();
}

function renderSessionViewTitle() {
  elements.sessionViewTitle.textContent = t(state.sessionView === "active"
    ? "sidebar.recent"
    : state.sessionView === "archived"
    ? "sidebar.archived"
    : "sidebar.trash");
}

function renderSessionList() {
  // The list is temporarily cleared when refresh begins. Reconcile after this refresh settles instead of
  // prematurely discarding a selection that still exists.
  if (!state.sessionLoading) selectionBar.reconcile(visibleSessionSummaries());
  elements.sessionViewTitle.parentElement.hidden = selectionBar.isSelecting();
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
    loading.textContent = t("sessions.loading");
    elements.sessionList.append(loading);
  } else if (state.sessions.length === 0) {
    if (marked.length === 0) {
      const empty = document.createElement("p");
      empty.className = "session-list-empty";
      const searching = Boolean(elements.sessionSearchInput.value.trim());
      empty.textContent = searching
        ? t("sessions.noMatch")
        : state.sessionView === "active"
        ? t("sessions.noneInProject")
        : state.sessionView === "archived"
        ? t("sessions.noneArchived")
        : t("sessions.trashEmpty");
      elements.sessionList.append(empty);
    }
  } else {
    for (const session of state.sessions) {
      elements.sessionList.append(createSessionItem(session));
    }
  }
  elements.loadMoreSessionsButton.hidden = !state.sessionCursor;
  updateControls();
}

function createSessionItem(session) {
  const item = document.createElement("article");
  item.className = "session-item";
  item.dataset.current = String(session.id === state.currentSessionId);
  item.dataset.state = session.state || "not_loaded";
  item.setAttribute("role", "listitem");

  if (selectionBar.isSelecting()) {
    const label = document.createElement("label");
    label.className = "session-select-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const selectable = selectionBar.isSelectable(session);
    item.dataset.selectable = String(selectable);
    checkbox.checked = selectable && selectionBar.isSelected(session.id);
    checkbox.disabled = !selectable;
    checkbox.setAttribute("aria-label", t("sessions.selectOne", { title: session.title || t("session.untitled") }));
    if (session.state === "active") {
      label.title = t("session.organizingBusy");
    } else if (session.pending === true) {
      label.title = t("sessions.pendingCannotOrganize");
    } else if (!selectable) {
      label.title = t("sessions.otherProject");
    }
    checkbox.addEventListener("change", () => {
      selectionBar.toggle(session.id);
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
  if (state.sessionView === "active" && session.pending !== true) {
    item.append(createSessionRename(session));
  }
  if (session.pending !== true) item.append(createSessionMark(session));
  return item;
}

function appendSessionText(container, session) {
  const title = document.createElement("span");
  title.className = "session-item-title";
  title.textContent = session.title || t("session.untitled");
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
      ? (date ? t("session.runningAt", { date }) : t("session.running"))
      : date;
  }
  container.append(title, preview, meta);
}

function createSessionRename(session) {
  const button = document.createElement("button");
  button.className = "session-rename-trigger quiet";
  button.type = "button";
  button.setAttribute("aria-label", t("sessions.renameOne", { title: session.title || t("session.untitled") }));
  button.title = t("rename.title");
  button.append(sessionRenameIcon());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openRenameDialog(session);
  });
  return button;
}

function createSessionMark(session) {
  const button = document.createElement("button");
  button.className = "session-mark-trigger quiet";
  button.type = "button";
  button.setAttribute("aria-pressed", String(Boolean(session.marked)));
  button.setAttribute(
    "aria-label",
    session.marked
      ? t("sessions.unpinOne", { title: session.title || t("session.untitled") })
      : t("sessions.pinOne", { title: session.title || t("session.untitled") }),
  );
  button.title = session.marked ? t("sessions.unpin") : t("sessions.pinHint");
  button.append(sessionMarkIcon(Boolean(session.marked)));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void toggleSessionMark(session);
    if (!session.marked && session.pending !== true) openRenameDialog(session);
  });
  return button;
}

function sessionRenameIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("session-rename-icon");
  const pencil = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pencil.setAttribute("d", "M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4");
  svg.append(pencil);
  return svg;
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
   * The pin shape comes from pocket-ai's retained-material marker. SVG lets it follow currentColor and each
   * project's accent; the system emoji font's red cannot be recolored.
   *
   * The two states use separate pin bodies rather than rotating one shape: unpinned is diagonal and outlined
   * with --muted; pinned is upright and filled with --accent. Axis-aligned paths stay sharp at small sizes and
   * avoid clipping the pin head outside the viewBox.
   *
   * The viewBox uses Tabler's 24-unit grid; CSS independently renders it at 17px.
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
    showNotice(errorMessage(error), TEMPORARY_ERROR);
  }
}

/** Pin the session ID when the dialog opens because the active session may change underneath it. */
let renamingSessionId = null;
let renamingInitialTitle = "";

function openRenameDialog(session) {
  if (!session || session.pending === true) return;
  renamingSessionId = session.id;
  renamingInitialTitle = session.title || t("session.untitled");
  elements.renameSessionInput.value = renamingInitialTitle;
  elements.renameSessionStatus.textContent = "";
  setRenameDialogBusy(false);
  if (!elements.renameSessionDialog.open) elements.renameSessionDialog.showModal();
  elements.renameSessionInput.focus();
  elements.renameSessionInput.select();
}

async function submitRename() {
  const session = findSessionSummary(renamingSessionId);
  if (!session || session.pending === true) {
    elements.renameSessionDialog.close();
    return;
  }
  const title = elements.renameSessionInput.value.trim();
  if (!title) {
    elements.renameSessionStatus.textContent = t("rename.empty");
    elements.renameSessionInput.focus();
    return;
  }
  if (title === renamingInitialTitle) {
    elements.renameSessionDialog.close();
    return;
  }
  const projectId = session.projectId || state.projectId;
  if (!projectId) {
    elements.renameSessionStatus.textContent = t("rename.projectMissing");
    return;
  }
  try {
    setRenameDialogBusy(true);
    elements.renameSessionStatus.textContent = "";
    await request("session.rename", {
      projectId,
      sessionId: session.id,
      title,
    });
    session.title = title;
    if (session.id === state.currentSessionId) {
      state.sessionTitle = title;
      updateConversationTitle();
    }
    renderSessionList();
    elements.renameSessionDialog.close();
  } catch (error) {
    elements.renameSessionStatus.textContent = errorMessage(error);
  } finally {
    setRenameDialogBusy(false);
  }
}

function setRenameDialogBusy(busy) {
  elements.renameSessionInput.disabled = busy;
  for (const button of elements.renameSessionForm.querySelectorAll("button")) {
    button.disabled = busy;
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

function showAlert(message, title = t("alert.title")) {
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

/**
 * Bulk organization applies only to the current project. Cross-project pinned sessions and unsent local drafts
 * cannot join a request targeting the current project's backend sessions.
 */
function sessionSelectable(session) {
  return session.state !== "active" && session.pending !== true &&
    Boolean(state.projectId) && session.projectId === state.projectId;
}

async function executeSessionSelectionAction(action, sessionIds) {
  const projectId = state.projectId;
  if (!projectId || sessionIds.length === 0) {
    throw new Error(t("sessions.nothingToOrganize"));
  }
  const result = await request("sessions.mutate", { projectId, sessionIds, action });
  const succeeded = Array.isArray(result?.succeeded) ? result.succeeded : [];
  const failed = Array.isArray(result?.failed) ? result.failed : [];
  if (
    state.currentSessionId && succeeded.includes(state.currentSessionId) &&
    (action === "archive" || action.startsWith("trash-") || action === "delete-trash")
  ) {
    resetCurrentSession();
    showEmpty("empty.chooseSession");
  }
  return {
    succeeded,
    failed: failed.map((failure) => ({
      id: failure?.sessionId,
      reason: localize(failure?.message, t("selection.failed")),
    })),
  };
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
    title: state.sessionTitle || t("session.untitled"),
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

function resetCurrentSession() {
  if (state.currentSessionId) clearCurrentSessionNotice(state.currentSessionId);
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
  showEmpty("empty.chooseSession");
  elements.approvalList.replaceChildren();
  updateControls();
}

function renderHistory(tasks, hasOlder) {
  clearTimeline();
  elements.timeline.append(elements.historyLoader);
  elements.historyLoader.hidden = !hasOlder;
  const rendered = renderTasks(tasks);
  if (rendered === 0 && !hasOlder) {
    showEmpty("empty.newSession");
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
  elements.loadOlderButton.textContent = t("timeline.loadingOlder");
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
    showNotice(errorMessage(error), TEMPORARY_ERROR);
  } finally {
    elements.loadOlderButton.disabled = false;
    elements.loadOlderButton.textContent = t("timeline.loadOlder");
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
    clearNotice(deliveryNoticeKey(clientMessageId));
    if (result?.sessionId && result.sessionId !== state.currentSessionId) {
      migrateLocalSessionState(state.currentSessionId, result.sessionId);
      state.currentSessionId = result.sessionId;
    }
  } catch (error) {
    const uncertainDelivery = error?.code === "request_timeout" ||
      state.socket?.readyState !== WebSocket.OPEN;
    if (uncertainDelivery) {
      showNotice(t("delivery.uncertain"), {
        lifetime: "state",
        tone: "warning",
        key: deliveryNoticeKey(clientMessageId),
      });
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
    showNotice(t("delivery.restored", { message: errorMessage(error) }), TEMPORARY_ERROR);
  }
  updateControls();
}

/*
 * Accept file selection regardless of connection state. Mobile pickers often background the page and break the
 * connection; startUpload() queues the file until reconnection instead of silently losing it.
 */
async function uploadFiles(files) {
  if (!state.currentSessionId || !state.projectId || files.length === 0) return;
  const available = MAX_MESSAGE_ATTACHMENTS - state.pendingAttachments.length;
  if (available <= 0) {
    showNotice(t("attachment.limit", { count: MAX_MESSAGE_ATTACHMENTS }), TEMPORARY_WARNING);
    return;
  }
  if (files.length > available) {
    showNotice(t("attachment.limitPartial", { count: MAX_MESSAGE_ATTACHMENTS, available }), TEMPORARY_WARNING);
  }
  await Promise.all(files.slice(0, available).map((file) => uploadFile(file)));
}

async function uploadFile(file) {
  const draft = {
    clientId: createClientMessageId(),
    originalName: file.name || t("attachment.untitled"),
    size: file.size,
    declaredMime: file.type || "application/octet-stream",
    status: "requesting",
    statusKey: "attachment.preparing",
    statusText: "",
    // Keep the file on the draft because queueing and retries need to upload it again.
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
 * Reentrant upload lifecycle for one draft: queue while disconnected, resume through flushQueuedAttachments(),
 * and retry after failure.
 */
async function startUpload(draft) {
  if (!draft.file || state.attachmentUploads.has(draft.clientId)) return;
  if (state.socket?.readyState !== WebSocket.OPEN || !state.connectionReady) {
    Object.assign(draft, { status: "queued", statusKey: "attachment.waitingReconnect", statusText: "" });
    renderAttachmentList();
    updateControls();
    return;
  }
  // The session may change while queued; attachments remain bound to their original session.
  if (draft.projectId !== state.projectId || draft.sessionId !== state.currentSessionId) {
    Object.assign(draft, {
      status: "failed",
      statusKey: "attachment.sessionChangedShort",
      statusText: "",
      file: null,
    });
    renderAttachmentList();
    updateControls();
    return;
  }

  const { clientId, file } = draft;
  const socket = state.socket;
  const controller = new AbortController();
  state.attachmentUploads.set(clientId, controller);
  Object.assign(draft, { status: "requesting", statusKey: "attachment.preparing", statusText: "" });
  renderAttachmentList();
  updateControls();
  try {
    const ticket = await request("attachment.ticket.create", {
      originalName: draft.originalName,
      declaredMime: draft.declaredMime,
      expectedSize: file.size,
    });
    if (state.projectId !== draft.projectId || state.currentSessionId !== draft.sessionId) {
      throw new Error(t("attachment.sessionChanged"));
    }
    Object.assign(draft, { status: "uploading", statusKey: "attachment.uploading", statusText: "" });
    renderAttachmentList();
    const response = await fetch("/attachments/upload", {
      method: "POST",
      headers: { "x-upload-ticket": ticket.ticket },
      body: file,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(localize(body?.error?.message, t("attachment.failed")));
      error.code = body?.error?.code;
      throw error;
    }
    if (!body?.attachment?.id) throw new Error(t("attachment.noId"));
    Object.assign(draft, body.attachment, {
      clientId,
      status: "ready",
      statusKey: "attachment.uploaded",
      statusText: "",
      file: null,
    });
    persistCurrentAttachmentDraft();
  } catch (error) {
    // Treat disconnects as queued work and wait for the next session recovery.
    if ((state.socket !== socket || !state.connectionReady ||
        state.socket?.readyState !== WebSocket.OPEN) && error?.name !== "AbortError") {
      Object.assign(draft, { status: "queued", statusKey: "attachment.waitingReconnect", statusText: "" });
    } else {
      Object.assign(draft, {
        status: "failed",
        statusKey: error?.name === "AbortError" ? "attachment.cancelled" : "",
        statusText: error?.name === "AbortError" ? "" : errorMessage(error),
      });
    }
  } finally {
    state.attachmentUploads.delete(clientId);
    renderAttachmentList();
    updateControls();
    if (draft.status === "queued" && state.connectionReady &&
        state.pendingAttachments.includes(draft)) void startUpload(draft);
  }
}

/** Resume queued attachment uploads after restoring the session. */
async function flushQueuedAttachments() {
  const queued = state.pendingAttachments.filter((draft) => draft.status === "queued");
  if (queued.length === 0) return;
  await Promise.all(queued.map((draft) => startUpload(draft)));
}

/** Attachments still queued or uploading; delay sending so they are not omitted. */
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
    name.textContent = attachment.originalName || t("attachment.untitled");
    const meta = document.createElement("small");
    meta.className = "attachment-meta";
    meta.textContent = attachment.status === "ready"
      ? `${attachment.id} · ${t("attachment.uploaded")}`
      : attachment.statusText || t(attachment.statusKey || "attachment.processing");
    const actions = document.createElement("div");
    actions.className = "attachment-actions";
    // Offer retry while the file remains available; the adjacent action removes it.
    if (attachment.status === "failed" && attachment.file) {
      const retry = document.createElement("button");
      retry.className = "quiet attachment-retry";
      retry.type = "button";
      retry.textContent = t("common.retry");
      retry.setAttribute("aria-label", t("attachment.retryOne", {
        name: attachment.originalName || t("attachment.untitled"),
      }));
      retry.addEventListener("click", () => void startUpload(attachment));
      actions.append(retry);
    }
    const remove = document.createElement("button");
    remove.className = "quiet attachment-remove";
    remove.type = "button";
    remove.textContent = t("attachment.remove");
    remove.setAttribute("aria-label", t("attachment.removeOne", { name: attachment.originalName || t("attachment.untitled") }));
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
    `[Attachment: ${attachment.originalName} · ${attachment.id}]`);
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
        const sessionId = typeof event.sessionId === "string"
          ? event.sessionId
          : state.currentSessionId;
        if (sessionId === state.currentSessionId) {
          state.sessionTitle = event.title;
          updateConversationTitle();
        }
        const found = findSessionSummary(sessionId);
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
      showThinking("thinking.tool");
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
        showNotice(t("approval.waiting"), {
          lifetime: "state",
          tone: "warning",
          key: approvalNoticeKey(),
        });
      }
      if (event.status === "completed" || event.status === "interrupted" || event.status === "failed") {
        state.taskRunning = false;
        hideThinking();
        syncApprovalNotice();
        if (event.status !== "completed") {
          addTaskNote(localize(event.reason, t(event.status === "interrupted" ? "task.interrupted" : "task.failed")));
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
  if (state.replayingEvents) return;
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
      t("tool.query"),
      command.query || (isRunningTool(command) ? t("tool.waitingQuery") : t("tool.noQuery")),
      "command-input",
    );
    appendResourceBlock(command, t("tool.results"), t("tool.noResults"));
    return;
  }
  if (command.kind === "fetch") {
    appendResourceBlock(command, t("tool.address"), t("tool.noAddress"));
    return;
  }
  appendToolTextBlock(command.pane, t("tool.input"), command.input || t("tool.noInput"), "command-input");
  command.outputElement = appendToolTextBlock(
    command.pane,
    t("tool.output"),
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
    empty.textContent = isRunningTool(command) ? t("tool.waitingAddress") : emptyText;
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
    return `${command.truncated ? `${t("tool.truncated")}\n` : ""}${command.output}`;
  }
  return isRunningTool(command) ? t("tool.waitingOutput") : t("tool.noOutput");
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
  const normalized = String(title || t("tool.defaultTitle")).replace(/\s+/g, " ").trim();
  const value = normalized || t("tool.defaultTitle");
  if (value.length <= TOOL_TITLE_LIMIT) return value;
  return `${value.slice(0, TOOL_TITLE_LIMIT - 1)}…`;
}

function addFileChange(event) {
  hideEmpty();
  const note = document.createElement("p");
  note.className = "file-change";
  note.textContent = t("fileChange.completed", { count: event.changedFiles ?? 0 });
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
  card.className = "permission-card";
  card.dataset.approvalId = approval.approvalId;
  card.dataset.kind = approval.kind || "tool";
  const title = document.createElement("p");
  title.className = "permission-card-title";
  title.textContent = t("approval.request");
  const body = document.createElement("div");
  body.className = "permission-card-body";
  if (approval.reason) {
    const detail = document.createElement("p");
    detail.className = "permission-card-detail";
    detail.textContent = localize(approval.reason);
    body.append(detail);
  }
  const actions = document.createElement("div");
  actions.className = "permission-card-actions";
  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "danger";
  decline.textContent = t("approval.decline");
  decline.addEventListener("click", () => void answerApproval(card, approval.approvalId, "decline", null));
  const allow = document.createElement("button");
  allow.type = "button";
  allow.className = "primary";
  allow.textContent = t("approval.allowOnce");
  allow.addEventListener("click", () => void answerApproval(card, approval.approvalId, "approve_once", null));
  actions.append(decline, allow);
  card.append(title, body, actions);
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
    showNotice(errorMessage(error), TEMPORARY_ERROR);
  }
}

function removeApproval(approvalId) {
  elements.approvalList.querySelector(`[data-approval-id="${CSS.escape(String(approvalId ?? ""))}"]`)?.remove();
}

function handleCommandResult(result) {
  if (typeof result?.enabled === "boolean") {
    state.alwaysApprove = result.enabled;
    updateControls();
    showNotice(t(result.enabled ? "alwaysApprove.enabled" : "alwaysApprove.disabled"), TEMPORARY_INFO);
    return;
  }
  if (result?.kind === "info") {
    addTaskNote([localize(result.title), ...(result.lines ?? []).map((line) => localize(line))]
      .filter(Boolean).join("\n"));
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
    onError: (error) => showNotice(errorMessage(error), TEMPORARY_ERROR),
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
  const connected = state.socket?.readyState === WebSocket.OPEN && state.connectionReady;
  const hasSession = Boolean(state.currentSessionId);
  const hasText = Boolean(elements.messageInput.value.trim());
  const hasAttachments = readyAttachments().length > 0;
  const uploading = hasUnfinishedUploads();
  const confirmLocked = state.composerLocksConfirms;
  const navigationBusy = state.navigationBusy || state.sessionLoading;
  const navigationLocked = state.busy || navigationBusy || state.taskRunning || uploading;
  const projectHasActiveTask = visibleSessionSummaries().some((session) =>
    session.projectId === state.projectId && session.state === "active"
  );
  const organizingBusy = state.taskRunning || state.busy || projectHasActiveTask;
  const selectableCount = visibleSessionSummaries().filter(sessionSelectable).length;
  elements.projectSelect.disabled = !connected || navigationLocked;
  elements.newSessionButton.disabled = !connected || !state.projectId || navigationLocked;
  elements.sessionSearchInput.disabled = !connected || !state.projectId || navigationBusy;
  elements.selectSessionsButton.disabled = !connected || navigationLocked ||
    organizingBusy || selectableCount === 0;
  elements.selectSessionsButton.title = organizingBusy
    ? t("session.organizingBusy")
    : t("sidebar.select");
  selectionBar.setDisabled(
    !connected || navigationBusy || organizingBusy,
    organizingBusy ? t("session.organizingBusy") : "",
  );
  elements.loadMoreSessionsButton.disabled = !connected || navigationBusy;
  elements.sessionViewBackButton.disabled = !connected || navigationBusy;
  elements.archivedSessionsButton.disabled = !connected || navigationBusy;
  elements.trashSessionsButton.disabled = !connected || navigationBusy;
  for (const item of elements.sessionList.querySelectorAll(".session-item")) {
    const itemIsActive = item.dataset.state === "active";
    const itemIsSelectable = item.dataset.selectable === "true";
    for (const button of item.querySelectorAll("button")) {
      const opensSession = button.classList.contains("session-open");
      const cannotOpen = opensSession && state.sessionView !== "active";
      button.disabled = navigationLocked || cannotOpen ||
        (!opensSession && (state.taskRunning || projectHasActiveTask || itemIsActive));
    }
    for (const checkbox of item.querySelectorAll('input[type="checkbox"]')) {
      checkbox.disabled = !connected || navigationBusy || organizingBusy ||
        itemIsActive || !itemIsSelectable;
      checkbox.title = organizingBusy ? t("session.organizingBusy") : "";
    }
  }
  elements.messageInput.disabled = !connected || !hasSession;
  elements.messageInput.placeholder = !hasSession
    ? t("composer.placeholderNoSession")
    : state.taskRunning
    ? t("composer.placeholderRunning")
    : state.busy
    ? t("composer.placeholderBusy")
    : t("composer.placeholder");
  elements.attachmentButton.disabled = !connected || !hasSession || navigationBusy ||
    state.pendingAttachments.length >= MAX_MESSAGE_ATTACHMENTS;
  elements.commandMenuButton.disabled = !connected || !hasSession || state.taskRunning ||
    state.busy || hasText || hasAttachments;
  elements.rewindShortcut.disabled = !connected || !hasSession || state.taskRunning || state.busy || confirmLocked;
  elements.rewindShortcut.title = confirmLocked ? t("composer.rewindLocked") : "";
  elements.alwaysApproveShortcut.disabled = !connected || !hasSession || state.busy || confirmLocked;
  elements.alwaysApproveShortcut.setAttribute("aria-pressed", String(state.alwaysApprove));
  elements.alwaysApproveShortcut.title = confirmLocked
    ? t("composer.permissionLocked")
    : state.alwaysApprove
    ? t("composer.alwaysApproveDisable")
    : t("composer.alwaysApproveEnable");
  const taskLabel = t(state.taskRunning ? "composer.stop" : "composer.send");
  elements.taskButton.dataset.action = state.taskRunning ? "stop" : "send";
  elements.taskButton.setAttribute("aria-label", taskLabel);
  elements.taskButton.title = taskLabel;
  elements.taskButton.classList.toggle("primary", !state.taskRunning);
  elements.taskButton.classList.toggle("danger", false);
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
  const collapseLabel = t(isMobileNavigation() ? "sidebar.close" : "sidebar.collapse");
  elements.collapseSidebarButton.setAttribute("aria-label", collapseLabel);
  elements.collapseSidebarButton.title = collapseLabel;
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

function renderThemeChoice() {
  const theme = window.grokRemoteTheme;
  if (!theme) return;
  const current = theme.get();
  for (const button of elements.themeOptions.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === current));
  }
}

// Language is stored only in the current browser; i18n.js owns the preference and applies it to the page.
function renderLanguageChoice() {
  const i18n = window.grokRemoteI18n;
  elements.languageSetting.hidden = !i18n;
  if (!i18n) return;
  const current = i18n.get();
  for (const button of elements.languageOptions.querySelectorAll("[data-language-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.languageChoice === current));
  }
}

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

function showEmpty(key) {
  clearTimeline();
  setKeyedText(elements.emptyState.querySelector("p"), key);
  elements.emptyState.hidden = false;
  elements.timeline.append(elements.emptyState);
}

function hideEmpty() {
  if (elements.emptyState.parentElement) elements.emptyState.remove();
}

function showThinking(key = "thinking.thinking") {
  hideEmpty();
  setKeyedText(elements.thinkingLabel, key);
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
  if (state.replayingEvents) return;
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
  setLoginStatus("");
  elements.tokenInput.focus();
}

function showApp() {
  elements.loginView.hidden = true;
  elements.appView.hidden = false;
  // Reconnection already has a session, attachments, and reading position; showing the UI must preserve them.
  if (!state.currentSessionId) resetCurrentSession();
}

function setConnectionStatus(status, key) {
  elements.connectionStatus.dataset.state = status;
  setKeyedText(elements.connectionStatus, key);
}

/** Text in the page markup that scripts rewrite, so it is set here rather than marked for i18n.js. */
function labelScriptedText() {
  setConnectionStatus("connecting", "connection.connecting");
  setKeyedText(elements.emptyState.querySelector("p"), "empty.chooseSession");
  setKeyedText(elements.thinkingLabel, "thinking.thinking");
  elements.loadOlderButton.textContent = t("timeline.loadOlder");
  renderSessionViewTitle();
}

/**
 * Rewrites the text scripts have set after a language switch. Conversation content already on screen keeps
 * its language; new content, and a session opened again, use the new one.
 */
function relabelInterface() {
  for (const element of document.querySelectorAll("[data-text-key]")) {
    element.textContent = t(element.dataset.textKey);
  }
  if (!elements.loadOlderButton.disabled) elements.loadOlderButton.textContent = t("timeline.loadOlder");
  renderSessionViewTitle();
  selectionBar.relabel();
  renderSessionList();
  renderAttachmentList();
  updateControls();
}

/** Shows interface text and remembers its key, so a language switch can rewrite it in place. */
function setKeyedText(element, key) {
  element.dataset.textKey = key;
  element.textContent = t(key);
}

function syncApprovalNotice() {
  const key = approvalNoticeKey();
  if (elements.approvalList.children.length > 0) {
    showNotice(t("approval.waiting"), {
      lifetime: "state",
      tone: "warning",
      key,
    });
    return;
  }
  clearNotice(key);
}

function approvalNoticeKey(sessionId = state.currentSessionId) {
  return `approval:${sessionId || "current"}`;
}

function deliveryNoticeKey(clientMessageId) {
  return `delivery:${clientMessageId}`;
}

function clearCurrentSessionNotice(sessionId) {
  const key = noticeController.current?.key;
  if (key === approvalNoticeKey(sessionId) || key?.startsWith("delivery:")) {
    clearNotice(key);
  }
}

function showNotice(text, options = TEMPORARY_WARNING) {
  return noticeController.show(text, options);
}

function clearNotice(key) {
  return noticeController.clear(key);
}

function closeSocket() {
  state.connectionReady = false;
  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    rejectPending(new Error(t("connection.closed")));
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
      clearNotice(deliveryNoticeKey(outbox.clientMessageId));
    } catch (error) {
      if (error?.code !== "request_timeout" && state.socket?.readyState === WebSocket.OPEN) {
        clearOutbox(outbox.clientMessageId);
        clearNotice(deliveryNoticeKey(outbox.clientMessageId));
        showNotice(t("delivery.retryFailed", { message: errorMessage(error) }), {
          lifetime: "persistent",
          tone: "error",
          key: deliveryNoticeKey(outbox.clientMessageId),
        });
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
  // localStorage contains only completed uploads. Keep queued and retryable in-memory uploads when reconnecting
  // to the same session; changing sessions discards them along with active uploads.
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
      statusKey: "attachment.uploaded",
      statusText: "",
    }))
    : [];
  state.pendingAttachments = [...stored, ...carried];
  renderAttachmentList();
}

function persistCurrentAttachmentDraft() {
  const key = attachmentDraftKey();
  if (!key) return;
  const drafts = loadAttachmentDrafts();
  // file, projectId, and sessionId support queueing and retries only and never enter localStorage.
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

  // Stored uploads follow the new key; rebind queued and retryable in-memory uploads too so they are not
  // discarded as attachments from another session.
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
  if (status === "completed") return t("tool.completed");
  if (status === "failed") return t("tool.failed");
  if (status === "in_progress" || status === "pending") return t("tool.running");
  return status || t("tool.completed");
}

function formatDate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  return new Intl.DateTimeFormat(window.grokRemoteI18n?.language() === "zh" ? "zh-CN" : "en", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(milliseconds));
}

/** Status line for the login card; regular notices, progress, and errors each use their own color. */
function setLoginStatus(text, tone = null) {
  elements.loginStatus.textContent = text;
  if (tone) elements.loginStatus.dataset.tone = tone;
  else delete elements.loginStatus.dataset.tone;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return localize(error, t("request.failed"));
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
  if (!node) throw new Error(`Missing page element ${id}`);
  return node;
}
