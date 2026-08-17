import { createExtensionPlatform } from "./platform/extension.js";
import { CONSOLE_DESCRIBE, parseConsoleDescription } from "./settings.js";
import type { ConsoleDescription } from "./settings.js";
import type { StoredSettings } from "./types.js";

/**
 * Options page. It runs on the extension origin, so it cannot see the Slack page's localStorage;
 * the workspace list comes from asking a live content script. Nothing here ever handles a token.
 */

const SLACK_TAB_MATCHES = ["https://app.slack.com/client/*", "https://*.slack.com/client/*"];
const STATUS_CLEAR_MS = 2000;

const workspaceList = requireElement<HTMLUListElement>("workspaces");
const channelLabel = requireElement<HTMLSpanElement>("channel");
const detectButton = requireElement<HTMLButtonElement>("detect");
const enabledInput = requireElement<HTMLInputElement>("enabled");
const notificationsInput = requireElement<HTMLInputElement>("notifications");
const takeoverInput = requireElement<HTMLInputElement>("takeover");
const themeSelect = requireElement<HTMLSelectElement>("theme");
const openTabButton = requireElement<HTMLButtonElement>("open-tab");
const statusLabel = requireElement<HTMLDivElement>("status");

let statusTimer: number | undefined;

enabledInput.addEventListener("change", () => {
  void save({ enabled: enabledInput.checked });
});

notificationsInput.addEventListener("change", () => {
  void save({ notifications: notificationsInput.checked });
});

takeoverInput.addEventListener("change", () => {
  void save({ takeover: takeoverInput.checked });
});

themeSelect.addEventListener("change", () => {
  const theme = themeSelect.value;
  void save({ theme: theme === "slack" || theme === "light" ? theme : "codex" });
});

detectButton.addEventListener("click", () => {
  void redetect();
});

openTabButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});

const platform = createExtensionPlatform();

platform.onSettingsChanged(() => {
  void render();
});

void render();

async function render(): Promise<void> {
  const settings = await platform.getSettings();
  enabledInput.checked = settings.enabled;
  notificationsInput.checked = settings.notifications;
  takeoverInput.checked = settings.takeover;
  themeSelect.value = settings.theme;

  const description = await describeConsole();
  renderWorkspaces(description?.workspaces ?? []);

  const channelId = settings.channelId ?? description?.slackoffChannelId;
  channelLabel.textContent = channelId
    ? `${channelId}${description?.mounted === true ? " · console mounted" : ""}`
    : description
      ? "Not detected yet. Open the Slackoff DM in Slack."
      : "No Slack tab open.";
}

function renderWorkspaces(workspaces: readonly { teamId: string; teamName: string }[]): void {
  workspaceList.replaceChildren();

  if (workspaces.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No signed-in workspace found. Open Slack in a tab and reload this page.";
    workspaceList.append(empty);
    return;
  }

  for (const workspace of workspaces) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = workspace.teamName;
    const id = document.createElement("code");
    id.textContent = workspace.teamId;
    row.append(name, id);
    workspaceList.append(row);
  }
}

/** Clearing the cached channel id is what makes the content script probe and discover again. */
async function redetect(): Promise<void> {
  await platform.setSettings({ channelId: "" });
  channelLabel.textContent = "Detecting…";
  showStatus("Detection cleared. Open the Slackoff DM in Slack.");
  await render();
}

async function describeConsole(): Promise<ConsoleDescription | undefined> {
  const tabs = await chrome.tabs.query({ url: SLACK_TAB_MATCHES });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    let response: unknown;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: CONSOLE_DESCRIBE });
    } catch {
      // No console in that tab; try the next one.
      continue;
    }
    const description = parseConsoleDescription((response as { data?: unknown } | undefined)?.data);
    if (description) return description;
  }
  return undefined;
}

async function save(patch: Partial<StoredSettings>): Promise<void> {
  await platform.setSettings(patch);
  showStatus("Saved");
}

function showStatus(message: string): void {
  statusLabel.textContent = message;
  if (statusTimer !== undefined) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusLabel.textContent = "";
    statusTimer = undefined;
  }, STATUS_CLEAR_MS);
}

function requireElement<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Options page is missing #${id}`);
  return found as T;
}
