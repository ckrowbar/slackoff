import styles from "slackoff:styles";

import { createSlackController } from "./app/controller.js";
import type { Platform, SlackCredential, SlackParams } from "./platform.js";
import type { ConsoleDescription } from "./settings.js";
import { callSlack, discoverSlackoffChannel, findSlackoffChannel } from "./slack/api.js";
import { parseClientUrl, readCredentials } from "./slack/credentials.js";
import { DEFAULT_SETTINGS } from "./types.js";
import type { Controller, SessionView, StoredSettings } from "./types.js";
import { mountApp } from "./ui/app.js";

/**
 * Decides when the console belongs on screen and owns the single host element it adds to Slack.
 * Transport-free: an MV3 content script and a Tampermonkey userscript both drive this by handing it
 * a Platform.
 *
 * Reversibility is the constraint that shapes this file. The only change made to Slack's DOM is the
 * host element plus one `data-slackoff-hidden` attribute on the pane being covered; the rule that
 * acts on that attribute is adopted as a constructed stylesheet, so it adds no node of its own and
 * works in the userscript build, which has no page-level stylesheet. Tearing down removes the host,
 * the attribute and the sheet, drops every observer and timer, and calls the UI's own teardown.
 */

const POLL_INTERVAL_MS = 400;
const HOST_ID = "slackoff-console-host";
const ROOT_CLASS = "slackoff-console";
const HIDDEN_ATTRIBUTE = "data-slackoff-hidden";
const OVERLAY_Z_INDEX = "1000000";
/** Below this, a matched pane is treated as a mis-match and the console fills to the viewport. */
const MIN_USABLE_HEIGHT = 240;
const HIDDEN_RULE = `[${HIDDEN_ATTRIBUTE}]{visibility:hidden !important;}`;

/**
 * Slack exposes no stable hook for its layout, so these are best-effort and deliberately ordered
 * from most to least specific. Every one of them is fragile and may break on a Slack release; the
 * miss case is a full-viewport overlay inset past the sidebar, which is still usable.
 */
const PANE_SELECTORS = ['[data-qa="message_pane"]', ".p-workspace__primary_view"] as const;
const SIDEBAR_SELECTORS = [
  '[data-qa="workspace_sidebar"]',
  ".p-client_workspace__sidebar",
  ".p-tab_rail",
] as const;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The host element, its shadow root, and the geometry that keeps it over Slack's message pane. */
class ConsoleOverlay {
  readonly #host = document.createElement("div");
  readonly #root = document.createElement("div");
  readonly #shadow: ShadowRoot;
  readonly #hiddenSheet = new CSSStyleSheet();
  #pane: HTMLElement | undefined;
  #observer: ResizeObserver | undefined;
  #teardown: (() => void) | undefined;
  readonly #onWindowResize = (): void => this.#align();

  constructor() {
    this.#host.id = HOST_ID;
    this.#host.style.cssText = `position:fixed;top:0;left:0;width:0;height:0;z-index:${OVERLAY_Z_INDEX};`;
    // An open shadow root stops Slack's stylesheet reaching the console and vice versa.
    this.#shadow = this.#host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;
    this.#root.className = ROOT_CLASS;
    this.#shadow.append(style, this.#root);
    this.#hiddenSheet.replaceSync(HIDDEN_RULE);
  }

  mount(controller: Controller): void {
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.#hiddenSheet];
    document.body.append(this.#host);
    this.#capturePane();
    this.#align();
    window.addEventListener("resize", this.#onWindowResize, { passive: true });
    this.#teardown = mountApp(this.#root, controller);
  }

  /** Slack rebuilds its panes as the user navigates, so the tracked element is re-checked often. */
  refresh(): void {
    if (!this.#pane?.isConnected) this.#capturePane();
    this.#align();
  }

  destroy(): void {
    this.#teardown?.();
    this.#teardown = undefined;
    window.removeEventListener("resize", this.#onWindowResize);
    this.#releasePane();
    this.#host.remove();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => sheet !== this.#hiddenSheet,
    );
  }

  #capturePane(): void {
    this.#releasePane();

    let pane: HTMLElement | null = null;
    for (const selector of PANE_SELECTORS) {
      pane = document.querySelector<HTMLElement>(selector);
      if (pane) break;
    }
    if (!pane) return;

    pane.setAttribute(HIDDEN_ATTRIBUTE, "");
    this.#pane = pane;
    this.#observer = new ResizeObserver(() => this.#align());
    this.#observer.observe(pane);
  }

  #releasePane(): void {
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#pane?.removeAttribute(HIDDEN_ATTRIBUTE);
    this.#pane = undefined;
  }

  #align(): void {
    const rect = this.#pane?.getBoundingClientRect();
    const box: Box = rect && rect.width > 1 && rect.height > 1 ? this.#usableBox(rect) : this.#fallbackBox();
    const style = this.#host.style;
    style.top = `${Math.round(box.top)}px`;
    style.left = `${Math.round(box.left)}px`;
    style.width = `${Math.round(box.width)}px`;
    style.height = `${Math.round(box.height)}px`;
  }

  /**
   * A matched pane far shorter than the space below it means the selector found an inner wrapper
   * rather than the real message area, which Slack is free to restructure. Extend down to the
   * viewport bottom instead of rendering an unusable sliver. This is a no-op for a pane that
   * already reaches the bottom, so the normal case keeps the pane's exact geometry.
   */
  #usableBox(rect: Box): Box {
    const remaining = window.innerHeight - rect.top;
    if (rect.height >= Math.min(MIN_USABLE_HEIGHT, remaining)) return rect;
    return { top: rect.top, left: rect.left, width: rect.width, height: Math.max(rect.height, remaining) };
  }

  #fallbackBox(): Box {
    let left = 0;
    for (const selector of SIDEBAR_SELECTORS) {
      const sidebar = document.querySelector<HTMLElement>(selector);
      if (sidebar) left = Math.max(left, sidebar.getBoundingClientRect().right);
    }
    return { top: 0, left, width: Math.max(0, window.innerWidth - left), height: window.innerHeight };
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

  /**
   * The extension also binds this through chrome.commands. Chrome consumes a registered command key
   * itself and does not deliver it to the page, so only one of the two paths ever fires per press.
   */
  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== "KeyO" || !event.shiftKey || event.ctrlKey) return;
    if (!event.altKey && !event.metaKey) return;
    event.preventDefault();
    void this.toggleTakeover();
  };

  constructor(platform: Platform) {
    this.#platform = platform;
  }

  async start(): Promise<void> {
    this.#settings = await this.#platform.getSettings();
    this.#slackoffChannelId = this.#settings.channelId;
    this.#unsubscribeSettings = this.#platform.onSettingsChanged((settings) => {
      void this.#applySettings(settings);
    });
    document.addEventListener("keydown", this.#onKeyDown, true);
    // Slack is a single-page app whose navigations are not observable from here.
    this.#pollTimer = window.setInterval(() => this.#tick(), POLL_INTERVAL_MS);
    this.#tick();
  }

  stop(): void {
    if (this.#pollTimer !== undefined) window.clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    this.#unsubscribeSettings?.();
    this.#unsubscribeSettings = undefined;
    document.removeEventListener("keydown", this.#onKeyDown, true);
    this.#unmount();
  }

  /** Selects a session in the mounted console, for a notification click. */
  select(sessionId: string): void {
    this.#controller?.select(sessionId);
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
      if (!this.#settings.takeover || !channelId || !credential) {
        this.#unmount();
        return;
      }

      const isTarget = await this.#isSlackoffDm(credential, channelId);
      // Discovery is asynchronous; the user may have navigated on in the meantime.
      if (!isTarget || this.#channelId !== channelId || !this.#settings.takeover) {
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
    overlay.mount(controller);
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
      team: credential.teamName,
      now: () => Date.now(),
      setTimer: (callback: () => void, ms: number) => window.setTimeout(callback, ms),
      clearTimer: (id: number) => window.clearTimeout(id),
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
