import type { SessionView } from "../types.js";
import { element } from "./dom.js";

export class Composer {
  readonly node = element("div", "composer");
  readonly textarea = element("textarea", "composer__input", {
    rows: 1,
    placeholder: "Send an instruction…",
    ariaLabel: "Instruction for the agent",
  });
  #counter = element("span", "composer__counter", { text: "0 / 2800" });
  #reason = element("span", "composer__reason");
  #sendButton = element("button", "primary-button composer__send", { type: "button", text: "Send" });
  #session: SessionView | undefined;
  #send: (sessionId: string, text: string) => Promise<void>;
  #toast: (message: string, error?: boolean) => void;
  #sending = false;

  constructor(send: (sessionId: string, text: string) => Promise<void>, toast: (message: string, error?: boolean) => void) {
    this.#send = send;
    this.#toast = toast;
    const frame = element("div", "composer__frame");
    const footer = element("div", "composer__footer");
    footer.append(this.#reason, this.#counter, this.#sendButton);
    frame.append(this.textarea, footer);
    this.node.append(frame);
    this.textarea.oninput = () => {
      this.#resize();
      this.#updateCounter();
      this.#updateDisabled();
    };
    this.textarea.onkeydown = (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void this.submit();
    };
    this.#sendButton.onclick = () => void this.submit();
  }

  update(session: SessionView | undefined): void {
    this.#session = session;
    const disabled = !session?.controllable;
    this.textarea.disabled = disabled;
    this.textarea.placeholder = disabled ? this.#disabledReason(session) : "Send an instruction…";
    this.#reason.textContent = disabled ? this.#disabledReason(session) : "Enter to send · Shift+Enter for a new line";
    this.#updateDisabled();
  }

  focus(): void {
    if (this.textarea.disabled) return;
    this.textarea.focus();
    this.textarea.setSelectionRange(this.textarea.value.length, this.textarea.value.length);
  }

  blur(): void {
    this.textarea.blur();
  }

  isFocused(): boolean {
    return this.textarea.matches(":focus");
  }

  async submit(): Promise<void> {
    const session = this.#session;
    const text = this.textarea.value.trim();
    if (!session?.controllable || !text || this.#sending) return;
    this.#sending = true;
    this.textarea.value = "";
    this.#resize();
    this.#updateCounter();
    this.#updateDisabled();
    try {
      await this.#send(session.sessionId, text);
    } catch (error) {
      if (!this.textarea.value) this.textarea.value = text;
      this.#resize();
      this.#updateCounter();
      this.#toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#sending = false;
      this.#updateDisabled();
    }
  }

  destroy(): void {
    this.textarea.oninput = null;
    this.textarea.onkeydown = null;
    this.#sendButton.onclick = null;
    this.node.remove();
  }

  #resize(): void {
    this.textarea.style.height = "0";
    this.textarea.style.height = `${this.textarea.scrollHeight}px`;
  }

  #updateCounter(): void {
    const count = this.textarea.value.length;
    this.#counter.textContent = `${count} / 2800`;
    this.#counter.classList.toggle("is-warning", count > 2800);
  }

  #updateDisabled(): void {
    this.#sendButton.disabled = !this.#session?.controllable || !this.textarea.value.trim() || this.#sending;
    this.textarea.setAttribute("aria-invalid", String(this.textarea.value.length > 2800));
  }

  #disabledReason(session: SessionView | undefined): string {
    if (!session) return "Select a session to send an instruction";
    if (session.collapsed) return "This thread is closed";
    if (session.status === "offline" || session.status === "disabled") return "This session is offline";
    return "This session cannot accept instructions";
  }
}
