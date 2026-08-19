import { element } from "./dom.js";

export type ConfirmResult = "confirm" | "alternative" | "cancel";
export interface ConfirmRequest {
  title: string;
  detail?: string;
  confirmLabel: string;
  danger?: boolean;
  alternativeLabel?: string;
  alternativeDanger?: boolean;
}

/**
 * In-console confirmation. Replaces window.confirm because the console runs inside Slack's page:
 * a native dialog blocks Slack's own main thread, is attributed to "app.slack.com", and resolves
 * to false without a prompt when the page has dialogs suppressed, which would silently drop an
 * action the user asked for.
 *
 * Keys are handled on this element so they settle here and never reach Slack, and focus returns to
 * whatever held it before so keyboard control survives a cancel.
 */
export class ConfirmDialog {
  readonly node: HTMLElement;
  readonly #dialog: HTMLElement;
  readonly #title: HTMLElement;
  readonly #detail: HTMLElement;
  readonly #confirm: HTMLButtonElement;
  readonly #alternative: HTMLButtonElement;
  readonly #cancel: HTMLButtonElement;
  #settle: ((result: ConfirmResult) => void) | undefined;
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
    this.#alternative = element("button", "secondary-button", { type: "button" });
    this.#alternative.hidden = true;
    this.#confirm = element("button", "secondary-button", { type: "button" });
    actions.append(this.#cancel, this.#alternative, this.#confirm);
    this.#dialog.append(this.#title, this.#detail, actions);
    this.node.append(this.#dialog);

    this.#cancel.onclick = () => this.#resolve("cancel");
    this.#alternative.onclick = () => this.#resolve("alternative");
    this.#confirm.onclick = () => this.#resolve("confirm");
    this.node.onclick = (event) => {
      if (event.target === this.node) this.#resolve("cancel");
    };
    this.node.addEventListener("keydown", (event) => {
      if (!this.open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.#resolve("cancel");
        return;
      }
      if (event.key === "Enter" && event.target !== this.#cancel) {
        event.preventDefault();
        event.stopPropagation();
        this.#resolve(event.target === this.#alternative ? "alternative" : "confirm");
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const buttons = [this.#cancel, ...(this.#alternative.hidden ? [] : [this.#alternative]), this.#confirm];
        const index = Math.max(0, buttons.indexOf(event.target as HTMLButtonElement));
        buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
        return;
      }
      // Swallow everything else so Slack cannot react while this dialog is open.
      event.stopPropagation();
    });
  }

  get open(): boolean {
    return !this.node.hidden;
  }

  ask(request: ConfirmRequest): Promise<ConfirmResult> {
    this.#resolve("cancel");
    this.#title.textContent = request.title;
    this.#detail.textContent = request.detail ?? "";
    this.#detail.hidden = !request.detail;
    this.#confirm.textContent = request.confirmLabel;
    this.#confirm.classList.toggle("is-danger", request.danger === true);
    this.#alternative.textContent = request.alternativeLabel ?? "";
    this.#alternative.hidden = !request.alternativeLabel;
    this.#alternative.classList.toggle("is-danger", request.alternativeDanger === true);
    const active = this.node.getRootNode() as Document | ShadowRoot;
    this.#restoreFocus = active.activeElement instanceof HTMLElement ? active.activeElement : undefined;
    this.node.hidden = false;
    this.#confirm.focus();
    return new Promise<ConfirmResult>((resolve) => {
      this.#settle = resolve;
    });
  }

  destroy(): void {
    this.#resolve(false);
    this.#cancel.onclick = null;
    this.#confirm.onclick = null;
    this.#alternative.onclick = null;
    this.node.onclick = null;
    this.node.remove();
  }

  #resolve(result: ConfirmResult): void {
    const settle = this.#settle;
    this.#settle = undefined;
    if (!settle) return;
    this.node.hidden = true;
    settle(result);
    this.#restoreFocus?.focus();
    this.#restoreFocus = undefined;
  }
}
