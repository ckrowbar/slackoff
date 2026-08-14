import { encodeSlackBody, interpretSlackReply } from "./platform.js";
import { DEFAULT_SETTINGS } from "./types.js";
import type { BackgroundRequest, BackgroundResponse, SlackCallRequest } from "./types.js";

/**
 * Service worker. It owns the only network access in the extension, because a content script
 * cannot fetch a sibling *.slack.com origin, and it owns the pieces of Chrome that a content
 * script has no reach into: notifications, the toolbar badge, and tab focus.
 *
 * Tokens pass through this file inside request bodies. Nothing here logs a request body, a token,
 * or a URL-encoded payload.
 */

const SLACK_TAB_MATCHES = ["https://app.slack.com/client/*", "https://*.slack.com/client/*"];
const BADGE_COLOUR = "#d95f2b";

/** Chrome rejects a basic notification without an icon, and the extension ships no image files. */
const NOTIFICATION_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAmElEQVR42u3ayw2AMAwE0fRDUdRNNVABSiAfezdjifu8G9iUwhjNdR53yyMZnQ7TGx4GGR2+FDI7fhpiVfgUSFT8EER0fDdCGpAl/hciW/xnhDQga3wzQhqQPb6KABAJUIl/RQAAAAAAAADSAN6FAGzyTeD/SclWgt2Q4XZu3+Wu/Hrd4sBhcWKyOfJZnFltDt02vxownfMAtoQ5wzWrbM0AAAAASUVORK5CYII=";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleRequest(message as BackgroundRequest).then(
    (response) => sendResponse(response),
    (error: unknown) => sendResponse({ ok: false, error: describeFailure(error) }),
  );
  // Keeps the message channel open for the async reply above.
  return true;
});

chrome.action.onClicked.addListener(() => {
  void toggleTakeover();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-takeover") void toggleTakeover();
});

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId);
  void focusSession(notificationId);
});

async function handleRequest(request: BackgroundRequest): Promise<BackgroundResponse> {
  switch (request?.type) {
    case "slack.call":
      return await callSlack(request);

    case "notify":
      chrome.notifications.create(request.sessionId, {
        type: "basic",
        iconUrl: NOTIFICATION_ICON,
        title: request.title,
        message: request.body,
        silent: false,
      });
      return { ok: true, data: undefined };

    case "badge":
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOUR });
      await chrome.action.setBadgeText({ text: request.count > 0 ? String(request.count) : "" });
      return { ok: true, data: undefined };

    case "focus":
      return { ok: true, data: await focusSession(request.sessionId) };

    default:
      return { ok: false, error: "unknown_request" };
  }
}

async function callSlack(request: SlackCallRequest): Promise<BackgroundResponse> {
  let response: Response;
  try {
    response = await fetch(`${request.origin}/api/${encodeURIComponent(request.method)}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: encodeSlackBody(request.params, request.token),
    });
  } catch {
    // The caught error can quote the request, which carries the token, so it is never surfaced.
    return { ok: false, error: "network_error" };
  }

  const reply = interpretSlackReply(
    response.status,
    response.headers.get("Retry-After"),
    await response.text().catch(() => ""),
  );
  return reply.ok ? { ok: true, data: reply.payload } : { ok: false, ...reply.failure };
}

/** Brings a Slack tab forward and asks its console to select the session. */
async function focusSession(sessionId: string): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ url: SLACK_TAB_MATCHES });
  if (!tab?.id) return false;

  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "focus", sessionId });
  } catch {
    // The tab may not have a console mounted; focusing it is still the useful half.
  }
  return true;
}

/**
 * Flipping the stored flag is the broadcast: every content script and the options page observe it
 * through chrome.storage.onChanged, so no second channel is needed.
 */
async function toggleTakeover(): Promise<void> {
  const stored = await chrome.storage.local.get("takeover");
  const current = typeof stored.takeover === "boolean" ? stored.takeover : DEFAULT_SETTINGS.takeover;
  await chrome.storage.local.set({ takeover: !current });
}

function describeFailure(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "background_error";
}
