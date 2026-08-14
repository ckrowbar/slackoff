import { element } from "./dom.js";

export interface ConfirmRequest {
  title: string;
  detail?: string;
  confirmLabel: string;
  danger?: boolean;
}

/**
 * In-console confirmation. Replaces window.confirm because the console runs inside Slack's page:
 * a native dialog blocks Slack's own main thread, is attributed to "app.slack.com", and resolves
 * to false without a prompt when the page has dialogs suppressed, which would silently drop a
 * Stop the user asked for.
 *
 * Keys are handled on this element so they settle here and never reach the global shortcut layer,
 * and focus returns to whatever held it before, so keyboard control survives a cancel.
 */
export class ConfirmDialog {
  readonly node: HTMLElement;
  readonly #dialog: HTMLElement;
  readonly #title: HTMLElement;
  readonly #detail: HTMLElement;
  readonly #confirm: HTMLButtonElement;
  readonly #cancel: HTMLButtonElement;
  #settle: ((confirmed: boolean) => void) | undefined;
  #restoreFocus: HTMLElement | undefined;

  constructor() {
    this.node = element("div", "confirm-layer", { role: "presentation" });
    this.node.hidden = true;
    this.#dialog = element("section", "confirm-layer__dialog", {
      role: "alertdialog",
      "aria-modal": "true",
    });
    this.#title = element("h2", "confirm-layer__title");
    this.#detail = element("p", "confirm-layer__detail");
    const actions = element("div", "confirm-layer__actions");
    this.#cancel = element("button", "text-button", { type: "button", text: "Cancel" });
    this.#confirm = element("button", "secondary-button", { type: "button" });
    actions.append(this.#cancel, this.#confirm);
    this.#dialog.append(this.#title, this.#detail, actions);
    this.node.append(this.#dialog);

    this.#cancel.onclick = () => this.#resolve(false);
    this.#confirm.onclick = () => this.#resolve(true);
    this.node.onclick = (event) => {
      if (event.target === this.node) this.#resolve(false);
    };
    this.node.addEventListener("keydown", (event) => {
      if (!this.open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.#resolve(false);
        return;
      }
      if (event.key === "Enter" && event.target !== this.#cancel) {
        event.preventDefault();
        event.stopPropagation();
        this.#resolve(true);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        (event.target === this.#confirm ? this.#cancel : this.#confirm).focus();
        return;
      }
      // Swallow everything else so the global shortcut layer stays inert while this is open.
      event.stopPropagation();
    });
  }

  get open(): boolean {
    return !this.node.hidden;
  }

  ask(request: ConfirmRequest): Promise<boolean> {
    this.#resolve(false);
    this.#title.textContent = request.title;
    this.#detail.textContent = request.detail ?? "";
    this.#detail.hidden = !request.detail;
    this.#confirm.textContent = request.confirmLabel;
    this.#confirm.classList.toggle("is-danger", request.danger === true);
    const active = this.node.getRootNode() as Document | ShadowRoot;
    this.#restoreFocus = active.activeElement instanceof HTMLElement ? active.activeElement : undefined;
    this.node.hidden = false;
    this.#confirm.focus();
    return new Promise<boolean>((resolve) => {
      this.#settle = resolve;
    });
  }

  destroy(): void {
    this.#resolve(false);
    this.#cancel.onclick = null;
    this.#confirm.onclick = null;
    this.node.onclick = null;
    this.node.remove();
  }

  #resolve(confirmed: boolean): void {
    const settle = this.#settle;
    this.#settle = undefined;
    if (!settle) return;
    this.node.hidden = true;
    settle(confirmed);
    this.#restoreFocus?.focus();
    this.#restoreFocus = undefined;
  }
}
