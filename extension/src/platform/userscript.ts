import { encodeSlackBody, interpretSlackReply, slackCallError } from "../platform.js";
import type { Platform, SlackCredential, SlackParams } from "../platform.js";
import { parseSettings } from "../settings.js";
import type { StoredSettings } from "../types.js";

/**
 * Tampermonkey transport, for hosts where an unpacked extension cannot be loaded. No chrome API is
 * touched anywhere in this file.
 *
 * Browser globals are reached through a structurally typed view of `globalThis` rather than the DOM
 * lib. That keeps the module loadable and stubbable from a plain Node test, and it is also the
 * honest shape of a userscript sandbox, where very little is guaranteed to exist.
 */

export const USERSCRIPT_SETTINGS_KEY = "slackoff-console:settings";

/**
 * Under `@grant` the GM_* names are bindings in the script's sandbox scope, not properties of
 * globalThis, so they must be probed with `typeof` and never with optional call syntax: an optional
 * call on an undeclared binding still throws a ReferenceError.
 */
declare const GM_getValue: ((key: string, fallback?: string) => unknown) | undefined;
declare const GM_setValue: ((key: string, value: string) => void) | undefined;
declare const GM_registerMenuCommand: ((label: string, run: () => void) => void) | undefined;
declare const GM_notification:
  | ((details: { title: string; text: string; tag?: string; silent?: boolean }) => void)
  | undefined;
declare const GM_xmlhttpRequest: GmRequestFn | undefined;

interface GmResponse {
  status: number;
  responseHeaders: string;
  responseText: string;
}

type GmRequestFn = (details: {
  method: string;
  url: string;
  headers: Record<string, string>;
  data: string | ArrayBuffer;
  anonymous?: boolean;
  redirect?: "error";
  timeout?: number;
  onload: (response: GmResponse) => void;
  onerror: () => void;
  ontimeout: () => void;
}) => void;

interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

interface NotificationLike {
  permission: string;
  new (title: string, options: { body: string; tag: string }): unknown;
}

interface UserscriptGlobals {
  location?: { origin: string };
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  Notification?: NotificationLike;
  fetch?: (
    url: string,
    init: { method: string; credentials: "include" | "omit"; headers: Record<string, string>; body: string | ArrayBuffer; redirect?: "error" },
  ) => Promise<HttpResponseLike>;
  addEventListener?: (type: string, listener: (event: { key?: string | null }) => void) => void;
  removeEventListener?: (type: string, listener: (event: { key?: string | null }) => void) => void;
}

interface RawReply {
  status: number;
  retryAfter: string | null;
  body: string;
}

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" };

const host = globalThis as unknown as UserscriptGlobals;

export function createUserscriptPlatform(): Platform {
  const listeners = new Set<(settings: StoredSettings) => void>();

  return {
    async call<T>(credential: SlackCredential, method: string, params: SlackParams): Promise<T> {
      const body = encodeSlackBody(params, credential.token);
      const sameOrigin = host.location?.origin === credential.origin;
      const url = sameOrigin ? `/api/${method}` : `https://slack.com/api/${method}`;

      let reply: RawReply;
      if (sameOrigin) {
        reply = await fetchReply(url, body, "network_error");
      } else if (typeof GM_xmlhttpRequest === "function") {
        reply = await grantedReply(GM_xmlhttpRequest, url, body);
      } else {
        reply = await fetchReply(url, body, missingGrantMessage(credential.origin));
      }

      const result = interpretSlackReply(reply.status, reply.retryAfter, reply.body);
      if (!result.ok) throw slackCallError(result.failure);
      return result.payload as T;
    },

    async upload(url, bytes, contentType): Promise<void> {
      if (!isTrustedUploadUrl(url)) throw new Error("invalid_upload_url");
      let status: number;
      try {
        if (typeof GM_xmlhttpRequest === "function") {
          status = await grantedUpload(GM_xmlhttpRequest, url, bytes, contentType);
        } else {
          const request = host.fetch;
          if (!request) throw new Error("no_transport");
          const response = await request(url, {
            method: "POST",
            credentials: "omit",
            headers: { "Content-Type": contentType },
            redirect: "error",
            body: bytes,
          });
          status = response.status;
        }
      } catch {
        throw new Error("upload_failed");
      }
      if (status < 200 || status >= 300) throw new Error("upload_failed");
    },

    async getSettings(): Promise<StoredSettings> {
      return parseSettings(readStored());
    },

    async setSettings(patch: Partial<StoredSettings>): Promise<void> {
      const next = parseSettings({ ...parseSettings(readStored()), ...patch });
      writeStored(next);
      for (const listener of listeners) listener(next);
    },

    onSettingsChanged(listener: (settings: StoredSettings) => void): () => void {
      listeners.add(listener);

      // Another tab writing the localStorage blob is the only change this process cannot see.
      const onStorage = (event: { key?: string | null }): void => {
        if (event.key === USERSCRIPT_SETTINGS_KEY) listener(parseSettings(readStored()));
      };
      host.addEventListener?.("storage", onStorage);

      return () => {
        listeners.delete(listener);
        host.removeEventListener?.("storage", onStorage);
      };
    },

    notify(sessionId: string, title: string, body: string): void {
      if (typeof GM_notification === "function") {
        GM_notification({ title, text: body, tag: sessionId, silent: false });
        return;
      }
      // Only ever used when permission is already granted; asking for it on load would be rude.
      const notification = host.Notification;
      if (notification && notification.permission === "granted") {
        new notification(title, { body, tag: sessionId });
      }
    },

    setBadge(): void {
      // No toolbar in this mode. The console's own inbox already shows the attention count.
    },

    registerCommand(label: string, run: () => void): void {
      if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand(label, run);
    },
  };
}

function readStored(): unknown {
  if (typeof GM_getValue === "function") {
    const stored = GM_getValue(USERSCRIPT_SETTINGS_KEY, "");
    // Tampermonkey round-trips structured values, so it may hand back an object already.
    return typeof stored === "string" ? decode(stored) : stored;
  }
  return decode(host.localStorage?.getItem(USERSCRIPT_SETTINGS_KEY) ?? "");
}

function writeStored(settings: StoredSettings): void {
  const serialised = JSON.stringify(settings);
  if (typeof GM_setValue === "function") {
    GM_setValue(USERSCRIPT_SETTINGS_KEY, serialised);
    return;
  }
  host.localStorage?.setItem(USERSCRIPT_SETTINGS_KEY, serialised);
}

function decode(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function fetchReply(url: string, body: string, failureCode: string): Promise<RawReply> {
  const request = host.fetch;
  if (!request) throw slackCallError({ error: "no_transport" });

  let response: HttpResponseLike;
  try {
    response = await request(url, {
      method: "POST",
      credentials: "include",
      headers: FORM_HEADERS,
      body,
    });
  } catch {
    // The caught error can quote the request, which carries the token, so it is never surfaced.
    throw slackCallError({ error: failureCode });
  }

  return {
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
    body: await response.text(),
  };
}

function grantedReply(request: GmRequestFn, url: string, body: string): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    request({
      method: "POST",
      url,
      headers: FORM_HEADERS,
      data: body,
      timeout: 15_000,
      onload: (response) =>
        resolve({
          status: response.status,
          retryAfter: readHeader(response.responseHeaders, "retry-after"),
          body: response.responseText,
        }),
      onerror: () => reject(slackCallError({ error: "network_error" })),
      ontimeout: () => reject(slackCallError({ error: "timeout" })),
    });
  });
}

function grantedUpload(
  request: GmRequestFn,
  url: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  request({
    method: "POST",
    url,
    headers: { "Content-Type": contentType },
    data: bytes,
    anonymous: true,
    redirect: "error",
    onload: (response) => resolve(response.status),
    onerror: () => reject(new Error("upload_failed")),
    ontimeout: () => reject(new Error("upload_failed")),
  });
  return promise;
}

function isTrustedUploadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && (hostname === "slack.com" || hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}

/** GM_xmlhttpRequest hands back headers as one raw block rather than a parsed map. */
function readHeader(rawHeaders: string, name: string): string | null {
  for (const line of (rawHeaders ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim().toLowerCase() === name) {
      return line.slice(separator + 1).trim();
    }
  }
  return null;
}

function missingGrantMessage(origin: string): string {
  let hostname = origin;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    // Keep the origin verbatim when it is not a parseable URL.
  }
  return `cross_origin_blocked: add "@connect ${hostname}" to the userscript metadata, or use a manager that provides GM_xmlhttpRequest`;
}
