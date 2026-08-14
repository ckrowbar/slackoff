import { ConsoleShell } from "./mount.js";
import { createExtensionPlatform } from "./platform/extension.js";
import { CONSOLE_DESCRIBE } from "./settings.js";

/**
 * MV3 content-script entry. Everything that decides when and where the console renders lives in
 * mount.ts; this file only supplies the extension transport and answers the two messages that no
 * other host has: a notification click asking to focus a session, and the options page asking what
 * this tab can see.
 */

const shell = new ConsoleShell(createExtensionPlatform());

const onRuntimeMessage = (
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const request = message as { type?: unknown; sessionId?: unknown };

  if (request.type === "focus" && typeof request.sessionId === "string") {
    shell.select(request.sessionId);
    sendResponse({ ok: true, data: undefined });
    return undefined;
  }

  if (request.type === CONSOLE_DESCRIBE) {
    sendResponse({ ok: true, data: shell.describe() });
  }
  return undefined;
};

chrome.runtime.onMessage.addListener(onRuntimeMessage);
void shell.start();

window.addEventListener("pagehide", () => {
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  shell.stop();
});
