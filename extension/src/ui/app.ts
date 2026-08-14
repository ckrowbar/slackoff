import type { AppState, Controller, MountApp, SessionView, StatusFilter } from "../types.js";
import { Composer } from "./composer.js";
import { ConfirmDialog } from "./confirm.js";
import { element, modelLabel, statusLabel } from "./dom.js";
import { installKeys } from "./keys.js";
import { CommandPalette } from "./palette.js";
import { filterSessions, SessionList } from "./session-list.js";
import { TranscriptView } from "./transcript.js";

export const mountApp: MountApp = (root: HTMLElement, controller: Controller): (() => void) => {
  const hadRootClass = root.classList.contains("slackoff-console");
  const initialTheme = root.getAttribute("data-theme");
  const initialTabIndex = root.getAttribute("tabindex");
  root.classList.add("slackoff-console");
  if (!root.dataset.theme) root.dataset.theme = "codex";
  root.tabIndex = -1;

  let state = controller.getState();
  let selectedCache: SessionView | undefined;
  let visibleSessions: SessionView[] = [];
  let selectionRequested = false;
  let lastNotice: string | undefined;
  let modelSignature = "";
  const timers = new Set<number>();
  const paletteSessions = new Map<string, SessionView>();

  const shell = element("div", "console-shell");
  const topbar = element("header", "topbar");
  const brand = element("div", "topbar__brand");
  const connectionDot = element("span", "connection-dot", { ariaLabel: "Connection status" });
  const workspace = element("strong", "topbar__workspace", { text: "Slackoff Console" });
  brand.append(connectionDot, workspace);
  const filters = element("div", "filter-chips", { role: "group", ariaLabel: "Filter sessions" });
  const filterButtons = new Map<StatusFilter, HTMLButtonElement>();
  for (const [filter, label] of [["all", "All"], ["attention", "Needs you"], ["active", "Active"]] as const) {
    const button = element("button", "filter-chip", { type: "button", text: label, "data-filter": filter });
    button.onclick = () => controller.setFilter(filter);
    filters.append(button);
    filterButtons.set(filter, button);
  }
  const searchWrap = element("label", "search-box");
  searchWrap.append(element("span", "search-box__icon", { text: "⌕", ariaLabel: "Search" }));
  const search = element("input", "search-box__input", { type: "search", placeholder: "Search sessions", autocomplete: "off", spellcheck: "false", ariaLabel: "Search sessions" });
  search.oninput = () => controller.setQuery(search.value);
  searchWrap.append(search);
  const count = element("span", "topbar__count");
  topbar.append(brand, filters, searchWrap, count);

  const body = element("div", "console-body");
  const rail = element("aside", "rail");
  const main = element("main", "main-pane");
  const sessionHeader = element("header", "session-header");
  const headingCopy = element("div", "session-header__copy");
  const titleLine = element("div", "session-header__title-line");
  const sessionTitle = element("h1", "session-header__title");
  const statusPill = element("span", "status-pill");
  titleLine.append(sessionTitle, statusPill);
  const sessionMeta = element("div", "session-header__meta");
  headingCopy.append(titleLine, sessionMeta);
  const headerActions = element("div", "session-header__actions");
  const modelLabelNode = element("label", "model-picker");
  modelLabelNode.append(element("span", "sr-only", { text: "Model" }));
  const modelSelect = element("select", "model-picker__select", { ariaLabel: "Switch model", title: "Switch model. Use Command-K to search all models." });
  modelSelect.onchange = () => {
    const selected = state.sessions.find((session) => session.sessionId === state.selectedSessionId);
    if (selected && modelSelect.value !== selected.model?.selector) {
      void controller.setModel(selected.sessionId, modelSelect.value).catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), true));
    }
  };
  modelLabelNode.append(modelSelect);
  const stopButton = element("button", "secondary-button stop-button", { type: "button", text: "Stop" });
  const closeButton = element("button", "text-button close-button", { type: "button", text: "Close thread" });
  headerActions.append(modelLabelNode, stopButton, closeButton);
  sessionHeader.append(headingCopy, headerActions);

  const toastArea = element("div", "toast-area", { ariaLabel: "Notifications", "aria-live": "polite" });
  const shortcutSheet = element("div", "shortcut-sheet", { role: "presentation" });
  shortcutSheet.hidden = true;
  const shortcutDialog = element("section", "shortcut-sheet__dialog", { role: "dialog", ariaLabel: "Keyboard shortcuts", "aria-modal": "true" });
  const shortcutHeading = element("header", "shortcut-sheet__header");
  const shortcutClose = element("button", "icon-button", { type: "button", text: "×", ariaLabel: "Close keyboard shortcuts" });
  shortcutHeading.append(element("h2", "shortcut-sheet__title", { text: "Keyboard shortcuts" }), shortcutClose);
  const shortcuts = [
    ["j / k", "Next / previous session"], ["↑ / ↓", "Next / previous session"], ["Enter", "Focus composer"],
    ["Esc", "Leave composer / offer to stop"], ["⌘ / Ctrl K", "Command palette"], ["1–9", "Answer a pending question"],
    ["g then a", "Jump to needs attention"], ["?", "Toggle this sheet"], ["Shift Enter", "New line in composer"],
  ];
  const shortcutRows = element("div", "shortcut-sheet__rows");
  for (const [key, description] of shortcuts) {
    const row = element("div", "shortcut-row");
    row.append(element("kbd", "shortcut-row__key", { text: key }), element("span", "shortcut-row__description", { text: description }));
    shortcutRows.append(row);
  }
  shortcutDialog.append(shortcutHeading, shortcutRows);
  shortcutSheet.append(shortcutDialog);

  const footer = element("footer", "console-footer", { text: "j/k move · Enter compose · ⌘K commands · 1–9 answer · ? shortcuts" });
  const confirmDialog = new ConfirmDialog();

  function showToast(message: string, isError = false): void {
    const toast = element("div", `toast${isError ? " toast--error" : ""}`, { role: isError ? "alert" : "status" });
    toast.append(element("span", "toast__mark", { text: isError ? "!" : "i" }), element("span", "toast__message", { text: message }));
    toastArea.append(toast);
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      toast.remove();
    }, 4200);
    timers.add(timer);
  }

  const transcript = new TranscriptView(
    (sessionId, answers) => controller.answerQuestion(sessionId, answers),
    (sessionId, text) => controller.sendInstruction(sessionId, text),
    showToast,
  );
  const composer = new Composer((sessionId, text) => controller.sendInstruction(sessionId, text), showToast);
  const sessionList = new SessionList((sessionId) => {
    selectionRequested = true;
    controller.select(sessionId);
  });
  rail.append(sessionList.node);
  main.append(sessionHeader, transcript.node, composer.node);
  body.append(rail, main);
  shell.append(topbar, body, footer, toastArea, shortcutSheet, confirmDialog.node);
  root.append(shell);

  function selectedSession(): SessionView | undefined {
    const selected = state.sessions.find((session) => session.sessionId === state.selectedSessionId);
    if (selected) selectedCache = selected;
    else if (selectedCache?.sessionId !== state.selectedSessionId) selectedCache = undefined;
    return selected ?? selectedCache;
  }
  function revealAndSelect(sessionId: string): void {
    selectionRequested = true;
    controller.setFilter("all");
    controller.setQuery("");
    controller.select(sessionId);
  }


  async function confirmClose(sessionId: string): Promise<void> {
    const session = state.sessions.find((candidate) => candidate.sessionId === sessionId) ?? paletteSessions.get(sessionId);
    if (!session) return;
    const confirmed = await confirmDialog.ask({
      title: `Close “${session.title}”?`,
      detail: "The Slack thread stays visible but stops accepting input.",
      confirmLabel: "Close thread",
      danger: true,
    });
    if (!confirmed) return;
    await controller.closeThread(sessionId).catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), true));
  }

  const palette = new CommandPalette({
    jump: revealAndSelect,
    stop: (sessionId) => void controller.stopTurn(sessionId).catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), true)),
    setModel: (sessionId, selector) => void controller.setModel(sessionId, selector).catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), true)),
    close: (sessionId) => void confirmClose(sessionId),
    refresh: () => void controller.refresh().then(() => showToast("Sync complete")).catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), true)),
    toggleTheme: () => {
      root.dataset.theme = root.dataset.theme === "slack" ? "codex" : "slack";
      showToast(`${root.dataset.theme === "slack" ? "Slack" : "Codex"} theme enabled`);
    },
  });
  root.append(palette.node);

  stopButton.onclick = () => {
    const session = selectedSession();
    if (session) void controller.stopTurn(session.sessionId).catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), true));
  };
  closeButton.onclick = () => {
    const session = selectedSession();
    if (session) void confirmClose(session.sessionId);
  };
  shortcutClose.onclick = () => { shortcutSheet.hidden = true; };
  shortcutSheet.onclick = (event) => {
    if (event.target === shortcutSheet) shortcutSheet.hidden = true;
  };

  function render(next: AppState): void {
    state = next;
    visibleSessions = filterSessions(state.sessions, state.filter, state.query);
    const selected = selectedSession();
    connectionDot.dataset.phase = state.connection.phase;
    const connectionTitle = state.connection.phase === "connecting" ? "Connecting to Slack" : state.connection.phase === "ready" ? `Connected · synced ${new Date(state.connection.lastSyncAt).toLocaleTimeString()}` : state.connection.message;
    connectionDot.title = connectionTitle;
    connectionDot.setAttribute("aria-label", connectionTitle);
    workspace.textContent = state.connection.phase === "ready" ? state.connection.team : "Slackoff Console";
    count.textContent = `${visibleSessions.length} session${visibleSessions.length === 1 ? "" : "s"}`;
    for (const [filter, button] of filterButtons) {
      const active = filter === state.filter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    if (!search.matches(":focus") && search.value !== state.query) search.value = state.query;

    sessionList.update(visibleSessions, state.selectedSessionId);
    for (const session of state.sessions) paletteSessions.set(session.sessionId, session);
    palette.update([...paletteSessions.values()], selected);
    sessionHeader.hidden = !selected;
    if (selected) {
      sessionTitle.textContent = selected.title;
      statusPill.textContent = statusLabel(selected.status, selected.activity);
      statusPill.dataset.status = selected.status;
      sessionMeta.replaceChildren(
        element("span", "session-header__project", { text: selected.project || "Unknown project" }),
        document.createTextNode(" · "),
        element("span", "session-header__id", { text: selected.sessionId.slice(0, 12) }),
      );
      const nextModelSignature = `${selected.sessionId}|${selected.models.map((model) => `${model.selector}:${model.name}`).join("|")}`;
      if (nextModelSignature !== modelSignature) {
        const providers = new Map<string, typeof selected.models>();
        for (const model of selected.models) {
          const existing = providers.get(model.provider);
          if (existing) existing.push(model);
          else providers.set(model.provider, [model]);
        }
        const options: Node[] = [
          element("option", "", { value: "", text: selected.models.length === 0 ? "Models unavailable" : "Unknown model", disabled: true }),
        ];
        for (const [provider, models] of providers) {
          const group = element("optgroup", "", { label: provider });
          for (const model of models) group.append(element("option", "", { value: model.selector, text: `${model.name} · ${model.id}` }));
          options.push(group);
        }
        modelSelect.replaceChildren(...options);
        modelSignature = nextModelSignature;
      }
      modelSelect.value = selected.model?.selector ?? "";
      modelSelect.disabled = !selected.controllable || selected.models.length === 0;
      modelSelect.title = `${modelLabel(selected.model)} · Use Command-K to search ${selected.models.length} models`;
      stopButton.disabled = selected.status !== "working" && selected.status !== "waiting";
      closeButton.disabled = selected.collapsed;
    } else {
      modelSignature = "";
    }
    transcript.update(selected, state.thread, selectionRequested);
    composer.update(selected);
    selectionRequested = false;
    if (state.notice && state.notice !== lastNotice) showToast(state.notice);
    lastNotice = state.notice;
  }

  const removeKeys = installKeys(root, {
    paletteOpen: () => palette.isOpen(),
    handlePaletteKey: (event) => palette.handleKey(event),
    togglePalette: () => palette.toggle(),
    moveSelection: (delta) => {
      if (visibleSessions.length === 0) return;
      const index = visibleSessions.findIndex((session) => session.sessionId === state.selectedSessionId);
      const nextIndex = index < 0 ? 0 : Math.max(0, Math.min(visibleSessions.length - 1, index + delta));
      const next = visibleSessions[nextIndex];
      if (next) {
        selectionRequested = true;
        controller.select(next.sessionId);
      }
    },
    focusComposer: () => composer.focus(),
    composerFocused: () => composer.isFocused(),
    blurComposer: () => composer.blur(),
    offerStop: () => {
      const session = selectedSession();
      if (!session || (session.status !== "working" && session.status !== "waiting")) return;
      void confirmDialog
        .ask({ title: `Stop the active turn in “${session.title}”?`, confirmLabel: "Stop turn", danger: true })
        .then((confirmed) => (confirmed ? controller.stopTurn(session.sessionId) : undefined))
        .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), true));
    },
    chooseQuestionOption: (index) => transcript.chooseNumber(index),
    jumpToAttention: () => {
      const session = state.attention[0];
      if (session) {
        revealAndSelect(session.sessionId);
      } else {
        showToast("No sessions need attention");
      }
    },
    toggleShortcuts: () => {
      shortcutSheet.hidden = !shortcutSheet.hidden;
      if (!shortcutSheet.hidden) shortcutClose.focus();
    },
  });

  const unsubscribe = controller.subscribe(render);
  render(state);
  controller.start();
  const relativeTimer = window.setInterval(() => sessionList.update(visibleSessions, state.selectedSessionId), 30_000);

  return () => {
    window.clearInterval(relativeTimer);
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
    removeKeys();
    unsubscribe();
    controller.stop();
    search.oninput = null;
    modelSelect.onchange = null;
    stopButton.onclick = null;
    closeButton.onclick = null;
    shortcutClose.onclick = null;
    shortcutSheet.onclick = null;
    for (const button of filterButtons.values()) button.onclick = null;
    sessionList.destroy();
    transcript.destroy();
    composer.destroy();
    palette.destroy();
    confirmDialog.destroy();
    shell.remove();
    if (!hadRootClass) root.classList.remove("slackoff-console");
    if (initialTheme === null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", initialTheme);
    if (initialTabIndex === null) root.removeAttribute("tabindex");
    else root.setAttribute("tabindex", initialTabIndex);
  };
};
