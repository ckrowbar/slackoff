import type { PendingQuestion, SessionView, ThreadEvent, ThreadState } from "../types.js";
import { element, replaceChildren } from "./dom.js";

interface CachedEvent {
  node: HTMLElement;
  signature: string;
}

const INLINE_PATTERN =
  /(`[^`\n]+`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*|https?:\/\/[^\s<]+)/g;

function appendInline(parent: HTMLElement, text: string, allowLinks = true): void {
  let offset = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > offset) parent.append(document.createTextNode(text.slice(offset, index)));
    const token = match[0];
    if (token.startsWith("`")) {
      parent.append(element("code", "inline-code", { text: token.slice(1, -1) }));
    } else if (match[2] !== undefined && allowLinks) {
      const link = element("a", "transcript-link", {
        href: match[3] ?? "",
        target: "_blank",
        rel: "noreferrer noopener",
      });
      appendInline(link, match[2], false);
      parent.append(link);
    } else if (match[4] !== undefined) {
      const strong = element("strong", "markdown-strong");
      appendInline(strong, match[4]);
      parent.append(strong);
    } else if (match[5] !== undefined) {
      const deleted = element("del", "markdown-deleted");
      appendInline(deleted, match[5]);
      parent.append(deleted);
    } else if (match[6] !== undefined) {
      const emphasis = element("em", "markdown-emphasis");
      appendInline(emphasis, match[6]);
      parent.append(emphasis);
    } else if (match[2] !== undefined) {
      parent.append(document.createTextNode(token));
    } else if (allowLinks) {
      appendBareLink(parent, token);
    } else {
      parent.append(document.createTextNode(token));
    }
    offset = index + token.length;
  }
  if (offset < text.length) parent.append(document.createTextNode(text.slice(offset)));
}

function appendBareLink(parent: HTMLElement, token: string): void {
  let href = token;
  let suffix = "";
  while (/[),.;!?]$/.test(href)) {
    suffix = href.slice(-1) + suffix;
    href = href.slice(0, -1);
  }
  parent.append(element("a", "transcript-link", {
    href,
    target: "_blank",
    rel: "noreferrer noopener",
    text: href,
  }));
  if (suffix) parent.append(document.createTextNode(suffix));
}

function codeBlock(language: string, source: string): HTMLElement {
  const block = element("div", "code-block");
  const bar = element("div", "code-block__bar");
  const copy = element("button", "code-block__copy", {
    type: "button",
    text: "Copy",
    ariaLabel: `Copy ${language} code`,
  });
  copy.dataset.copy = source;
  const pre = element("pre", "code-block__pre");
  pre.append(element("code", "code-block__code", { text: source }));
  bar.append(element("span", "code-block__language", { text: language }), copy);
  block.append(bar, pre);
  return block;
}

function appendParagraph(parent: HTMLElement, lines: readonly string[]): void {
  const paragraph = element("p", "markdown-paragraph");
  lines.forEach((line, index) => {
    if (index > 0) paragraph.append(document.createElement("br"));
    appendInline(paragraph, line);
  });
  parent.append(paragraph);
}

function appendRichText(parent: HTMLElement, text: string): void {
  const prose = element("div", "rich-prose");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) appendParagraph(prose, paragraph);
    paragraph = [];
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    const fence = /^ {0,3}```\s*([^`]*)$/.exec(line);
    if (fence) {
      flushParagraph();
      const source: string[] = [];
      index += 1;
      while (index < lines.length && !/^ {0,3}```\s*$/.test(lines[index] ?? "")) {
        source.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      prose.append(codeBlock(fence[1]?.trim() || "code", source.join("\n")));
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const node = document.createElement(`h${heading[1]?.length ?? 1}`);
      node.className = "markdown-heading";
      appendInline(node, heading[2] ?? "");
      prose.append(node);
      index += 1;
      continue;
    }

    if (/^ {0,3}>\s?/.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length && /^ {0,3}>\s?/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^ {0,3}>\s?/, ""));
        index += 1;
      }
      const quote = element("blockquote", "markdown-blockquote");
      appendParagraph(quote, quoted);
      prose.append(quote);
      continue;
    }

    const item = /^ {0,3}([-+*]|\d+\.)\s+(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = /\d+\./.test(item[1] ?? "");
      const list = document.createElement(ordered ? "ol" : "ul");
      list.className = "markdown-list";
      while (index < lines.length) {
        const next = /^ {0,3}([-+*]|\d+\.)\s+(.+)$/.exec(lines[index] ?? "");
        if (!next || /\d+\./.test(next[1] ?? "") !== ordered) break;
        const listItem = document.createElement("li");
        appendInline(listItem, next[2] ?? "");
        list.append(listItem);
        index += 1;
      }
      prose.append(list);
      continue;
    }

    if (/^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      flushParagraph();
      prose.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  parent.append(prose);
}

export class TranscriptView {
  readonly node = element("div", "transcript", { role: "log", ariaLabel: "Session transcript" });
  #events = new Map<string, CachedEvent>();
  #eventTexts = new Map<string, string>();
  #stream = element("div", "transcript__stream");
  #questionHost = element("div", "transcript__question-host");
  #empty = element("div", "transcript__empty");
  #session: SessionView | undefined;
  #questionId: string | undefined;
  #selectedAnswers = new Set<number>();
  #freeAnswer = "";
  #answer: (sessionId: string, answers: readonly string[]) => Promise<void>;
  #retry: (sessionId: string, text: string) => Promise<void>;
  #toast: (message: string, error?: boolean) => void;
  #timers = new Set<number>();

  constructor(
    answer: (sessionId: string, answers: readonly string[]) => Promise<void>,
    retry: (sessionId: string, text: string) => Promise<void>,
    toast: (message: string, error?: boolean) => void,
  ) {
    this.#answer = answer;
    this.#retry = retry;
    this.#toast = toast;
    this.node.append(this.#stream, this.#questionHost, this.#empty);
    this.node.onclick = (event) => this.#handleClick(event);
    this.node.oninput = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.classList.contains("question-card__free")) return;
      this.#freeAnswer = target.value;
      this.#updateSubmitState();
    };
  }

  update(session: SessionView | undefined, thread: ThreadState | undefined, forceBottom = false): void {
    const wasNearBottom = this.node.scrollHeight - this.node.scrollTop - this.node.clientHeight < 80;
    const sessionChanged = this.#session?.sessionId !== session?.sessionId;
    this.#session = session;
    const events = thread && thread.sessionId === session?.sessionId
      ? thread.events.filter((event) => !session.pendingQuestion || event.question?.questionId !== session.pendingQuestion.questionId)
      : [];
    const live = new Set(events.map((event) => event.ts));
    for (const [ts, cached] of this.#events) {
      if (live.has(ts)) continue;
      cached.node.remove();
      this.#events.delete(ts);
      this.#eventTexts.delete(ts);
    }
    const nodes = events.map((event) => this.#eventNode(event));
    replaceChildren(this.#stream, nodes);
    this.#renderQuestion(session?.pendingQuestion);

    if (!session) {
      this.#empty.textContent = "Select a session to inspect its work.";
      this.#empty.hidden = false;
    } else if (thread?.loading && events.length === 0) {
      this.#empty.textContent = "Loading transcript…";
      this.#empty.hidden = false;
    } else if (events.length === 0 && !session.pendingQuestion) {
      this.#empty.textContent = "No transcript yet. Send an instruction to begin.";
      this.#empty.hidden = false;
    } else {
      this.#empty.hidden = true;
    }

    if (sessionChanged || forceBottom || wasNearBottom) {
      requestAnimationFrame(() => {
        this.node.scrollTop = this.node.scrollHeight;
      });
    }
  }

  chooseNumber(index: number): boolean {
    const question = this.#session?.pendingQuestion;
    if (!question || index < 0 || index >= question.options.length) return false;
    if (question.multi) {
      if (this.#selectedAnswers.has(index)) this.#selectedAnswers.delete(index);
      else this.#selectedAnswers.add(index);
      this.#syncQuestionSelection();
    } else {
      void this.#submit([question.options[index]?.label ?? ""]);
    }
    return true;
  }

  destroy(): void {
    this.node.onclick = null;
    this.node.oninput = null;
    for (const timer of this.#timers) window.clearTimeout(timer);
    this.#timers.clear();
    this.#events.clear();
    this.#eventTexts.clear();
    this.node.remove();
  }

  #eventNode(event: ThreadEvent): HTMLElement {
    const signature = `${event.kind}\u0000${event.text}\u0000${event.pending ? "p" : ""}\u0000${event.failed ?? ""}`;
    this.#eventTexts.set(event.ts, event.text);
    const cached = this.#events.get(event.ts);
    if (cached?.signature === signature) return cached.node;
    const node = cached?.node ?? element("article", "transcript-event");
    node.className = `transcript-event transcript-event--${event.kind}`;
    node.dataset.ts = event.ts;
    node.replaceChildren();
    if (event.pending) node.classList.add("is-pending");
    if (event.failed) node.classList.add("is-failed");

    if (event.kind === "notice") {
      node.append(element("span", "transcript-event__notice-mark", { text: "—" }));
      appendRichText(node, event.text);
    } else {
      const label = event.kind === "user" ? "You" : event.kind === "assistant" ? "Agent" : event.kind === "question" ? "Question" : event.kind;
      const header = element("header", "transcript-event__header");
      header.append(
        element("span", "transcript-event__label", { text: label }),
        element("time", "transcript-event__time", { text: new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }),
      );
      const body = element("div", "transcript-event__body");
      appendRichText(body, event.text);
      node.append(header, body);
      if (event.pending) node.append(element("span", "transcript-event__state", { text: "Sending…" }));
      if (event.failed) {
        const failure = element("div", "transcript-event__failure");
        failure.append(
          element("span", "transcript-event__error", { text: event.failed }),
          element("button", "text-button", { type: "button", text: "Retry", "data-retry": event.ts }),
        );
        node.append(failure);
      }
    }
    this.#events.set(event.ts, { node, signature });
    return node;
  }

  #renderQuestion(question: PendingQuestion | undefined): void {
    if (!question) {
      this.#questionId = undefined;
      this.#selectedAnswers.clear();
      this.#freeAnswer = "";
      this.#questionHost.replaceChildren();
      return;
    }
    if (this.#questionId === question.questionId && this.#questionHost.childElementCount > 0) return;
    this.#questionId = question.questionId;
    this.#selectedAnswers.clear();
    this.#freeAnswer = "";

    const card = element("section", "question-card", { ariaLabel: "Question from the agent" });
    const eyebrow = element("div", "question-card__eyebrow", { text: question.multi ? "INPUT NEEDED · SELECT ALL THAT APPLY" : "INPUT NEEDED · CHOOSE ONE" });
    const prompt = element("h2", "question-card__prompt", { text: question.prompt });
    const options = element("div", "question-card__options", { role: question.multi ? "group" : "radiogroup" });
    question.options.forEach((option, index) => {
      const row = element("button", "question-option", { type: "button", "data-option": index, role: question.multi ? "checkbox" : "radio", "aria-checked": "false" });
      const key = element("kbd", "question-option__key", { text: String(index + 1) });
      const check = element("span", "question-option__check", { text: question.multi ? "□" : "○" });
      const copy = element("span", "question-option__copy");
      copy.append(element("strong", "question-option__label", { text: option.label }));
      if (option.description) copy.append(element("span", "question-option__description", { text: option.description }));
      row.append(key, check, copy);
      options.append(row);
    });
    const freeLabel = element("label", "question-card__free-label");
    freeLabel.append(
      element("span", "question-card__free-caption", { text: "Or write another answer" }),
      element("input", "question-card__free", { type: "text", placeholder: "Type a custom response…", autocomplete: "off" }),
    );
    const footer = element("div", "question-card__footer");
    footer.append(
      element("span", "question-card__hint", { text: question.multi ? "Number keys toggle choices" : "Press a number to answer instantly" }),
      element("button", "primary-button question-card__submit", { type: "button", text: "Submit", "data-submit-question": true, disabled: true }),
    );
    card.append(eyebrow, prompt, options, freeLabel, footer);
    this.#questionHost.replaceChildren(card);
  }

  #handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const copy = target.closest<HTMLButtonElement>("[data-copy]");
    if (copy) {
      const value = copy.dataset.copy ?? "";
      void navigator.clipboard.writeText(value).then(() => {
        copy.textContent = "Copied";
        const timer = window.setTimeout(() => {
          this.#timers.delete(timer);
          if (copy.isConnected) copy.textContent = "Copy";
        }, 1200);
        this.#timers.add(timer);
      }).catch(() => this.#toast("Could not copy code", true));
      return;
    }
    const retry = target.closest<HTMLButtonElement>("[data-retry]");
    if (retry && this.#session) {
      const eventText = this.#eventTexts.get(retry.dataset.retry ?? "");
      if (!eventText) return;
      void this.#retry(this.#session.sessionId, eventText).catch((error: unknown) => this.#toast(String(error), true));
      return;
    }
    const option = target.closest<HTMLButtonElement>("[data-option]");
    if (option) {
      const index = Number(option.dataset.option);
      const question = this.#session?.pendingQuestion;
      if (!question || !Number.isInteger(index)) return;
      if (question.multi) {
        if (this.#selectedAnswers.has(index)) this.#selectedAnswers.delete(index);
        else this.#selectedAnswers.add(index);
      } else {
        this.#selectedAnswers.clear();
        this.#selectedAnswers.add(index);
      }
      this.#syncQuestionSelection();
      return;
    }
    if (target.closest("[data-submit-question]")) void this.#submitCurrent();
  }

  #syncQuestionSelection(): void {
    const question = this.#session?.pendingQuestion;
    if (!question) return;
    this.#questionHost.querySelectorAll<HTMLButtonElement>("[data-option]").forEach((row) => {
      const selected = this.#selectedAnswers.has(Number(row.dataset.option));
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-checked", String(selected));
      const check = row.querySelector<HTMLElement>(".question-option__check");
      if (check) check.textContent = question.multi ? (selected ? "☑" : "□") : (selected ? "●" : "○");
    });
    this.#updateSubmitState();
  }

  #updateSubmitState(): void {
    const submit = this.#questionHost.querySelector<HTMLButtonElement>("[data-submit-question]");
    if (submit) submit.disabled = this.#selectedAnswers.size === 0 && this.#freeAnswer.trim().length === 0;
  }

  async #submitCurrent(): Promise<void> {
    const question = this.#session?.pendingQuestion;
    if (!question) return;
    const custom = this.#freeAnswer.trim();
    const answers = custom ? [custom] : [...this.#selectedAnswers].sort((a, b) => a - b).map((index) => question.options[index]?.label ?? "").filter(Boolean);
    if (answers.length === 0) return;
    await this.#submit(answers);
  }

  async #submit(answers: readonly string[]): Promise<void> {
    const session = this.#session;
    if (!session) return;
    const submit = this.#questionHost.querySelector<HTMLButtonElement>("[data-submit-question]");
    if (submit) submit.disabled = true;
    try {
      await this.#answer(session.sessionId, answers);
    } catch (error) {
      this.#toast(error instanceof Error ? error.message : String(error), true);
      if (submit) submit.disabled = false;
    }
  }
}
