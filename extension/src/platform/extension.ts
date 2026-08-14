import { parseSettings, SETTINGS_KEYS } from "../settings.js";
import type { Platform, SlackCredential, SlackParams } from "../platform.js";
import type { BackgroundRequest, BackgroundResponse, SlackCallRequest, StoredSettings } from "../types.js";

/**
 * MV3 transport. Network goes through the service worker, because a content script cannot fetch a
 * sibling *.slack.com origin while an extension fetch backed by host permissions can. Notifications
 * and the toolbar badge live there too, since a content script has no reach into either.
 */
export function createExtensionPlatform(): Platform {
  const getSettings = async (): Promise<StoredSettings> =>
    parseSettings(await chrome.storage.local.get([...SETTINGS_KEYS]));

  const send = (request: BackgroundRequest): void => {
    void chrome.runtime.sendMessage(request).catch(() => undefined);
  };

  return {
    async call<T>(credential: SlackCredential, method: string, params: SlackParams): Promise<T> {
      const request: SlackCallRequest = {
        type: "slack.call",
        origin: credential.origin,
        method,
        token: credential.token,
        params,
      };

      const response = (await chrome.runtime.sendMessage(request)) as BackgroundResponse<T> | undefined;
      if (!response) throw new Error("background_unavailable");
      if (response.ok) return response.data;

      const error = new Error(response.error) as Error & { status?: number; retryAfterMs?: number };
      if (response.status !== undefined) error.status = response.status;
      if (response.retryAfterMs !== undefined) error.retryAfterMs = response.retryAfterMs;
      throw error;
    },

    getSettings,

    async setSettings(patch: Partial<StoredSettings>): Promise<void> {
      await chrome.storage.local.set(patch);
    },

    onSettingsChanged(listener: (settings: StoredSettings) => void): () => void {
      const onChanged = (
        changes: Record<string, chrome.storage.StorageChange>,
        area: string,
      ): void => {
        if (area !== "local" || !SETTINGS_KEYS.some((key) => key in changes)) return;
        void getSettings().then(listener);
      };

      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    },

    notify(sessionId: string, title: string, body: string): void {
      send({ type: "notify", sessionId, title, body });
    },

    setBadge(count: number): void {
      send({ type: "badge", count });
    },

    registerCommand(): void {
      // chrome.commands already publishes the hotkey, and there is no other menu surface.
    },
  };
}
