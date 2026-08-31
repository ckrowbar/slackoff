import slothIcon from "slackoff:icon";
import styles from "slackoff:styles";

import { createSlackController } from "./app/controller.js";
import type { Platform, SlackCredential, SlackParams } from "./platform.js";
import type { ConsoleDescription } from "./settings.js";
import {
  callSlack,
  discoverSlackoffChannel,
  findSlackoffChannel,
  uploadSlackImages,
} from "./slack/api.js";
import { parseClientUrl, readCredentials } from "./slack/credentials.js";
import { DEFAULT_SETTINGS } from "./types.js";
import type { AppPreferences, Controller, SessionView, StoredSettings } from "./types.js";
import { mountApp } from "./ui/app.js";

/**
 * Decides when the console belongs on screen and owns the single full-page host element it adds to
 * Slack. Transport-free: an MV3 content script and a Tampermonkey userscript both drive this by
 * handing it a Platform. Tearing down removes the host and favicon and stops the UI.
 */

const POLL_INTERVAL_MS = 400;
const HOST_ID = "slackoff-console-host";
const ROOT_CLASS = "slackoff-console";
const OVERLAY_Z_INDEX = "2147483647";
const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(slothIcon)}`;

/** Full-viewport host, isolated UI root, and active-state favicon. */
class ConsoleOverlay {
  readonly #host = document.createElement("div");
  readonly #root = document.createElement("div");
  readonly #shadow: ShadowRoot;
  readonly #favicon = document.createElement("link");
  #teardown: (() => void) | undefined;

  constructor() {
    this.#host.id = HOST_ID;
    this.#host.style.cssText =
      `position:fixed;inset:0;width:100vw;height:100vh;z-index:${OVERLAY_Z_INDEX};`;
    this.#shadow = this.#host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;
    this.#root.className = ROOT_CLASS;
    this.#favicon.rel = "icon";
    this.#favicon.type = "image/svg+xml";
    this.#favicon.href = FAVICON_HREF;
    this.#shadow.append(style, this.#root);
  }

  mount(controller: Controller, preferences: AppPreferences): void {
    this.#root.dataset.theme = preferences.theme;
    document.body.append(this.#host);
    document.head.append(this.#favicon);
    try {
      this.#teardown = mountApp(this.#root, controller, preferences);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#root.textContent = `Slackoff failed to start: ${message}`;
      throw error;
    }
  }

  setTheme(theme: StoredSettings["theme"]): void {
    this.#root.dataset.theme = theme;
  }

  refresh(): void {
    if (!this.#host.isConnected) document.body.append(this.#host);
    if (!this.#favicon.isConnected) document.head.append(this.#favicon);
  }

  destroy(): void {
    this.#teardown?.();
    this.#teardown = undefined;
    this.#favicon.remove();
    this.#host.remove();
  }
}

export class ConsoleShell {
  readonly #platform: Platform;
  #settings: StoredSettings = { ...DEFAULT_SETTINGS };
  #credentials: SlackCredential[] = [];
  #teamId: string | undefined;
  #channelId: string | undefined;
  #slackoffChannelId: string | undefined;
  #probed = new Set<string>();
  #discovered = false;
  #reconciling = false;
  #pollTimer: number | undefined;
  #unsubscribeSettings: (() => void) | undefined;
  #overlay: ConsoleOverlay | undefined;
  #controller: Controller | undefined;


  constructor(platform: Platform) {
    this.#platform = platform;
  }

  async start(): Promise<void> {
    this.#settings = await this.#platform.getSettings();
    this.#slackoffChannelId = this.#settings.channelId;
    this.#unsubscribeSettings = this.#platform.onSettingsChanged((settings) => {
      void this.#applySettings(settings);
    });
    // Slack is a single-page app whose navigations are not observable from here.
    this.#pollTimer = window.setInterval(() => this.#tick(), POLL_INTERVAL_MS);
    this.#tick();
  }

  stop(): void {
    if (this.#pollTimer !== undefined) window.clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    this.#unsubscribeSettings?.();
    this.#unsubscribeSettings = undefined;
    this.#unmount();
  }

  /** Selects a session in the mounted console, for a notification click. */
  select(sessionId: string): void {
    this.#controller?.select(sessionId);
  }

  async toggleEnabled(): Promise<void> {
    await this.#platform.setSettings({ enabled: !this.#settings.enabled });
  }

  async toggleTakeover(): Promise<void> {
    await this.#platform.setSettings({ takeover: !this.#settings.takeover });
  }

  async toggleNotifications(): Promise<void> {
    await this.#platform.setSettings({ notifications: !this.#settings.notifications });
  }

  /** Forgets the cached channel id so the next reconcile probes and discovers again. */
  async redetect(): Promise<void> {
    await this.#platform.setSettings({ channelId: "" });
  }

  describe(): ConsoleDescription {
    if (this.#credentials.length === 0) this.#credentials = readCredentials();
    return {
      workspaces: this.#credentials.map((credential) => ({
        teamId: credential.teamId,
        teamName: credential.teamName,
      })),
      ...(this.#channelId ? { currentChannelId: this.#channelId } : {}),
      ...(this.#slackoffChannelId ? { slackoffChannelId: this.#slackoffChannelId } : {}),
      mounted: this.#overlay !== undefined,
    };
  }

  #tick(): void {
    const { teamId, channelId } = parseClientUrl(location.href);
    const moved = teamId !== this.#teamId || channelId !== this.#channelId;
    if (teamId !== this.#teamId) this.#credentials = [];
    this.#teamId = teamId;
    this.#channelId = channelId;

    if (moved) void this.#reconcile();
    else this.#overlay?.refresh();
  }

  async #reconcile(): Promise<void> {
    if (this.#reconciling) return;
    this.#reconciling = true;
    try {
      const channelId = this.#channelId;
      const credential = this.#credential();
      if (!this.#settings.enabled || !this.#settings.takeover || !channelId || !credential) {
        this.#unmount();
        return;
      }

      const isTarget = await this.#isSlackoffDm(credential, channelId);
      // Discovery is asynchronous; the user may have navigated on in the meantime.
      if (!isTarget || this.#channelId !== channelId || !this.#settings.enabled || !this.#settings.takeover) {
        this.#unmount();
        return;
      }
      this.#mount(credential, channelId);
    } finally {
      this.#reconciling = false;
    }
  }

  async #isSlackoffDm(credential: SlackCredential, channelId: string): Promise<boolean> {
    if (this.#slackoffChannelId) return this.#slackoffChannelId === channelId;

    // Cheapest first: the channel already on screen may be the DM.
    if (!this.#probed.has(channelId)) {
      this.#probed.add(channelId);
      if (await findSlackoffChannel(this.#platform, credential, [channelId])) {
        await this.#rememberChannel(credential, channelId);
        return true;
      }
    }

    if (!this.#discovered) {
      this.#discovered = true;
      const found = await discoverSlackoffChannel(this.#platform, credential);
      if (found) {
        await this.#rememberChannel(credential, found);
        return found === channelId;
      }
    }
    return false;
  }

  /** Persists the channel id and API origin. The session token never leaves memory. */
  async #rememberChannel(credential: SlackCredential, channelId: string): Promise<void> {
    this.#slackoffChannelId = channelId;
    await this.#platform.setSettings({
      channelId,
      origin: credential.origin,
      ...(credential.userId ? { userId: credential.userId } : {}),
    });
  }

  async #applySettings(settings: StoredSettings): Promise<void> {
    const previous = this.#settings;
    this.#settings = settings;

    if (settings.channelId !== previous.channelId) {
      this.#slackoffChannelId = settings.channelId;
      // A cleared cache is a request for a fresh detection.
      if (!settings.channelId) {
        this.#probed.clear();
        this.#discovered = false;
      }
    }
    this.#overlay?.setTheme(settings.theme);
    await this.#reconcile();
  }

  #credential(): SlackCredential | undefined {
    if (this.#credentials.length === 0) this.#credentials = readCredentials();
    return this.#credentials[0];
  }

  #mount(credential: SlackCredential, channelId: string): void {
    if (this.#overlay) {
      this.#overlay.refresh();
      return;
    }

    const controller = this.#createController(credential, channelId);
    const overlay = new ConsoleOverlay();
    overlay.mount(controller, {
      theme: this.#settings.theme,
      sidebarWidth: this.#settings.sidebarWidth,
      sidebarCollapsed: this.#settings.sidebarCollapsed,
      setTheme: (theme) => this.#platform.setSettings({ theme }),
      setSidebar: (sidebarWidth, sidebarCollapsed) =>
        this.#platform.setSettings({ sidebarWidth, sidebarCollapsed }),
    });
    controller.start();
    this.#overlay = overlay;
    this.#controller = controller;
  }

  #unmount(): void {
    this.#controller?.stop();
    this.#controller = undefined;
    this.#overlay?.destroy();
    this.#overlay = undefined;
  }

  #createController(credential: SlackCredential, channelId: string): Controller {
    let instance: Controller | undefined;

    const controller = createSlackController({
      call: <T>(method: string, params: SlackParams): Promise<T> =>
        callSlack<T>(this.#platform, credential, method, params),
      channelId,
      closedBindings: this.#settings.closedBindings,
      saveClosedBindings: (closedBindings) =>
        this.#platform.setSettings({ closedBindings: [...closedBindings] }),
      team: credential.teamName,
      now: () => Date.now(),
      setTimer: (callback: () => void, ms: number) => window.setTimeout(callback, ms),
      clearTimer: (id: number) => window.clearTimeout(id),
      uploadImages: (threadTs, text, images) =>
        uploadSlackImages(this.#platform, credential, {
          channelId,
          threadTs,
          text,
          images,
        }),
      isVisible: () => document.visibilityState === "visible",
      onNotify: (session: SessionView) => {
        if (this.#settings.notifications) {
          this.#platform.notify(
            session.sessionId,
            session.title,
            session.activity || "Waiting for you",
          );
        }
        this.#platform.setBadge(instance?.getState().attention.length ?? 0);
      },
    });

    instance = controller;
    return controller;
  }
}
