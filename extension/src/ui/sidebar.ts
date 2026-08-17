import { element } from "./dom.js";

const MIN_WIDTH = 220;
const MAX_WIDTH = 560;
const MIN_MAIN_WIDTH = 360;
const WIDTH_STEP = 16;

interface SidebarLayoutOptions {
  width: number;
  collapsed: boolean;
  save(width: number, collapsed: boolean): Promise<void>;
  reportError(message: string): void;
}

/** Owns the session sidebar's persisted width, collapse button, and accessible resize handle. */
export class SidebarLayout {
  readonly toggleButton = element("button", "icon-button sidebar-toggle", {
    type: "button",
    text: "☰",
  });
  readonly resizer = element("div", "sidebar-resizer", {
    role: "separator",
    tabindex: "0",
    "aria-orientation": "vertical",
    ariaLabel: "Resize session sidebar",
  });

  readonly #root: HTMLElement;
  readonly #body: HTMLElement;
  readonly #save: SidebarLayoutOptions["save"];
  readonly #reportError: SidebarLayoutOptions["reportError"];
  readonly #resizeObserver: ResizeObserver;
  #width: number;
  #collapsed: boolean;
  #pointerId: number | undefined;

  constructor(root: HTMLElement, body: HTMLElement, rail: HTMLElement, options: SidebarLayoutOptions) {
    this.#root = root;
    this.#body = body;
    this.#save = options.save;
    this.#reportError = options.reportError;
    this.#width = this.#clamp(options.width);
    this.#collapsed = options.collapsed;

    rail.id = "slackoff-session-sidebar";
    this.toggleButton.setAttribute("aria-controls", rail.id);
    this.toggleButton.onclick = this.#toggle;
    this.resizer.onpointerdown = this.#startResize;
    this.resizer.onpointermove = this.#resize;
    this.resizer.onpointerup = this.#finishResize;
    this.resizer.onpointercancel = this.#finishResize;
    this.resizer.onkeydown = this.#resizeWithKeyboard;

    this.#resizeObserver = new ResizeObserver(() => this.#apply());
    this.#resizeObserver.observe(body);
    this.#apply();
  }

  destroy(): void {
    this.#resizeObserver.disconnect();
    this.#root.classList.remove("is-sidebar-resizing");
    this.toggleButton.onclick = null;
    this.resizer.onpointerdown = null;
    this.resizer.onpointermove = null;
    this.resizer.onpointerup = null;
    this.resizer.onpointercancel = null;
    this.resizer.onkeydown = null;
  }

  readonly #toggle = (): void => {
    this.#collapsed = !this.#collapsed;
    this.#apply();
    this.#persist();
  };

  readonly #startResize = (event: PointerEvent): void => {
    if (event.button !== 0 || this.#collapsed) return;
    event.preventDefault();
    this.#pointerId = event.pointerId;
    this.resizer.setPointerCapture(event.pointerId);
    this.#root.classList.add("is-sidebar-resizing");
  };

  readonly #resize = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return;
    this.#width = this.#clamp(event.clientX - this.#body.getBoundingClientRect().left);
    this.#apply();
  };

  readonly #finishResize = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return;
    if (this.resizer.hasPointerCapture(event.pointerId)) this.resizer.releasePointerCapture(event.pointerId);
    this.#pointerId = undefined;
    this.#root.classList.remove("is-sidebar-resizing");
    this.#persist();
  };

  readonly #resizeWithKeyboard = (event: KeyboardEvent): void => {
    if (this.#collapsed) return;
    let width: number | undefined;
    if (event.key === "ArrowLeft") width = this.#width - WIDTH_STEP;
    else if (event.key === "ArrowRight") width = this.#width + WIDTH_STEP;
    else if (event.key === "Home") width = MIN_WIDTH;
    else if (event.key === "End") width = this.#maxWidth();
    if (width === undefined) return;

    event.preventDefault();
    this.#width = this.#clamp(width);
    this.#apply();
    this.#persist();
  };

  #apply(): void {
    const visibleWidth = this.#clamp(this.#width);
    this.#root.style.setProperty("--so-sidebar-width", `${visibleWidth}px`);
    this.#root.classList.toggle("is-sidebar-collapsed", this.#collapsed);

    const toggleLabel = this.#collapsed ? "Show session sidebar" : "Hide session sidebar";
    this.toggleButton.title = toggleLabel;
    this.toggleButton.setAttribute("aria-label", toggleLabel);
    this.toggleButton.setAttribute("aria-expanded", String(!this.#collapsed));

    this.resizer.hidden = this.#collapsed;
    this.resizer.setAttribute("aria-valuemin", String(MIN_WIDTH));
    this.resizer.setAttribute("aria-valuemax", String(this.#maxWidth()));
    this.resizer.setAttribute("aria-valuenow", String(visibleWidth));
  }

  #clamp(width: number): number {
    return Math.round(Math.max(MIN_WIDTH, Math.min(this.#maxWidth(), width)));
  }

  #maxWidth(): number {
    const bodyWidth = this.#body.getBoundingClientRect().width;
    if (bodyWidth <= 0) return MAX_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(bodyWidth - MIN_MAIN_WIDTH)));
  }

  #persist(): void {
    void this.#save(this.#width, this.#collapsed).catch((error: unknown) => {
      this.#reportError(error instanceof Error ? error.message : String(error));
    });
  }
}
