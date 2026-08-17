import {
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUTS,
  SUPPORTED_IMAGE_MIME_TYPES,
} from "../../../src/image-inputs.js";
import type { SupportedImageMimeType } from "../../../src/image-inputs.js";
import type { ImageUpload, SessionView } from "../types.js";
import { element } from "./dom.js";

interface QueuedImage {
  file: File;
  mimeType: SupportedImageMimeType;
  previewUrl: string;
}

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
  #attachButton = element("button", "text-button composer__attach", { type: "button", text: "Add images" });
  #fileInput = element("input", "composer__file-input", {
    type: "file",
    multiple: true,
    accept: SUPPORTED_IMAGE_MIME_TYPES.join(","),
    ariaLabel: "Choose images",
  });
  #previews = element("div", "composer__images", { ariaLabel: "Images to send" });
  #session: SessionView | undefined;
  #images: QueuedImage[] = [];
  #sendText: (sessionId: string, text: string) => Promise<void>;
  #sendImages: (sessionId: string, text: string, images: readonly ImageUpload[]) => Promise<void>;
  #toast: (message: string, error?: boolean) => void;
  #sending = false;

  constructor(
    sendText: (sessionId: string, text: string) => Promise<void>,
    sendImages: (sessionId: string, text: string, images: readonly ImageUpload[]) => Promise<void>,
    toast: (message: string, error?: boolean) => void,
  ) {
    this.#sendText = sendText;
    this.#sendImages = sendImages;
    this.#toast = toast;
    const frame = element("div", "composer__frame");
    const footer = element("div", "composer__footer");
    footer.append(this.#attachButton, this.#reason, this.#counter, this.#sendButton);
    frame.append(this.#previews, this.textarea, footer);
    this.node.append(frame, this.#fileInput);
    this.#previews.hidden = true;

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
    this.textarea.onpaste = (event) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.some((file) => file.type.startsWith("image/"))) return;
      event.preventDefault();
      this.#addFiles(files);
    };
    this.node.ondragover = (event) => {
      if (!Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === "file" && item.type.startsWith("image/"))) return;
      event.preventDefault();
      this.node.classList.add("is-dragging");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    this.node.ondragleave = (event) => {
      if (event.relatedTarget instanceof Node && this.node.contains(event.relatedTarget)) return;
      this.node.classList.remove("is-dragging");
    };
    this.node.ondrop = (event) => {
      this.node.classList.remove("is-dragging");
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.some((file) => file.type.startsWith("image/"))) return;
      event.preventDefault();
      this.#addFiles(files);
    };
    this.#attachButton.onclick = () => this.#fileInput.click();
    this.#fileInput.onchange = () => {
      this.#addFiles(Array.from(this.#fileInput.files ?? []));
      this.#fileInput.value = "";
    };
    this.#previews.onclick = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const remove = target.closest<HTMLButtonElement>("[data-remove-image]");
      if (!remove) return;
      const index = Number(remove.dataset.removeImage);
      const image = this.#images[index];
      if (!image) return;
      URL.revokeObjectURL(image.previewUrl);
      this.#images.splice(index, 1);
      this.#renderImages();
      this.#updateDisabled();
    };
    this.#sendButton.onclick = () => void this.submit();
  }

  update(session: SessionView | undefined): void {
    if (this.#session?.sessionId !== session?.sessionId && this.#images.length > 0) this.#clearImages();
    this.#session = session;
    const disabled = !session?.controllable;
    this.textarea.disabled = disabled || this.#sending;
    this.#attachButton.disabled = disabled || this.#sending;
    this.textarea.placeholder = disabled ? this.#disabledReason(session) : "Send an instruction…";
    this.#reason.textContent = disabled
      ? this.#disabledReason(session)
      : "Enter to send · Drop or paste images · Shift+Enter for a new line";
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
    if (!session?.controllable || (!text && this.#images.length === 0) || this.#sending) return;
    this.#sending = true;
    this.#updateDisabled();

    if (this.#images.length === 0) {
      this.textarea.value = "";
      this.#resize();
      this.#updateCounter();
      try {
        await this.#sendText(session.sessionId, text);
      } catch (error) {
        if (!this.textarea.value) this.textarea.value = text;
        this.#resize();
        this.#updateCounter();
        this.#toast(error instanceof Error ? error.message : String(error), true);
      } finally {
        this.#sending = false;
        this.#updateDisabled();
      }
      return;
    }

    try {
      const images = await Promise.all(this.#images.map(async ({ file, mimeType }) => ({
        name: file.name || `image-${Date.now()}`,
        mimeType,
        bytes: await file.arrayBuffer(),
      })));
      await this.#sendImages(session.sessionId, text, images);
      this.textarea.value = "";
      this.#clearImages();
      this.#resize();
      this.#updateCounter();
    } catch (error) {
      this.#toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#sending = false;
      this.#updateDisabled();
    }
  }

  destroy(): void {
    this.textarea.oninput = null;
    this.textarea.onkeydown = null;
    this.textarea.onpaste = null;
    this.node.ondragover = null;
    this.node.ondragleave = null;
    this.node.ondrop = null;
    this.#attachButton.onclick = null;
    this.#fileInput.onchange = null;
    this.#previews.onclick = null;
    this.#sendButton.onclick = null;
    this.#clearImages();
    this.node.remove();
  }

  #addFiles(files: readonly File[]): void {
    if (!this.#session?.controllable || this.#sending) return;
    let totalBytes = this.#images.reduce((sum, image) => sum + image.file.size, 0);
    let rejected = "";
    for (const file of files) {
      const mimeType = SUPPORTED_IMAGE_MIME_TYPES.find((type) => type === file.type);
      if (!mimeType) {
        rejected = "Use PNG, JPEG, GIF, or WebP images.";
        continue;
      }
      if (this.#images.length >= MAX_IMAGE_INPUTS) {
        rejected = `You can attach up to ${MAX_IMAGE_INPUTS} images.`;
        break;
      }
      if (totalBytes + file.size > MAX_IMAGE_INPUT_BYTES) {
        rejected = "Images can total up to 20 MB.";
        continue;
      }
      totalBytes += file.size;
      this.#images.push({ file, mimeType, previewUrl: URL.createObjectURL(file) });
    }
    if (rejected) this.#toast(rejected, true);
    this.#renderImages();
    this.#updateDisabled();
  }

  #renderImages(): void {
    const nodes = this.#images.map((image, index) => {
      const card = element("div", "composer-image");
      const preview = element("img", "composer-image__preview", {
        src: image.previewUrl,
        alt: "",
      });
      const size = image.file.size < 1024 * 1024
        ? `${Math.max(1, Math.round(image.file.size / 1024))} KB`
        : `${(image.file.size / (1024 * 1024)).toFixed(1)} MB`;
      const copy = element("span", "composer-image__copy");
      copy.append(
        element("span", "composer-image__name", { text: image.file.name || "Pasted image" }),
        element("span", "composer-image__size", { text: size }),
      );
      card.append(
        preview,
        copy,
        element("button", "icon-button composer-image__remove", {
          type: "button",
          text: "×",
          ariaLabel: `Remove ${image.file.name || "image"}`,
          "data-remove-image": index,
          disabled: this.#sending,
        }),
      );
      return card;
    });
    this.#previews.replaceChildren(...nodes);
    this.#previews.hidden = nodes.length === 0;
  }

  #clearImages(): void {
    for (const image of this.#images) URL.revokeObjectURL(image.previewUrl);
    this.#images = [];
    this.#renderImages();
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
    this.#sendButton.disabled =
      !this.#session?.controllable ||
      (!this.textarea.value.trim() && this.#images.length === 0) ||
      this.#sending;
    this.#attachButton.disabled = !this.#session?.controllable || this.#sending;
    this.textarea.disabled = !this.#session?.controllable || this.#sending;
    this.textarea.setAttribute("aria-invalid", String(this.textarea.value.length > 2800));
    this.#renderImages();
  }

  #disabledReason(session: SessionView | undefined): string {
    if (!session) return "Select a session to send an instruction";
    if (session.collapsed) return "This thread is closed";
    if (session.status === "offline" || session.status === "disabled") return "This session is offline";
    return "This session cannot accept instructions";
  }
}
