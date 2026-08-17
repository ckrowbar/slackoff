import type { SessionLaunchRequest } from "../../../src/session-launch.js";
import { element } from "./dom.js";

export class SessionCreator {
  readonly node = element("div", "session-create", { role: "presentation" });
  #dialog = element("section", "session-create__dialog", {
    role: "dialog",
    ariaLabel: "Create a new session",
    "aria-modal": "true",
  });
  #form = element("form", "session-create__form");
  #name = element("input", "session-create__input", {
    type: "text",
    required: true,
    maxlength: 80,
    autocomplete: "off",
    placeholder: "review-api",
  });
  #cwd = element("input", "session-create__input", {
    type: "text",
    required: true,
    autocomplete: "off",
    placeholder: "~/src/project",
  });
  #prompt = element("textarea", "session-create__input session-create__prompt", {
    rows: 4,
    maxlength: 3000,
    placeholder: "Optional first instruction…",
  });
  #error = element("div", "session-create__error", { role: "alert" });
  #submit = element("button", "primary-button", { type: "submit", text: "Create session" });
  #cancel = element("button", "text-button", { type: "button", text: "Cancel" });
  #create: (request: SessionLaunchRequest) => Promise<void>;
  #busy = false;
  #restoreFocus: HTMLElement | undefined;

  constructor(create: (request: SessionLaunchRequest) => Promise<void>) {
    this.#create = create;
    const header = element("header", "session-create__header");
    const close = element("button", "icon-button", { type: "button", text: "×", ariaLabel: "Close" });
    header.append(element("h2", "session-create__title", { text: "Create a new session" }), close);
    const intro = element("p", "session-create__intro", {
      text: "Start OMP in a detached tmux session. Slackoff will connect it here automatically.",
    });
    const fields = element("div", "session-create__fields");
    fields.append(
      this.#field("Session name", this.#name),
      this.#field("Working directory", this.#cwd),
      this.#field("Initial prompt", this.#prompt, "Optional"),
    );
    const actions = element("footer", "session-create__actions");
    actions.append(this.#cancel, this.#submit);
    this.#form.append(intro, fields, this.#error, actions);
    this.#dialog.append(header, this.#form);
    this.node.append(this.#dialog);
    this.node.hidden = true;
    this.#error.hidden = true;

    close.onclick = () => this.close();
    this.#cancel.onclick = () => this.close();
    this.node.onclick = (event) => {
      if (event.target === this.node) this.close();
    };
    this.node.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        this.#dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      const root = this.node.getRootNode() as Document | ShadowRoot;
      const active = root.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    this.#form.onsubmit = (event) => {
      event.preventDefault();
      void this.#launch();
    };
  }

  open(): void {
    const root = this.node.getRootNode() as Document | ShadowRoot;
    this.#restoreFocus = root.activeElement instanceof HTMLElement ? root.activeElement : undefined;
    this.#error.hidden = true;
    this.#error.textContent = "";
    this.node.hidden = false;
    requestAnimationFrame(() => this.#name.focus());
  }

  close(): void {
    if (this.#busy) return;
    this.#hide();
  }

  destroy(): void {
    this.#form.onsubmit = null;
    this.node.onclick = null;
    this.node.onkeydown = null;
    this.#cancel.onclick = null;
    if (!this.node.hidden) this.#hide();
    this.node.remove();
  }

  #field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
    const field = element("label", "session-create__field");
    const caption = element("span", "session-create__label", { text: label });
    if (hint) caption.append(element("span", "session-create__hint", { text: hint }));
    field.append(caption, control);
    return field;
  }

  #hide(): void {
    this.node.hidden = true;
    this.#restoreFocus?.focus();
    this.#restoreFocus = undefined;
  }

  async #launch(): Promise<void> {
    if (this.#busy) return;
    const name = this.#name.value.trim();
    const cwd = this.#cwd.value.trim();
    const prompt = this.#prompt.value.trim();
    this.#name.setCustomValidity(name ? "" : "Enter a session name.");
    this.#cwd.setCustomValidity(cwd ? "" : "Enter a working directory.");
    if (!this.#form.reportValidity()) return;
    this.#busy = true;
    this.#submit.disabled = true;
    this.#cancel.disabled = true;
    this.#error.hidden = true;
    try {
      await this.#create({ name, cwd, ...(prompt ? { prompt } : {}) });
      this.#form.reset();
      this.#hide();
    } catch (error) {
      this.#error.textContent = error instanceof Error ? error.message : String(error);
      this.#error.hidden = false;
    } finally {
      this.#busy = false;
      this.#submit.disabled = false;
      this.#cancel.disabled = false;
    }
  }
}
